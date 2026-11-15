import { randomUUID } from 'node:crypto';
import type {
  ArenaResponseRequest,
  ClaimDispatchRequest,
  ClaimDispatchResponse,
  CreateProjectRequest,
  DispatchFailureRequest,
  EditTaskRequest,
  ProjectListResponse,
  ProjectResponse,
  SessionAction,
  UpdateProjectRequest,
} from '../../shared/api.js';
import { cleanList, excerpt } from '../../shared/text.js';
import type { ArenaTask, CompanionSettings, ConversationEntry, Project, TurnState } from '../../shared/types.js';
import { buildEvaluationPrompt, buildRejectionPrompt } from '../coordinator/context.js';
import type { Coordinator, TurnInput } from '../coordinator/coordinator.js';
import type { GeminiService } from '../gemini/geminiService.js';
import type { Logger } from '../logger.js';
import {
  addEntry,
  addEvent,
  createProject,
  findTask,
  isOpenTask,
  nowIso,
  openTask,
  syncCurrentTask,
  taskFingerprint,
  taskPrompt,
  toProjectView,
  touch,
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
}

interface QueuedTurn {
  input: TurnInput;
  /** Resolves when the turn has finished (or was skipped). */
  done: Promise<void>;
}

interface ProjectRuntime {
  chain: Promise<void>;
  queued: number;
  controller: AbortController | null;
  /** Why the running turn was aborted, so the aftermath can be handled correctly. */
  abortReason: 'pause' | 'stop' | 'cancel' | 'delete' | null;
  turn: TurnState;
}

const MAX_MESSAGE_CHARS = 100_000;
const MAX_STORED_RESPONSE_CHARS = 300_000;

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
 * The controlled coordination loop.
 *
 * Gemini analyses, plans, reviews and proposes; Arena executes; the user
 * decides. This class owns the rules that make that safe:
 *
 *  - nothing reaches Arena without an explicit approval of that exact task;
 *  - a task is handed out for dispatch exactly once (claim → confirm), so a
 *    double click, a retry or a restart can never submit it twice;
 *  - Gemini only runs while the session is "running", one turn at a time;
 *  - every automatic step is bounded (tool rounds, tasks per session), and
 *    pause/stop abort whatever is in flight.
 */
export class Orchestrator {
  private readonly runtimes = new Map<string, ProjectRuntime>();

  constructor(private readonly deps: OrchestratorDeps) {}

  // ------------------------------------------------------------ plumbing ---

  private runtime(projectId: string): ProjectRuntime {
    let runtime = this.runtimes.get(projectId);
    if (!runtime) {
      runtime = { chain: Promise.resolve(), queued: 0, controller: null, abortReason: null, turn: idleTurn(projectId) };
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
      idle: 'Start the session first.',
      paused: 'The session is paused. Resume it first.',
      stopped: 'The session is stopped. Start a new session first.',
      completed: 'The objective is marked complete. Reopen the session first.',
    };
    throw new OrchestratorError('session_not_running', `Cannot ${action}: ${hint[status] ?? 'the session is not running.'}`);
  }

