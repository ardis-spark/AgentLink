import { randomUUID } from 'node:crypto';
import type {
  ArenaResponseRequest,
  ClaimDispatchRequest,
  ClaimDispatchResponse,
  CreateProjectRequest,
  DispatchFailureRequest,
  NoResponseRequest,
  ProjectListResponse,
  ProjectResponse,
  RelayReportRequest,
  RelayWorkResponse,
  ResetDispatchRequest,
  SessionAction,
  UpdateProjectRequest,
} from '../../shared/api.js';
import { arenaRef } from '../../shared/arenaPrompt.js';
import { cleanList, excerpt } from '../../shared/text.js';
import type { ArenaCompletion, ArenaTask, Blocker, CompanionSettings, ConversationEntry, Project, RelayLink, RelayPhase, TurnState } from '../../shared/types.js';
import { buildContinuePrompt, buildEvaluationPrompt, buildKickoffPrompt, buildNoResponsePrompt } from '../coordinator/context.js';
import type { Coordinator, TurnInput, TurnOutcome } from '../coordinator/coordinator.js';
import type { GeminiService } from '../gemini/geminiService.js';
import type { Logger } from '../logger.js';
import {
  addEntry,
  addEvent,
  blockSession,
  createProject,
  findTask,
  isOpenTask,
  nowIso,
  openTask,
  syncCurrentTask,
  taskPrompt,
  toProjectView,
  touch,
  upgradeProject,
} from '../memory/projectModel.js';
import type { ProjectStore } from '../memory/projectStore.js';
import type { EventBus } from './eventBus.js';

/** A rule violation or bad request, mapped to an HTTP status by the server. */
export class OrchestratorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 409,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export interface OrchestratorDeps {
  store: ProjectStore;
  gemini: GeminiService;
  coordinator: Coordinator;
  getSettings: () => CompanionSettings;
  /** Removes secrets from text before it is stored or forwarded. */
  scrub: (text: string) => string;
  bus: EventBus;
  logger: Logger;
  /** Waits before a failed coordinator turn is repeated, one per retry. Shortened in tests. */
  retryDelaysMs?: readonly number[];
  /** How long the browser extension may stay silent before it counts as out of contact. */
  relayOfflineMs?: number;
}

interface QueuedTurn {
  input: TurnInput;
  /** Resolves when the turn has finished (or was skipped). */
  done: Promise<void>;
}

type AbortReason = 'pause' | 'stop' | 'cancel_task' | 'delete' | 'shutdown';
type AdvanceReason = 'idle' | 'failure' | 'resume';

interface ProjectRuntime {
  chain: Promise<void>;
  queued: number;
  controller: AbortController | null;
  /** Why the running turn was aborted, so the aftermath can be handled correctly. */
  abortReason: AbortReason | null;
  turn: TurnState;
  /** Coordinator turns in a row that failed because Gemini could not be used. */
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_MESSAGE_CHARS = 100_000;
const MAX_STORED_RESPONSE_CHARS = 1_000_000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000, 180_000];
const MAX_RETRY_DELAY_MS = 10 * 60_000;
/** Evaluation turns that may end without a verdict before the user is told. */
const MAX_EVALUATION_ATTEMPTS = 3;
/** Reminders the coordinator gets when it ends a turn with nothing in motion. */
const MAX_IDLE_TURNS = 2;
/** Times one task may be typed into Arena before the user is told. */
const MAX_DISPATCH_ATTEMPTS = 5;
/** Tasks in a row that Arena may leave unanswered before the user is told. */
const MAX_UNANSWERED_TASKS = 3;
const DEFAULT_RELAY_OFFLINE_MS = 45_000;
/** Gemini failures that repeating the request cannot fix. */
const FATAL_GEMINI_ERRORS: readonly string[] = ['no_key', 'invalid_key', 'permission_denied', 'model_not_found'];
const RELAY_PHASES: readonly RelayPhase[] = ['waiting_for_arena', 'sending', 'verifying', 'submitted', 'generating', 'settling', 'delivering', 'delivered', 'searching', 'stalled'];
const RELAY_TASK_STATUSES: readonly ArenaTask['status'][] = ['queued', 'dispatching', 'awaiting_response'];

function idleTurn(projectId: string): TurnState {
  return { projectId, active: false, entryId: null, kind: null, phase: 'idle', startedAt: null, retry: null };
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OrchestratorError('invalid_request', `"${field}" must be a non-empty string.`, 400);
  }
  if (value.length > max) {
    throw new OrchestratorError('invalid_request', `"${field}" is too long (limit ${max.toLocaleString('en-US')} characters).`, 400);
  }
  return value.trim();
}

/**
 * The autonomous coordination loop.
 *
 * The user states an objective; from then on Gemini plans, Arena executes and
 * AgentLink keeps the two in motion without anyone approving or forwarding
 * anything. This class owns the rules that make that safe and reliable:
 *
 *  - after every step something is in motion: a task on its way to Arena, an
 *    evaluation, a coordinator turn or a scheduled retry. If nothing is, the
 *    coordinator is prompted again (`advance`);
 *  - a task is handed out for delivery exactly once per attempt (claim →
 *    confirm), and is re-sent only after it was established that Arena did
 *    not receive it;
 *  - a task is only ever evaluated against a reply that was actually read
 *    from Arena. A task without a reply is closed as "no reply", never as done;
 *  - failures are retried with back-off. When AgentLink cannot continue on
 *    its own, the session becomes `blocked` with a stated reason — it never
 *    stops silently;
 *  - every automatic step is bounded (tool rounds, retries, tasks per
 *    session), and pause/stop abort whatever is in flight.
 */
export class Orchestrator {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private relaySeenAt: number | null = null;
  private relayOnline = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Set on shutdown: from then on nothing is started and nothing more is written. */
  private disposed = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  // ------------------------------------------------------------ plumbing ---

  private runtime(projectId: string): ProjectRuntime {
    let runtime = this.runtimes.get(projectId);
    if (!runtime) {
      runtime = { chain: Promise.resolve(), queued: 0, controller: null, abortReason: null, turn: idleTurn(projectId), failures: 0, retryTimer: null };
      this.runtimes.set(projectId, runtime);
    }
    return runtime;
  }

  private requireProject(projectId: string): Project {
    const project = this.deps.store.get(projectId);
    if (!project) throw new OrchestratorError('project_not_found', `Project "${projectId}" does not exist.`, 404);
    return project;
  }

  private requireTask(project: Project, taskId: string): ArenaTask {
    const task = findTask(project, taskId);
    if (!task) throw new OrchestratorError('task_not_found', `Task "${taskId}" does not exist in this project.`, 404);
    return task;
  }

  private requireRunning(project: Project, action: string): void {
    const status = project.session.status;
    if (status === 'running') return;
    const hint: Record<string, string> = {
      idle: 'The session has not been started.',
      paused: 'The session is paused. Resume it first.',
      blocked: 'The session is waiting for the user.',
      stopped: 'The session is stopped. Start a new session first.',
      completed: 'The objective is marked complete. Start a new session first.',
    };
    throw new OrchestratorError('session_not_running', `Cannot ${action}: ${hint[status] ?? 'the session is not running.'}`);
  }

  private requireGemini(): void {
    if (this.deps.gemini.status().state === 'no_key') {
      throw new OrchestratorError('gemini_not_configured', 'No Gemini API key is configured. Open the companion settings to add one.');
    }
  }

  private persist(project: Project): void {
    if (this.disposed) return;
    touch(project);
    this.deps.store.save(project);
    this.deps.bus.emit({ type: 'project', projectId: project.id, project: toProjectView(project) });
  }

  private emitProjects(): void {
    this.deps.bus.emit({ type: 'projects', projects: this.deps.store.list(), activeProjectId: this.deps.store.getActiveId() });
  }

  private emitEntry(project: Project, entry: ConversationEntry): void {
    this.deps.bus.emit({ type: 'entry', projectId: project.id, entry });
  }

  /** A line from AgentLink itself in the conversation, so nothing important happens only in a side panel. */
  private notice(project: Project, text: string, taskId: string | null = null): void {
    const entry = addEntry(project, 'system', 'notice', text, { taskId });
    this.emitEntry(project, entry);
  }

  private setTurn(projectId: string, patch: Partial<TurnState>): void {
    const runtime = this.runtime(projectId);
    runtime.turn = { ...runtime.turn, ...patch };
    this.deps.bus.emit({ type: 'turn', projectId, turn: runtime.turn });
  }

  private isBusy(projectId: string): boolean {
    const runtime = this.runtime(projectId);
    return runtime.turn.active || runtime.queued > 0;
  }

  private abortTurn(projectId: string, reason: AbortReason): void {
    const runtime = this.runtime(projectId);
    if (runtime.controller) {
      runtime.abortReason = reason;
      runtime.controller.abort();
    }
  }

  private clearRetry(projectId: string): void {
    const runtime = this.runtime(projectId);
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
  }

  /** Resolves once no coordinator turn is running or queued for the project. */
  async whenIdle(projectId: string): Promise<void> {
    const runtime = this.runtime(projectId);
    let chain: Promise<void>;
    do {
      chain = runtime.chain;
      await chain;
    } while (chain !== runtime.chain);
  }