  private persist(project: Project): void {
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

  private setTurn(projectId: string, patch: Partial<TurnState>): void {
    const runtime = this.runtime(projectId);
    runtime.turn = { ...runtime.turn, ...patch };
    this.deps.bus.emit({ type: 'turn', projectId, turn: runtime.turn });
  }

  private isBusy(projectId: string): boolean {
    const runtime = this.runtime(projectId);
    return runtime.turn.active || runtime.queued > 0;
  }

  private abortTurn(projectId: string, reason: NonNullable<ProjectRuntime['abortReason']>): void {
    const runtime = this.runtime(projectId);
    if (runtime.controller) {
      runtime.abortReason = reason;
      runtime.controller.abort();
    }
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

  // ------------------------------------------------------ turn execution ---

  private enqueueTurn(project: Project, input: TurnInput): QueuedTurn {
    const runtime = this.runtime(project.id);
    runtime.queued += 1;
    const done = runtime.chain.then(async () => {
      runtime.queued -= 1;
      try {
        await this.executeTurn(project.id, input);
      } catch (error) {
        this.deps.logger.error('Coordinator turn crashed:', error);
        this.setTurn(project.id, idleTurn(project.id));
      }
    });
    runtime.chain = done;
    return { input, done };
  }

  private async executeTurn(projectId: string, input: TurnInput): Promise<void> {
    const project = this.deps.store.get(projectId);
    if (!project) return;
    // The session may have been paused or stopped while this turn waited in the queue.
    if (project.session.status !== 'running') return;
    if (input.kind === 'evaluation') {
      const task = input.taskId ? findTask(project, input.taskId) : null;
      if (!task || task.status !== 'evaluating' || task.evaluation) return;
    }

    const runtime = this.runtime(projectId);
    const controller = new AbortController();
    runtime.controller = controller;
    runtime.abortReason = null;

    // Deliver anything the user changed outside the conversation along with this turn.
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
        save: () => this.deps.store.save(project),
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

    if (input.kind === 'evaluation' && input.taskId) {
      const task = findTask(project, input.taskId);
      if (task && task.status === 'evaluating' && !task.evaluation) {
        if (outcome.status === 'interrupted' && abortReason === 'pause') {
          // Paused mid-evaluation: leave it pending so resuming the session picks it up again.
          task.evaluationError = null;
        } else {
          task.evaluationError = outcome.error
            ? outcome.error.message
            : 'Gemini replied without recording a verdict for this task.';
          addEvent(project, 'evaluation', 'error', `Evaluation of ${task.id} did not finish`, task.evaluationError, task.id);
        }
      }
    }

    this.persist(project);
    this.setTurn(projectId, idleTurn(projectId));
    this.emitProjects();
  }

  private pendingEvaluation(project: Project): ArenaTask | null {
    return project.tasks.find((t) => t.status === 'evaluating' && !t.evaluation && !t.evaluationError) ?? null;
  }

  private scheduleEvaluation(project: Project, task: ArenaTask): void {
    const settings = this.deps.getSettings();
    this.enqueueTurn(project, { kind: 'evaluation', text: buildEvaluationPrompt(task, settings), taskId: task.id });
  }

  // ------------------------------------------------------------- recovery ---

  /**
   * Called once at start-up. Brings every project into a consistent, resumable
   * state: nothing runs on its own after a restart, and nothing is re-sent.
   */
  recoverAfterRestart(): void {
    for (const project of this.deps.store.all()) {
      let changed = false;
      project.pendingNotices ??= [];

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
          // have reached Arena, so the task is kept as "sent, unconfirmed" and is never re-sent automatically.
          task.status = 'awaiting_response';
          if (task.dispatch) {
            task.dispatch.unconfirmed = true;
            task.dispatch.error = 'AgentLink restarted while this task was being sent; delivery could not be confirmed.';
          }
          project.session.tasksDispatched += 1;
          addEvent(project, 'arena', 'warning', `Delivery of ${task.id} unconfirmed after restart`, 'Check the Arena tab. Capture the reply if the task was received, or mark it as not sent.', task.id);
          changed = true;
        }
      }

      if (project.session.status === 'running') {
        project.session.status = 'paused';
        project.session.pauseReason = 'restart';
        project.session.note = 'Restored after a restart. Resume to continue.';
        project.session.updatedAt = nowIso();
        addEvent(project, 'session', 'info', 'Session restored after restart', 'The session was running when AgentLink stopped. It is paused until you resume it.');
        changed = true;
      }

      syncCurrentTask(project);
      if (changed) this.deps.store.save(project);
    }
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

  /** The user speaks to the coordinator. Returns as soon as the turn is queued; output arrives over the event stream. */
  sendMessage(projectId: string, rawText: unknown): { entry: ConversationEntry; done: Promise<void> } {
    const project = this.requireProject(projectId);
    const text = this.deps.scrub(requireText(rawText, 'text', MAX_MESSAGE_CHARS));
    if (project.session.status !== 'idle') this.requireRunning(project, 'send a message');
    if (this.isBusy(projectId)) {
      throw new OrchestratorError('coordinator_busy', 'The coordinator is still working on the previous step. Wait for it to finish or stop the reply.');
    }
    if (this.deps.gemini.status().state === 'no_key') {
      throw new OrchestratorError('gemini_not_configured', 'No Gemini API key is configured. Open the companion settings to add one.');
    }
    if (project.session.status === 'idle') this.startSession(project);

    const entry = addEntry(project, 'user', 'message', text);
    this.deps.store.save(project);
    this.emitEntry(project, entry);
    const queued = this.enqueueTurn(project, { kind: 'user', text, taskId: null });
    return { entry, done: queued.done };
  }

  /** Stops the reply that is being generated without changing the session state. */
  cancelTurn(projectId: string): { cancelled: boolean } {
    this.requireProject(projectId);
    const active = this.runtime(projectId).controller !== null;
    if (active) this.abortTurn(projectId, 'cancel');
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
    project.session = { status: 'running', startedAt: at, updatedAt: at, pauseReason: null, tasksDispatched: 0, note: null };
    addEvent(project, 'session', 'info', reopened ? 'Session reopened' : 'Session started');
  }

  controlSession(projectId: string, action: SessionAction): ProjectResponse {
    const project = this.requireProject(projectId);
    const status = project.session.status;
    const invalid = (): never => {
      throw new OrchestratorError('invalid_transition', `Cannot ${action} a session that is ${status}.`);
    };

    switch (action) {
      case 'start': {
        if (status !== 'idle' && status !== 'stopped' && status !== 'completed') invalid();
        this.startSession(project);
        break;
      }
      case 'pause': {
        if (status !== 'running') invalid();
        project.session.status = 'paused';
        project.session.pauseReason = 'user';
        project.session.note = null;
        project.session.updatedAt = nowIso();
        addEvent(project, 'session', 'info', 'Session paused', 'Gemini is idle and nothing will be sent to Arena until you resume.');
        this.abortTurn(projectId, 'pause');
        break;
      }
      case 'resume': {
        if (status !== 'paused') invalid();
        if (project.session.pauseReason === 'task_budget') project.session.tasksDispatched = 0;
        project.session.status = 'running';
        project.session.pauseReason = null;
        project.session.note = null;
        project.session.updatedAt = nowIso();
        addEvent(project, 'session', 'info', 'Session resumed');
        const pending = this.pendingEvaluation(project);
        if (pending) this.scheduleEvaluation(project, pending);
        break;
      }
      case 'stop': {
        if (status !== 'running' && status !== 'paused') invalid();
        project.session.status = 'stopped';
        project.session.pauseReason = null;
        project.session.note = null;
        project.session.updatedAt = nowIso();
        const open = openTask(project);
        if (open) {
          const wasSent = open.status === 'awaiting_response' || open.status === 'dispatching' || open.status === 'evaluating';
          open.status = 'cancelled';
          open.updatedAt = nowIso();
          project.pendingNotices.push(
            `The user stopped the session; task ${open.id} "${open.title}" was cancelled${wasSent ? ' after it had been sent to Arena' : ' before it was sent'}.`,
          );
          addEvent(project, 'task', 'warning', `Task ${open.id} cancelled (session stopped)`, wasSent ? 'It had already been sent to Arena; any later reply is ignored.' : '', open.id);
        }
        syncCurrentTask(project);
        addEvent(project, 'session', 'warning', 'Session stopped');
        this.abortTurn(projectId, 'stop');
        break;
      }
      default:
        throw new OrchestratorError('invalid_request', `Unknown session action "${String(action)}".`, 400);
    }
    this.persist(project);
    this.emitProjects();
    return this.getProject(projectId);
  }

  // ------------------------------------------------------------------- tasks ---

  editTask(projectId: string, taskId: string, patch: EditTaskRequest): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (task.status !== 'proposed' && task.status !== 'approved') {
      throw new OrchestratorError('invalid_state', `Task ${task.id} can no longer be edited (status: ${task.status}).`);
    }
    const scrub = this.deps.scrub;
    if (patch.title !== undefined) task.title = scrub(requireText(patch.title, 'title', 200));
    if (patch.instructions !== undefined) task.instructions = scrub(requireText(patch.instructions, 'instructions', 30_000));
    if (patch.context !== undefined) {
      if (typeof patch.context !== 'string') throw new OrchestratorError('invalid_request', '"context" must be a string.', 400);
      task.context = scrub(patch.context.trim().slice(0, 20_000));
    }
    if (patch.acceptanceCriteria !== undefined) task.acceptanceCriteria = cleanList(patch.acceptanceCriteria, 30, 1000).map(scrub);
    task.editedByUser = true;
    task.fingerprint = taskFingerprint(task);
    task.updatedAt = nowIso();
    addEvent(project, 'task', 'info', `Task ${task.id} edited by you`, task.title, task.id);
    this.persist(project);
    return task;
  }