  /** Stops timers. Called when the companion shuts down. */
  dispose(): void {
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const runtime of this.runtimes.values()) {
      if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
      runtime.retryTimer = null;
      // A request to Gemini that is still open is dropped. What it had produced so far is already on disk,
      // and the next start repairs the cut-off turn and carries on from there.
      runtime.abortReason = 'shutdown';
      runtime.controller?.abort();
    }
  }

  // ------------------------------------------------------ turn execution ---

  private enqueueTurn(project: Project, input: TurnInput): QueuedTurn {
    const runtime = this.runtime(project.id);
    runtime.queued += 1;
    const done = runtime.chain.then(async () => {
      runtime.queued -= 1;
      if (this.disposed) return;
      try {
        await this.executeTurn(project.id, input);
      } catch (error) {
        this.deps.logger.error('Coordinator turn crashed:', error);
        this.setTurn(project.id, idleTurn(project.id));
        const current = this.deps.store.get(project.id);
        if (current && current.session.status === 'running') {
          this.block(current, {
            kind: 'coordinator',
            title: 'AgentLink hit an internal error',
            detail: `A coordinator turn crashed: ${error instanceof Error ? error.message : String(error)}. Continue the session to try again.`,
            options: [],
            taskId: input.taskId,
          });
        }
      }
    });
    runtime.chain = done;
    return { input, done };
  }

  private async executeTurn(projectId: string, input: TurnInput): Promise<void> {
    const project = this.deps.store.get(projectId);
    if (!project) return;
    // The session may have been paused, blocked or stopped while this turn waited in the queue.
    if (project.session.status !== 'running') {
      if (input.kind === 'user') {
        // The message is kept so the coordinator still gets it when the session runs again.
        project.pendingNotices.push(`While the session was not running, the user wrote: "${excerpt(input.text, 4000)}"`);
        this.deps.store.save(project);
      }
      return;
    }
    if (input.kind === 'evaluation') {
      const task = input.taskId ? findTask(project, input.taskId) : null;
      if (!task || task.status !== 'evaluating' || task.evaluation) return;
    }
    if (input.kind === 'continue' && !input.taskId && (openTask(project) || project.status === 'complete')) {
      // Something got going while this reminder waited; it is no longer needed.
      return;
    }

    const runtime = this.runtime(projectId);
    const controller = new AbortController();
    runtime.controller = controller;
    runtime.abortReason = null;

    // Deliver anything that happened outside the conversation along with this turn.
    let text = input.text;
    if (project.pendingNotices.length > 0) {
      const notices = project.pendingNotices.map((n) => `[AgentLink] ${n}`).join('\n\n');
      text = `${notices}\n\n${text}`;
      project.pendingNotices = [];
    }

    this.setTurn(projectId, { active: true, kind: input.kind, phase: 'waiting', startedAt: nowIso(), retry: null, entryId: null });

    const outcome = await this.deps.coordinator.runTurn(
      project,
      { ...input, text },
      {
        save: () => {
          if (!this.disposed) this.deps.store.save(project);
        },
        onEntry: (entry) => {
          if (runtime.turn.entryId !== entry.id) this.setTurn(projectId, { entryId: entry.id });
          this.emitEntry(project, entry);
        },
        onDelta: (entryId, delta) => this.deps.bus.emit({ type: 'delta', projectId, entryId, text: delta }),
        onPhase: (phase, retry) => {
          if (phase === 'idle') return;
          if (runtime.turn.phase !== phase || retry) this.setTurn(projectId, { phase, retry: retry ?? null });
        },
        onProjectChanged: () => this.deps.bus.emit({ type: 'project', projectId, project: toProjectView(project) }),
      },
      controller.signal,
    );

    const abortReason = runtime.abortReason;
    runtime.controller = null;
    runtime.abortReason = null;
    if (this.disposed) return;

    this.settleTurn(project, input, outcome, abortReason);
    this.persist(project);
    this.setTurn(projectId, idleTurn(projectId));
    this.emitProjects();
    // The project must never be left standing: whatever this turn did, decide what moves next.
    if (!runtime.retryTimer) this.advance(project);
  }

  /** Works out what a finished turn means for the session: success, a retry, or a blocker. */
  private settleTurn(project: Project, input: TurnInput, outcome: TurnOutcome, abortReason: AbortReason | null): void {
    const runtime = this.runtime(project.id);
    const task = input.kind === 'evaluation' && input.taskId ? findTask(project, input.taskId) : null;
    const unevaluated = task && task.status === 'evaluating' && !task.evaluation ? task : null;

    if (outcome.status === 'interrupted') {
      // Paused, stopped, or the task was cancelled. Whatever is pending is picked up when the session runs again.
      if (unevaluated) unevaluated.evaluationError = null;
      void abortReason;
      return;
    }

    if (outcome.status === 'error' && outcome.error) {
      const error = outcome.error;
      if (unevaluated) unevaluated.evaluationError = error.message;
      if (project.session.status !== 'running') return;
      runtime.failures += 1;
      const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
      const fatal = FATAL_GEMINI_ERRORS.includes(error.kind);
      if (fatal || runtime.failures > delays.length) {
        const attempts = runtime.failures;
        runtime.failures = 0;
        this.block(project, {
          kind: 'gemini',
          title: fatal ? 'Gemini cannot be used' : 'Gemini keeps failing',
          detail: fatal
            ? `${error.message} Fix this in the companion settings, then continue the session. Nothing was lost; AgentLink picks up exactly where it stopped.`
            : `The request to Gemini failed ${attempts} times in a row (last error: ${error.message}). Continue the session to try again; AgentLink picks up exactly where it stopped.`,
          options: [],
          taskId: input.taskId,
        });
        return;
      }
      const base = delays[runtime.failures - 1] ?? 0;
      const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(base, error.retryAfterMs ?? 0));
      addEvent(
        project,
        'gemini',
        'warning',
        `Gemini request failed; retrying in ${Math.max(1, Math.round(delay / 1000))}s`,
        `Attempt ${runtime.failures} of ${delays.length}. ${error.message}`,
        input.taskId,
      );
      this.scheduleRetry(project.id, delay);
      return;
    }

    runtime.failures = 0;
    if (unevaluated) {
      unevaluated.evaluationAttempts += 1;
      unevaluated.evaluationError = 'Gemini replied without recording a verdict for this task.';
      addEvent(project, 'evaluation', 'warning', `Evaluation of ${unevaluated.id} produced no verdict`, `Attempt ${unevaluated.evaluationAttempts} of ${MAX_EVALUATION_ATTEMPTS}.`, unevaluated.id);
      if (unevaluated.evaluationAttempts >= MAX_EVALUATION_ATTEMPTS && project.session.status === 'running') {
        this.block(project, {
          kind: 'coordinator',
          title: `Gemini did not evaluate ${unevaluated.id}`,
          detail: `Arena's reply to ${unevaluated.id} is stored, but Gemini ended ${unevaluated.evaluationAttempts} evaluation turns without recording a verdict. Continue the session to try again, or tell the coordinator how to proceed.`,
          options: [],
          taskId: unevaluated.id,
        });
      }
    }
  }

  private scheduleRetry(projectId: string, delayMs: number): void {
    const runtime = this.runtime(projectId);
    this.clearRetry(projectId);
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = null;
      const project = this.deps.store.get(projectId);
      if (project) this.advance(project, 'failure');
    }, delayMs);
    runtime.retryTimer.unref?.();
  }

  private scheduleEvaluation(project: Project, task: ArenaTask): void {
    const settings = this.deps.getSettings();
    this.enqueueTurn(project, { kind: 'evaluation', text: buildEvaluationPrompt(task, settings), taskId: task.id });
  }

  /**
   * Keeps a running session moving. Called whenever something finished: if
   * nothing is in motion any more, the next step is started here.
   */
  private advance(project: Project, reason: AdvanceReason = 'idle'): void {
    if (this.disposed || project.session.status !== 'running') return;
    const runtime = this.runtime(project.id);
    // A turn that is running or queued calls this again when it ends; a pending retry does the same.
    if (this.isBusy(project.id) || runtime.retryTimer) return;

    const pending = project.tasks.find((t) => t.status === 'evaluating' && !t.evaluation) ?? null;
    if (pending) {
      this.scheduleEvaluation(project, pending);
      return;
    }
    // A task that is queued or with Arena is in the browser extension's hands; it reports back.
    if (openTask(project)) return;
    if (project.status === 'complete') return;

    if (reason === 'idle') {
      if (project.session.idleTurns >= MAX_IDLE_TURNS) {
        const last = [...project.conversation].reverse().find((e) => e.role === 'coordinator' && e.text.trim());
        this.block(project, {
          kind: 'coordinator',
          title: 'Gemini stopped without a next step',
          detail: `Gemini ended ${project.session.idleTurns + 1} turns in a row without sending a task, completing the objective or asking you anything.${last ? ` Its last message: "${excerpt(last.text, 600)}"` : ''} Reply to tell it how to proceed, or continue the session to prompt it again.`,
          options: [],
          taskId: null,
        });
        return;
      }
      project.session.idleTurns += 1;
      this.deps.store.save(project);
    }
    this.enqueueTurn(project, { kind: 'continue', text: buildContinuePrompt(project, reason), taskId: null });
  }

  /** Hands control back to the user with a stated reason. */
  private block(project: Project, blocker: Omit<Blocker, 'at'>): void {
    this.clearRetry(project.id);
    blockSession(project, blocker);
    this.notice(project, `AgentLink is waiting for you — ${blocker.title}. ${blocker.detail}`, blocker.taskId);
    this.persist(project);
    this.emitProjects();
  }

  // ------------------------------------------------------------- recovery ---

  /**
   * Called once at start-up. Brings every project into a consistent state and
   * lets sessions that were running carry on by themselves. Nothing is typed
   * into Arena again unless the page shows that it never arrived.
   */
  recoverAfterRestart(): void {
    const resumed: Project[] = [];
    for (const project of this.deps.store.all()) {
      let changed = upgradeProject(project);

      if (project.activeTurn) {
        const entry = project.conversation.find((e) => e.id === project.activeTurn?.entryId);
        if (entry && entry.status === 'streaming') {
          entry.status = 'interrupted';
          entry.error = 'Interrupted by a restart.';
        }
        const last = project.transcript[project.transcript.length - 1];
        if (last && last.role === 'user') {
          project.transcript.push({ role: 'model', parts: [{ text: entry?.text.trim() ? entry.text : '(The reply was interrupted by a restart.)' }] });
        }
        project.activeTurn = null;
        if (project.session.status === 'running') {
          project.pendingNotices.push('AgentLink was restarted while you were replying; that reply was cut off. PROJECT MEMORY is current.');
        }
        changed = true;
      }
      for (const entry of project.conversation) {
        if (entry.status === 'streaming') {
          entry.status = 'interrupted';
          entry.error = 'Interrupted by a restart.';
          changed = true;
        }
      }

      for (const task of project.tasks) {
        if (task.status === 'dispatching') {
          // The restart happened between handing the prompt out and learning the outcome. It may or may not
          // have reached Arena: the browser extension checks the page and re-sends it only if it is not there.
          task.status = 'awaiting_response';
          if (task.dispatch) {
            task.dispatch.unconfirmed = true;
            task.dispatch.error = 'AgentLink restarted while this task was being sent; delivery is being verified.';
          }
          project.session.tasksDispatched += 1;
          addEvent(project, 'arena', 'warning', `Delivery of ${task.id} is being verified after a restart`, 'AgentLink checks the Arena tab and sends the task again only if it did not arrive.', task.id);
          changed = true;
        }
        if (task.status === 'evaluating' && !task.evaluation && task.evaluationError) {
          task.evaluationError = null;
          changed = true;
        }
      }

      if (project.session.status === 'running') {
        addEvent(project, 'session', 'info', 'Session resumed after a restart', 'AgentLink was restarted and is carrying on where it stopped.');
        resumed.push(project);
        changed = true;
      }

      syncCurrentTask(project);
      if (changed) this.deps.store.save(project);
    }
    // Start moving again only after every project is consistent.
    for (const project of resumed) this.advance(project, 'resume');
  }

  // -------------------------------------------------------------- projects ---

  listProjects(): ProjectListResponse {
    return { projects: this.deps.store.list(), activeProjectId: this.deps.store.getActiveId() };
  }

  getProject(projectId: string): ProjectResponse {
    const project = this.requireProject(projectId);
    return { project: toProjectView(project), conversation: project.conversation, turn: this.runtime(projectId).turn };
  }

  getTask(projectId: string, taskId: string): ArenaTask {
    return this.requireTask(this.requireProject(projectId), taskId);
  }

  /**
   * Creates a project. With `start`, work on the objective begins at once:
   * the session runs and the coordinator gets the objective as its first turn.
   */
  createProject(request: CreateProjectRequest): ProjectResponse {
    const scrub = this.deps.scrub;
    const project = createProject({
      name: scrub(requireText(request.name, 'name', 200)),
      objective: scrub(requireText(request.objective, 'objective', 4000)),
      instructions: typeof request.instructions === 'string' ? scrub(request.instructions.trim().slice(0, 20_000)) : '',
      constraints: cleanList(request.constraints, 40, 600).map(scrub),
    });
    this.deps.store.save(project);
    this.deps.store.setActive(project.id);
    // Without a Gemini key the project is still created; it starts as soon as the user presses Start.
    if (request.start === true && this.deps.gemini.status().state !== 'no_key') {
      this.startSession(project);
      this.deps.store.save(project);
      this.enqueueTurn(project, { kind: 'continue', text: buildKickoffPrompt(project), taskId: null });
    }
    this.emitProjects();
    return this.getProject(project.id);
  }

  updateProject(projectId: string, patch: UpdateProjectRequest): ProjectResponse {
    const project = this.requireProject(projectId);
    const scrub = this.deps.scrub;
    const changes: string[] = [];
    if (patch.name !== undefined) {
      const name = scrub(requireText(patch.name, 'name', 200));
      if (name !== project.name) {
        project.name = name;
        changes.push('name');
      }
    }
    if (patch.objective !== undefined) {
      const objective = scrub(requireText(patch.objective, 'objective', 4000));
      if (objective !== project.objective) {
        project.objective = objective;
        changes.push('objective');
        project.pendingNotices.push(`The user changed the project objective. It is now: ${objective}`);
        addEvent(project, 'project', 'info', 'Objective changed by you', objective);
      }
    }
    if (patch.instructions !== undefined) {
      if (typeof patch.instructions !== 'string') throw new OrchestratorError('invalid_request', '"instructions" must be a string.', 400);
      const instructions = scrub(patch.instructions.trim().slice(0, 20_000));
      if (instructions !== project.instructions) {
        project.instructions = instructions;
        changes.push('instructions');
        project.pendingNotices.push('The user changed the standing project instructions (see PROJECT MEMORY).');
        addEvent(project, 'project', 'info', 'Project instructions changed by you', excerpt(instructions, 300));
      }
    }
    if (patch.constraints !== undefined) {
      const constraints = cleanList(patch.constraints, 40, 600).map(scrub);
      if (JSON.stringify(constraints) !== JSON.stringify(project.constraints)) {
        project.constraints = constraints;
        changes.push('constraints');
        project.pendingNotices.push('The user changed the project constraints (see PROJECT MEMORY).');
        addEvent(project, 'project', 'info', 'Constraints changed by you', constraints.join('\n'));
      }
    }
    if (changes.length > 0) {
      this.persist(project);
      this.emitProjects();
    }
    return this.getProject(projectId);
  }

  deleteProject(projectId: string): void {
    this.requireProject(projectId);
    this.clearRetry(projectId);
    this.abortTurn(projectId, 'delete');
    this.deps.store.delete(projectId);
    this.runtimes.delete(projectId);
    this.emitProjects();
  }

  activateProject(projectId: string): ProjectListResponse {
    this.requireProject(projectId);
    this.deps.store.setActive(projectId);
    this.emitProjects();
    return this.listProjects();
  }

  turnState(projectId: string): TurnState {
    return this.runtime(projectId).turn;
  }

  // ------------------------------------------------------------ conversation ---

  /**
   * The user speaks to the coordinator. Returns as soon as the turn is queued;
   * output arrives over the event stream. Writing never requires the session
   * to be in a particular state except "not paused": a message starts an idle
   * session, answers a blocker, and is queued behind a turn that is running.
   */
  sendMessage(projectId: string, rawText: unknown): { entry: ConversationEntry; done: Promise<void> } {
    const project = this.requireProject(projectId);
    const text = this.deps.scrub(requireText(rawText, 'text', MAX_MESSAGE_CHARS));
    const status = project.session.status;
    if (status === 'paused') this.requireRunning(project, 'send a message');
    this.requireGemini();

    if (status === 'idle' || status === 'stopped' || status === 'completed') {
      this.startSession(project);
    } else if (status === 'blocked') {
      this.unblock(project, 'Your reply');
    }
    project.session.idleTurns = 0;
    this.clearRetry(projectId);
    this.runtime(projectId).failures = 0;

    const entry = addEntry(project, 'user', 'message', text);
    this.persist(project);
    this.emitEntry(project, entry);
    this.emitProjects();
    const queued = this.enqueueTurn(project, { kind: 'user', text, taskId: null });
    return { entry, done: queued.done };
  }

  /**
   * Stops the reply that is being generated. Because a running session would
   * simply start the next step, this pauses the session; resuming continues.
   */
  cancelTurn(projectId: string): { cancelled: boolean } {
    const project = this.requireProject(projectId);
    const active = this.runtime(projectId).controller !== null;
    if (active && project.session.status === 'running') this.controlSession(projectId, 'pause');
    return { cancelled: active };
  }

  // ----------------------------------------------------------------- session ---

  private startSession(project: Project): void {
    const at = nowIso();
    const reopened = project.status === 'complete';
    if (reopened) {
      project.status = 'active';
      project.completion = null;
    }
    project.session = { status: 'running', startedAt: at, updatedAt: at, blocker: null, tasksDispatched: 0, idleTurns: 0, note: null };
    this.runtime(project.id).failures = 0;
    addEvent(project, 'session', 'info', reopened ? 'Session reopened' : 'Session started', 'AgentLink now works on the objective on its own.');
  }

  /** Clears a blocker and lets the session run again. Every automatic limit starts afresh. */
  private unblock(project: Project, by: string): void {
    const blocker = project.session.blocker;
    if (blocker?.kind === 'task_budget') project.session.tasksDispatched = 0;
    project.session.status = 'running';
    project.session.blocker = null;
    project.session.idleTurns = 0;
    project.session.note = null;
    project.session.updatedAt = nowIso();
    this.runtime(project.id).failures = 0;
    for (const task of project.tasks) {
      if (!isOpenTask(task)) continue;
      task.evaluationAttempts = 0;
      task.evaluationError = null;
      if (task.status === 'queued' && task.dispatch) task.dispatch.attempt = 0;
    }
    addEvent(project, 'session', 'info', 'Session continues', blocker ? `${by} cleared: ${blocker.title}` : by);
  }

  controlSession(projectId: string, action: SessionAction): ProjectResponse {
    const project = this.requireProject(projectId);
    const status = project.session.status;
    const invalid = (): never => {
      throw new OrchestratorError('invalid_transition', `Cannot ${action} a session that is ${status}.`);
    };
    let kickoff = false;
    let resumed = false;

    switch (action) {
      case 'start': {
        if (status !== 'idle' && status !== 'stopped' && status !== 'completed') invalid();
        this.requireGemini();
        this.startSession(project);
        kickoff = true;
        break;
      }
      case 'pause': {
        if (status !== 'running') invalid();
        project.session.status = 'paused';
        project.session.note = null;
        project.session.updatedAt = nowIso();
        addEvent(project, 'session', 'info', 'Session paused by you', 'Gemini is idle and nothing is sent to Arena until you resume. A task Arena is already working on keeps running there.');
        this.clearRetry(projectId);
        this.abortTurn(projectId, 'pause');
        break;
      }
      case 'resume': {
        if (status !== 'paused' && status !== 'blocked') invalid();
        if (status === 'blocked') {
          if (project.session.blocker?.kind === 'question') {
            project.pendingNotices.push(
              `The user continued the session without answering your question ("${excerpt(project.session.blocker.title, 300)}"). Decide it yourself as well as you can, record the decision, and carry on.`,
            );
          }
          this.unblock(project, 'You');
        } else {
          project.session.status = 'running';
          project.session.note = null;
          project.session.updatedAt = nowIso();
          addEvent(project, 'session', 'info', 'Session resumed by you');
        }
        resumed = true;
        break;
      }
      case 'stop': {
        if (status !== 'running' && status !== 'paused' && status !== 'blocked') invalid();
        project.session.status = 'stopped';
        project.session.blocker = null;
        project.session.note = null;
        project.session.updatedAt = nowIso();
        const open = openTask(project);
        if (open) {
          const wasSent = open.status === 'awaiting_response' || open.status === 'dispatching' || open.status === 'evaluating';
          open.status = 'cancelled';
          open.closedReason = 'The session was stopped.';
          open.relay = null;
          open.updatedAt = nowIso();
          project.pendingNotices.push(
            `The user stopped the session; task ${open.id} "${open.title}" was cancelled${wasSent ? ' after it had been sent to Arena' : ' before it was sent'}.`,
          );
          addEvent(project, 'task', 'warning', `Task ${open.id} cancelled (session stopped)`, wasSent ? 'It had already been sent to Arena; any later reply is ignored.' : '', open.id);
        }
        syncCurrentTask(project);
        addEvent(project, 'session', 'warning', 'Session stopped by you');
        this.clearRetry(projectId);
        this.abortTurn(projectId, 'stop');
        break;
      }
      default:
        throw new OrchestratorError('invalid_request', `Unknown session action "${String(action)}".`, 400);
    }
    this.persist(project);
    this.emitProjects();
    if (kickoff) this.enqueueTurn(project, { kind: 'continue', text: buildKickoffPrompt(project), taskId: null });
    if (resumed) this.advance(project, 'resume');
    return this.getProject(projectId);
  }

  // ------------------------------------------------------------------- tasks ---

  /** The user abandons the open task. The coordinator is told and decides what to do instead. */
  cancelTask(projectId: string, taskId: string): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (!isOpenTask(task)) {
      throw new OrchestratorError('invalid_state', `Task ${task.id} is already closed (status: ${task.status}).`);
    }
    const previous = task.status;
    task.status = 'cancelled';
    task.closedReason = 'Cancelled by the user.';
    task.relay = null;
    task.updatedAt = nowIso();
    syncCurrentTask(project);
    project.pendingNotices.push(
      `The user cancelled task ${task.id} "${task.title}" (it was ${previous.replace('_', ' ')}). Do not send it again unchanged; choose a different next step, or ask the user what they want if that is unclear.`,
    );
    addEvent(project, 'task', 'warning', `Task ${task.id} cancelled by you`, '', task.id);
    this.persist(project);
    if (previous === 'evaluating' && this.runtime(projectId).turn.kind === 'evaluation') this.abortTurn(projectId, 'cancel_task');
    this.advance(project, 'resume');
    return task;
  }

  // ------------------------------------------------------------------- relay ---

  /** Whether the browser extension that carries tasks to Arena is in contact. */
  relayLink(): RelayLink {
    return { online: this.relayOnline, seenAt: this.relaySeenAt === null ? null : new Date(this.relaySeenAt).toISOString() };
  }

  /** Starts the periodic check that notices when the browser extension goes silent. */
  startWatchdog(intervalMs = 10_000): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkRelay(), intervalMs);
    this.watchdog.unref?.();
  }

  /**
   * Notices when the browser extension stops asking for work. Without it no
   * task reaches Arena and no reply comes back, so this is recorded where the
   * user will see it rather than left as a silent wait.
   */
  checkRelay(now: number = Date.now()): RelayLink {
    const online = this.relaySeenAt !== null && now - this.relaySeenAt <= (this.deps.relayOfflineMs ?? DEFAULT_RELAY_OFFLINE_MS);
    if (online !== this.relayOnline) {
      this.relayOnline = online;
      for (const project of this.deps.store.all()) {
        const task = openTask(project);
        if (project.session.status !== 'running' || !task || !RELAY_TASK_STATUSES.includes(task.status)) continue;
        if (online) {
          addEvent(project, 'arena', 'info', 'Browser extension is back in contact', `Work on ${task.id} continues.`, task.id);
        } else {
          addEvent(
            project,
            'arena',
            'error',
            'Browser extension is out of contact',
            `Nothing can be sent to Arena or read from it for ${task.id} until Firefox is running with the AgentLink extension enabled and paired. Work continues by itself when it is back.`,
            task.id,
          );
        }
        this.persist(project);
      }
      this.deps.bus.emit({ type: 'relay', relay: this.relayLink() });
    }
    return this.relayLink();
  }

  /**
   * What the browser extension has to do right now: tasks to deliver to Arena
   * and tasks whose reply it has to bring back. The extension asks every few
   * seconds, which also serves as its heartbeat.
   */
  relayWork(): RelayWorkResponse {
    this.relaySeenAt = Date.now();
    if (!this.relayOnline) this.checkRelay(this.relaySeenAt);
    const items: RelayWorkResponse['items'] = [];
    for (const project of this.deps.store.all()) {
      const session = project.session.status;
      const task = openTask(project);
      if (!task || !RELAY_TASK_STATUSES.includes(task.status)) continue;
      // Nothing new is typed into Arena unless the session is running. A task Arena already has is followed to
      // its reply even while the session is paused or waiting for the user, so the reply is never missed.
      if (session === 'running' || ((session === 'paused' || session === 'blocked') && task.status !== 'queued')) {
        items.push({ projectId: project.id, projectName: project.name, task });
      }
    }
    return { items };
  }

  /** The extension reports where a task is on its way to Arena and back. */
  reportRelay(projectId: string, taskId: string, request: RelayReportRequest): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (!RELAY_TASK_STATUSES.includes(task.status)) return task;
    if (request.dispatchId && task.dispatch && task.dispatch.dispatchId !== request.dispatchId) return task;
    if (!RELAY_PHASES.includes(request.phase)) throw new OrchestratorError('invalid_request', '"phase" is not a known relay phase.', 400);
    const message = typeof request.message === 'string' ? this.deps.scrub(request.message.trim().slice(0, 600)) : '';
    const attention = request.attention === true;
    const chars = typeof request.chars === 'number' && Number.isFinite(request.chars) ? Math.max(0, Math.round(request.chars)) : 0;
    const previous = task.relay;
    const significant = !previous || previous.phase !== request.phase || previous.attention !== attention || previous.message !== message;
    task.relay = { phase: request.phase, message, attention, chars, dispatchId: task.dispatch?.dispatchId ?? null, updatedAt: nowIso() };
    if (attention && (!previous || !previous.attention || previous.message !== message)) {
      addEvent(project, 'arena', 'warning', `${task.id}: Arena needs attention`, message, task.id);
    } else if (!attention && previous?.attention) {
      addEvent(project, 'arena', 'info', `${task.id}: Arena relay recovered`, message, task.id);
    }
    if (significant) {
      this.persist(project);
    } else {
      // Progress counters change every few seconds; they are shown live but not written to disk each time.
      this.deps.bus.emit({ type: 'project', projectId: project.id, project: toProjectView(project) });
    }
    return task;
  }

  // ---------------------------------------------------------------- dispatch ---

  /**
   * Hands out a queued task for delivery to Arena — exactly once per attempt.
   * The task leaves "queued" atomically, so a second claim (a second browser
   * window, a retry racing the first try) is refused instead of producing a
   * second submission.
   */
  claimDispatch(projectId: string, taskId: string, request: ClaimDispatchRequest = {}): ClaimDispatchResponse {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    this.requireRunning(project, 'send a task to Arena');
    if (task.status !== 'queued') {
      const why = task.status === 'dispatching' || task.status === 'awaiting_response' ? 'it has already been handed to Arena' : `its status is ${task.status}`;
      throw new OrchestratorError('not_dispatchable', `Task ${task.id} cannot be sent: ${why}.`);
    }
    const settings = this.deps.getSettings();
    if (project.session.tasksDispatched >= settings.maxTasksPerSession) {
      const detail = `${project.session.tasksDispatched} tasks were sent to Arena in this session, which is the configured safety limit (${settings.maxTasksPerSession}). Continue the session to carry on, or raise the limit in the companion settings.`;
      this.block(project, { kind: 'task_budget', title: 'Task safety limit reached', detail, options: [], taskId: task.id });
      throw new OrchestratorError('task_budget_reached', detail);
    }
    const attempts = task.dispatch?.attempt ?? 0;
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      const detail = `AgentLink tried ${attempts} times to type ${task.id} into Arena and Arena did not accept it${task.dispatch?.error ? ` (last problem: ${task.dispatch.error})` : ''}. Check the Arena tab, then continue the session to try again.`;
      this.block(project, { kind: 'arena', title: `${task.id} could not be delivered to Arena`, detail, options: [], taskId: task.id });
      throw new OrchestratorError('dispatch_attempts_exhausted', detail);
    }

    const dispatchId = randomUUID();
    const ref = arenaRef(task.id, dispatchId);
    const prompt = this.deps.scrub(taskPrompt(project, task, ref));
    task.dispatch = {
      dispatchId,
      attempt: attempts + 1,
      claimedAt: nowIso(),
      confirmedAt: null,
      tabId: typeof request.tabId === 'number' ? request.tabId : null,
      tabUrl: typeof request.tabUrl === 'string' ? request.tabUrl.slice(0, 2000) : null,
      prompt,
      ref,
      unconfirmed: false,
      error: null,
    };
    task.status = 'dispatching';
    task.updatedAt = nowIso();
    this.persist(project);
    return { dispatchId, prompt, task };
  }

  private requireDispatch(task: ArenaTask, dispatchId: unknown): NonNullable<ArenaTask['dispatch']> {
    if (!task.dispatch || typeof dispatchId !== 'string' || task.dispatch.dispatchId !== dispatchId) {
      throw new OrchestratorError('stale_dispatch', `That delivery attempt no longer belongs to task ${task.id}.`);
    }
    return task.dispatch;
  }

  /** Arena accepted the prompt. Also used when a delivery that was in doubt is found in the Arena page. */
  confirmDispatch(projectId: string, taskId: string, dispatchId: unknown): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    const dispatch = this.requireDispatch(task, dispatchId);
    if (task.status === 'awaiting_response') {
      if (dispatch.unconfirmed) {
        dispatch.unconfirmed = false;
        dispatch.error = null;
        dispatch.confirmedAt = nowIso();
        addEvent(project, 'arena', 'info', `Delivery of ${task.id} confirmed`, 'The task was found in the Arena conversation.', task.id);
        this.persist(project);
      }
      return task;
    }
    if (task.status !== 'dispatching') {
      throw new OrchestratorError('invalid_state', `Task ${task.id} is not being sent (status: ${task.status}).`);
    }
    dispatch.confirmedAt = nowIso();
    task.status = 'awaiting_response';
    task.updatedAt = dispatch.confirmedAt;
    project.session.tasksDispatched += 1;
    addEvent(project, 'arena', 'info', `Task ${task.id} sent to Arena`, dispatch.tabUrl ?? '', task.id);
    this.persist(project);
    return task;
  }

  /** Delivery did not complete normally. */
  failDispatch(projectId: string, taskId: string, request: DispatchFailureRequest): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    const dispatch = this.requireDispatch(task, request.dispatchId);
    if (task.status !== 'dispatching') {
      throw new OrchestratorError('invalid_state', `Task ${task.id} is not being sent (status: ${task.status}).`);
    }
    const message = typeof request.error === 'string' && request.error.trim() ? request.error.trim().slice(0, 1000) : 'Unknown delivery error.';
    dispatch.error = message;
    if (request.submitted === false) {
      // Nothing reached Arena: back to the queue, from where it is sent again.
      task.status = 'queued';
      addEvent(project, 'arena', 'warning', `Task ${task.id} was not sent (attempt ${dispatch.attempt}); trying again`, message, task.id);
    } else {
      // It may have reached Arena. The extension checks the page before anything is sent again.
      task.status = 'awaiting_response';
      dispatch.unconfirmed = true;
      project.session.tasksDispatched += 1;
      addEvent(project, 'arena', 'warning', `Delivery of ${task.id} is being verified`, message, task.id);
    }
    task.updatedAt = nowIso();
    this.persist(project);
    return task;
  }

  /**
   * A delivery that was in doubt turned out not to have reached Arena (the
   * extension looked for the task in the page and it is not there), so the
   * task goes back to the queue and is sent again.
   */
  resetDispatch(projectId: string, taskId: string, request: ResetDispatchRequest): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    const dispatch = this.requireDispatch(task, request?.dispatchId);
    if (task.status !== 'awaiting_response' || !dispatch.unconfirmed) {
      throw new OrchestratorError('invalid_state', `Task ${task.id} has no unconfirmed delivery to reset (status: ${task.status}).`);
    }
    const reason = typeof request.reason === 'string' && request.reason.trim() ? request.reason.trim().slice(0, 600) : 'The task was not found in the Arena tab.';
    task.status = 'queued';
    dispatch.error = reason;
    task.updatedAt = nowIso();
    project.session.tasksDispatched = Math.max(0, project.session.tasksDispatched - 1);
    addEvent(project, 'arena', 'warning', `Task ${task.id} did not reach Arena; sending it again`, reason, task.id);
    this.persist(project);
    return task;
  }

  /** Stores Arena's reply and hands it to Gemini for evaluation. */
  recordArenaResponse(projectId: string, taskId: string, request: ArenaResponseRequest): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (task.arenaResponse) {
      throw new OrchestratorError('response_already_recorded', `A reply for task ${task.id} has already been recorded.`);
    }
    if (task.status !== 'awaiting_response' && task.status !== 'dispatching') {
      throw new OrchestratorError('invalid_state', `Task ${task.id} is not waiting for a reply (status: ${task.status}).`);
    }
    if (request.dispatchId !== undefined && request.dispatchId !== null) this.requireDispatch(task, request.dispatchId);
    const source = request.source;
    if (source !== 'auto' && source !== 'manual_capture' && source !== 'pasted') {
      throw new OrchestratorError('invalid_request', '"source" must be auto, manual_capture or pasted.', 400);
    }
    const completions: readonly ArenaCompletion[] = ['marker', 'quiet', 'stalled', 'manual'];
    let completion: ArenaCompletion = source === 'auto' ? 'quiet' : 'manual';
    if (request.completion !== undefined) {
      if (!completions.includes(request.completion)) throw new OrchestratorError('invalid_request', '"completion" must be marker, quiet, stalled or manual.', 400);
      completion = request.completion;
    }
    const full = this.deps.scrub(requireText(request.text, 'text', 5_000_000));
    const truncated = full.length > MAX_STORED_RESPONSE_CHARS;
    const at = nowIso();
    task.arenaResponse = {
      id: randomUUID(),
      receivedAt: at,
      source,
      text: truncated ? full.slice(0, MAX_STORED_RESPONSE_CHARS) : full,
      chars: full.length,
      truncated,
      completion,
    };
    if (task.status === 'dispatching') project.session.tasksDispatched += 1;
    if (task.dispatch) {
      // A reply proves the task arrived.
      task.dispatch.confirmedAt ??= at;
      task.dispatch.unconfirmed = false;
    }
    task.status = 'evaluating';
    task.evaluationError = null;
    task.evaluationAttempts = 0;
    task.relay = { phase: 'delivered', message: "Arena's reply was handed to Gemini.", attention: false, chars: full.length, dispatchId: task.dispatch?.dispatchId ?? null, updatedAt: at };
    task.updatedAt = at;

    const sourceText = source === 'auto' ? 'read from the Arena tab' : source === 'manual_capture' ? 'captured from the Arena tab' : 'pasted by you';
    const completionText = completion === 'marker' ? 'complete' : completion === 'stalled' ? 'possibly incomplete' : completion === 'quiet' ? 'no completion line' : 'supplied by hand';
    const size = `${full.length.toLocaleString('en-US')} characters, ${sourceText}, ${completionText}`;
    addEvent(project, 'arena', completion === 'stalled' ? 'warning' : 'info', `Arena replied to ${task.id}`, `${size}.`, task.id);
    const entry = addEntry(project, 'system', 'arena_result', `Arena replied to ${task.id} "${task.title}" (${size}).`, { taskId: task.id });
    this.persist(project);
    this.emitEntry(project, entry);

    // If the session is paused or blocked, the reply is kept and evaluated as soon as it runs again.
    this.advance(project);
    return task;
  }

  /**
   * Arena received the task but produced no reply at all. The task is closed
   * as "no reply" — never as done — and the coordinator decides what to do.
   */
  recordNoResponse(projectId: string, taskId: string, request: NoResponseRequest): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    this.requireDispatch(task, request?.dispatchId);
    if (task.status !== 'awaiting_response') {
      throw new OrchestratorError('invalid_state', `Task ${task.id} is not waiting for a reply (status: ${task.status}).`);
    }
    const reason = typeof request.reason === 'string' && request.reason.trim() ? this.deps.scrub(request.reason.trim().slice(0, 600)) : 'Arena showed no reply.';
    task.status = 'no_response';
    task.closedReason = reason;
    task.relay = null;
    task.updatedAt = nowIso();
    syncCurrentTask(project);
    addEvent(project, 'arena', 'error', `Arena did not reply to ${task.id}`, reason, task.id);
    this.notice(project, `Arena did not reply to ${task.id} "${task.title}". ${reason} Gemini decides how to proceed.`, task.id);

    let unanswered = 0;
    for (let i = project.tasks.length - 1; i >= 0 && project.tasks[i]?.status === 'no_response'; i -= 1) unanswered += 1;
    const prompt = buildNoResponsePrompt(task, reason);
    if (unanswered >= MAX_UNANSWERED_TASKS && project.session.status === 'running') {
      project.pendingNotices.push(prompt.replace(/^\[AgentLink\]\s*/, ''));
      this.block(project, {
        kind: 'arena',
        title: 'Arena is not answering',
        detail: `Arena received the last ${unanswered} tasks and replied to none of them. Check the Arena tab (is it signed in, in Agent Mode, and able to respond?), then continue the session.`,
        options: [],
        taskId: task.id,
      });
      return task;
    }
    this.persist(project);
    if (project.session.status === 'running') {
      this.enqueueTurn(project, { kind: 'continue', text: prompt, taskId: task.id });
    } else {
      project.pendingNotices.push(prompt.replace(/^\[AgentLink\]\s*/, ''));
      this.deps.store.save(project);
    }
    return task;
  }
}