  /** The user approves a proposed task. This is the only way a task becomes eligible to be sent. */
  approveTask(projectId: string, taskId: string): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (task.status === 'approved') return task;
    if (task.status !== 'proposed') {
      throw new OrchestratorError('invalid_state', `Task ${task.id} cannot be approved (status: ${task.status}).`);
    }
    this.requireRunning(project, 'approve a task');
    task.status = 'approved';
    task.approvedAt = nowIso();
    task.updatedAt = task.approvedAt;
    addEvent(project, 'task', 'success', `Task ${task.id} approved by you`, task.title, task.id);
    this.persist(project);
    return task;
  }

  rejectTask(projectId: string, taskId: string, rawReason?: unknown): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (task.status !== 'proposed' && task.status !== 'approved') {
      throw new OrchestratorError('invalid_state', `Task ${task.id} cannot be rejected (status: ${task.status}).`);
    }
    const reason = typeof rawReason === 'string' ? this.deps.scrub(rawReason.trim().slice(0, 4000)) : '';
    task.status = 'rejected';
    task.rejection = { reason, at: nowIso() };
    task.updatedAt = nowIso();
    syncCurrentTask(project);
    addEvent(project, 'task', 'warning', `Task ${task.id} rejected by you`, reason, task.id);

    if (reason && project.session.status === 'running') {
      const entry = addEntry(project, 'user', 'task_feedback', `Rejected ${task.id}: ${reason}`, { taskId: task.id });
      this.persist(project);
      this.emitEntry(project, entry);
      this.enqueueTurn(project, { kind: 'feedback', text: buildRejectionPrompt(task, reason), taskId: task.id });
    } else {
      project.pendingNotices.push(`The user rejected task ${task.id} "${task.title}"${reason ? `. Reason: "${reason}"` : ' without giving a reason'}.`);
      this.persist(project);
    }
    return task;
  }

  /** The user abandons a task that was already handed to Arena (or is being evaluated). */
  cancelTask(projectId: string, taskId: string): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (!isOpenTask(task)) {
      throw new OrchestratorError('invalid_state', `Task ${task.id} is already closed (status: ${task.status}).`);
    }
    const previous = task.status;
    task.status = 'cancelled';
    task.updatedAt = nowIso();
    syncCurrentTask(project);
    project.pendingNotices.push(`The user cancelled task ${task.id} "${task.title}" (it was ${previous.replace('_', ' ')}).`);
    addEvent(project, 'task', 'warning', `Task ${task.id} cancelled by you`, '', task.id);
    if (previous === 'evaluating' && this.runtime(projectId).turn.kind === 'evaluation') this.abortTurn(projectId, 'cancel');
    this.persist(project);
    return task;
  }

  // ---------------------------------------------------------------- dispatch ---

  /**
   * Hands out an approved task for delivery to Arena — exactly once. The task
   * leaves "approved" atomically, so a second claim (double click, retry,
   * second window) is refused instead of producing a second submission.
   */
  claimDispatch(projectId: string, taskId: string, request: ClaimDispatchRequest = {}): ClaimDispatchResponse {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    this.requireRunning(project, 'send a task to Arena');
    if (task.status !== 'approved') {
      const why =
        task.status === 'proposed'
          ? 'it has not been approved yet'
          : task.status === 'dispatching' || task.status === 'awaiting_response'
            ? 'it has already been handed to Arena'
            : `its status is ${task.status}`;
      throw new OrchestratorError('not_dispatchable', `Task ${task.id} cannot be sent: ${why}.`);
    }
    const settings = this.deps.getSettings();
    if (project.session.tasksDispatched >= settings.maxTasksPerSession) {
      project.session.status = 'paused';
      project.session.pauseReason = 'task_budget';
      project.session.note = `${project.session.tasksDispatched} tasks were sent in this session (limit ${settings.maxTasksPerSession}). Resume to continue.`;
      project.session.updatedAt = nowIso();
      addEvent(project, 'session', 'warning', 'Session paused: task limit reached', project.session.note);
      this.persist(project);
      throw new OrchestratorError('task_budget_reached', project.session.note);
    }

    const prompt = this.deps.scrub(taskPrompt(project, task));
    task.dispatch = {
      dispatchId: randomUUID(),
      attempt: (task.dispatch?.attempt ?? 0) + 1,
      claimedAt: nowIso(),
      confirmedAt: null,
      tabId: typeof request.tabId === 'number' ? request.tabId : null,
      tabUrl: typeof request.tabUrl === 'string' ? request.tabUrl.slice(0, 2000) : null,
      prompt,
      unconfirmed: false,
      error: null,
    };
    task.status = 'dispatching';
    task.updatedAt = nowIso();
    this.persist(project);
    return { dispatchId: task.dispatch.dispatchId, prompt, task };
  }

  private requireDispatch(task: ArenaTask, dispatchId: unknown): NonNullable<ArenaTask['dispatch']> {
    if (!task.dispatch || typeof dispatchId !== 'string' || task.dispatch.dispatchId !== dispatchId) {
      throw new OrchestratorError('stale_dispatch', `That delivery attempt no longer belongs to task ${task.id}.`);
    }
    return task.dispatch;
  }

  /** Arena accepted the prompt. */
  confirmDispatch(projectId: string, taskId: string, dispatchId: unknown): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    const dispatch = this.requireDispatch(task, dispatchId);
    if (task.status === 'awaiting_response' && dispatch.confirmedAt) return task;
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
      // Nothing reached Arena: the approval stands and the user may try again.
      task.status = 'approved';
      addEvent(project, 'arena', 'error', `Task ${task.id} could not be sent`, message, task.id);
    } else {
      // It may have reached Arena. Keep waiting for a reply and never re-send on our own.
      task.status = 'awaiting_response';
      dispatch.unconfirmed = true;
      project.session.tasksDispatched += 1;
      addEvent(project, 'arena', 'warning', `Delivery of ${task.id} unconfirmed`, message, task.id);
    }
    task.updatedAt = nowIso();
    this.persist(project);
    return task;
  }

  /** The user states that an unconfirmed delivery did not actually reach Arena, making the task sendable again. */
  resetDispatch(projectId: string, taskId: string): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (task.status !== 'awaiting_response' || !task.dispatch?.unconfirmed) {
      throw new OrchestratorError('invalid_state', `Task ${task.id} has no unconfirmed delivery to reset (status: ${task.status}).`);
    }
    task.status = 'approved';
    task.dispatch.error = 'Marked as not sent by you.';
    task.updatedAt = nowIso();
    project.session.tasksDispatched = Math.max(0, project.session.tasksDispatched - 1);
    addEvent(project, 'arena', 'info', `Task ${task.id} marked as not sent`, 'It can be sent again.', task.id);
    this.persist(project);
    return task;
  }

  /** Stores Arena's visible reply and hands it to Gemini for evaluation. */
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
    };
    if (task.status === 'dispatching') {
      project.session.tasksDispatched += 1;
      if (task.dispatch) task.dispatch.confirmedAt = at;
    }
    task.status = 'evaluating';
    task.evaluationError = null;
    task.updatedAt = at;

    const sourceText = source === 'auto' ? 'read from the Arena tab' : source === 'manual_capture' ? 'captured from the Arena tab' : 'pasted by you';
    addEvent(project, 'arena', 'info', `Arena replied to ${task.id}`, `${full.length.toLocaleString('en-US')} characters, ${sourceText}.`, task.id);
    const entry = addEntry(project, 'system', 'arena_result', `Arena replied to ${task.id} "${task.title}" (${full.length.toLocaleString('en-US')} characters, ${sourceText}).`, {
      taskId: task.id,
    });
    this.persist(project);
    this.emitEntry(project, entry);

    if (project.session.status === 'running') this.scheduleEvaluation(project, task);
    return task;
  }

  /** Runs the evaluation again after it failed. */
  retryEvaluation(projectId: string, taskId: string): ArenaTask {
    const project = this.requireProject(projectId);
    const task = this.requireTask(project, taskId);
    if (task.status !== 'evaluating' || !task.arenaResponse) {
      throw new OrchestratorError('invalid_state', `Task ${task.id} is not awaiting evaluation (status: ${task.status}).`);
    }
    this.requireRunning(project, 'evaluate a reply');
    if (this.isBusy(projectId)) {
      throw new OrchestratorError('coordinator_busy', 'The coordinator is already working. Wait for it to finish.');
    }
    task.evaluationError = null;
    this.persist(project);
    this.scheduleEvaluation(project, task);
    return task;
  }
}
