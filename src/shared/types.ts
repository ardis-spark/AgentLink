/**
 * Domain model shared by the companion service and the browser extension.
 *
 * Two things live side by side in a project and must not be confused:
 *
 *  - PROJECT MEMORY: structured, durable facts (objective, constraints,
 *    milestones, tasks, decisions, issues, Arena responses, session state).
 *    It is injected into every Gemini request and is never trimmed.
 *  - CONVERSATION: the running dialogue with the coordinator. The visible
 *    conversation is kept for the user, while the model-facing transcript is
 *    subject to context compaction (older turns are folded into a summary).
 */

export type IsoTime = string;

// ---------------------------------------------------------------- session ---

/**
 * idle → running → completed. A running session works on its own.
 *
 *  - `paused`:  the user asked AgentLink to hold still.
 *  - `blocked`: AgentLink cannot continue without the user (see `blocker`).
 *  - `stopped`: the user ended the session.
 */
export type SessionStatus = 'idle' | 'running' | 'paused' | 'blocked' | 'stopped' | 'completed';

/**
 * Why a session cannot continue on its own:
 *  - `question`:    the coordinator needs information or authorisation only the user can give.
 *  - `gemini`:      Gemini cannot be used (no key, key rejected, repeated failures).
 *  - `arena`:       a task could not be delivered to Arena after several safe attempts.
 *  - `coordinator`: Gemini kept ending its turn without a next step.
 *  - `task_budget`: the configured safety limit of tasks per session was reached.
 */
export type BlockerKind = 'question' | 'gemini' | 'arena' | 'coordinator' | 'task_budget';

export interface Blocker {
  kind: BlockerKind;
  title: string;
  detail: string;
  /** Answers the coordinator suggested, when it asked a question. */
  options: string[];
  taskId: string | null;
  at: IsoTime;
}

export interface SessionState {
  status: SessionStatus;
  startedAt: IsoTime | null;
  updatedAt: IsoTime;
  /** Set exactly while `status` is `blocked`. */
  blocker: Blocker | null;
  /** Tasks handed to Arena since the session was last started or resumed. */
  tasksDispatched: number;
  /** Coordinator turns in a row that ended with nothing left in motion. */
  idleTurns: number;
  note: string | null;
}

// ------------------------------------------------------------------ tasks ---

/**
 * queued → dispatching → awaiting_response → evaluating →
 *   completed | partial | failed | inconclusive
 *
 * A task is queued the moment the coordinator creates it and is sent to Arena
 * without anyone approving it. Side exits: `no_response` (Arena received the
 * task and never answered) and `cancelled` (the user stopped it).
 */
export type TaskStatus =
  | 'queued'
  | 'dispatching'
  | 'awaiting_response'
  | 'evaluating'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'inconclusive'
  | 'no_response'
  | 'cancelled';

export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'dispatching', 'awaiting_response', 'evaluating'];

export type EvaluationVerdict = 'complete' | 'partial' | 'failed' | 'unclear';

export interface DispatchRecord {
  dispatchId: string;
  attempt: number;
  claimedAt: IsoTime;
  confirmedAt: IsoTime | null;
  tabId: number | null;
  tabUrl: string | null;
  /** The exact text handed to Arena. */
  prompt: string;
  /**
   * Reference code unique to this delivery attempt. It is part of the prompt,
   * so the message can be found again in the Arena page, and Arena is asked to
   * close its report with it. Empty for deliveries made before references existed.
   */
  ref: string;
  /**
   * True when AgentLink could not confirm whether Arena accepted the prompt
   * (for example after a restart mid-dispatch). Such a task is re-sent only
   * after the Arena page has been checked and does not contain it.
   */
  unconfirmed: boolean;
  error: string | null;
}

export type ArenaResponseSource = 'auto' | 'manual_capture' | 'pasted';

/**
 * How AgentLink concluded that a reply was finished:
 *  - `marker`:  Arena closed its report with the completion line it was asked for.
 *  - `quiet`:   Arena stopped working and the reply stopped changing, without the completion line.
 *  - `stalled`: the page still looked busy, but nothing had changed for a long time.
 *  - `manual`:  a person captured or pasted the reply.
 */
export type ArenaCompletion = 'marker' | 'quiet' | 'stalled' | 'manual';

/** Where the open task is on its way to Arena and back, as last reported by the browser extension. */
export type RelayPhase =
  | 'waiting_for_arena'
  | 'sending'
  | 'verifying'
  | 'submitted'
  | 'generating'
  | 'settling'
  | 'delivering'
  | 'delivered'
  | 'searching'
  | 'stalled';

export interface RelayStatus {
  phase: RelayPhase;
  /** One sentence saying what is happening, or what is in the way. */
  message: string;
  /** True when progress depends on something only the user can fix (for example, no Arena tab is open). */
  attention: boolean;
  /** Characters of Arena's reply seen so far. */
  chars: number;
  dispatchId: string | null;
  updatedAt: IsoTime;
}

export interface ArenaResponseRecord {
  id: string;
  receivedAt: IsoTime;
  source: ArenaResponseSource;
  /** Verbatim text read from the Arena tab (capped; see `truncated`). */
  text: string;
  chars: number;
  truncated: boolean;
  completion: ArenaCompletion;
  /** Set only in views sent to the UI: `text` holds just the beginning; fetch the task for the rest. */
  excerptOnly?: boolean;
}

export interface TaskEvaluation {
  verdict: EvaluationVerdict;
  summary: string;
  /** Verbatim quotes from the Arena response that support the verdict. */
  evidence: string[];
  /** Acceptance criteria or work that the response does not demonstrate. */
  missing: string[];
  at: IsoTime;
  model: string;
}

export interface ArenaTask {
  id: string;
  seq: number;
  title: string;
  /** What Arena must do. */
  instructions: string;
  /** Background Arena needs, since it does not share the coordinator's memory. */
  context: string;
  acceptanceCriteria: string[];
  /** Why this task, now. Shown to the user; not sent to Arena. */
  rationale: string;
  milestoneId: string | null;
  status: TaskStatus;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  dispatch: DispatchRecord | null;
  /** Live position of the task between AgentLink and Arena. */
  relay: RelayStatus | null;
  arenaResponse: ArenaResponseRecord | null;
  evaluation: TaskEvaluation | null;
  /** Why the last evaluation attempt did not produce a verdict. It is retried automatically. */
  evaluationError: string | null;
  evaluationAttempts: number;
  /** Why the task was closed without a verdict (`no_response`, `cancelled`). */
  closedReason: string | null;
  /** Fingerprint of the normalised prompt; used to block duplicate submissions. */
  fingerprint: string;
}

// ----------------------------------------------------------------- memory ---

export type MilestoneStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface Milestone {
  id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  notes: string;
  updatedAt: IsoTime;
}

export interface Decision {
  id: string;
  summary: string;
  rationale: string;
  at: IsoTime;
  source: 'coordinator' | 'user';
}

export type IssueSeverity = 'low' | 'medium' | 'high';

export interface KnownIssue {
  id: string;
  title: string;
  details: string;
  severity: IssueSeverity;
  status: 'open' | 'resolved';
  resolution: string;
  taskId: string | null;
  createdAt: IsoTime;
  resolvedAt: IsoTime | null;
}

// ----------------------------------------------------------- conversation ---

export interface ToolAction {
  name: string;
  ok: boolean;
  /** One-line, human readable outcome. */
  summary: string;
}

export interface TokenUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type ConversationRole = 'user' | 'coordinator' | 'system';
export type ConversationKind = 'message' | 'arena_result' | 'task_feedback' | 'notice';

/** One visible item in the coordinator conversation. */
export interface ConversationEntry {
  id: string;
  at: IsoTime;
  role: ConversationRole;
  kind: ConversationKind;
  text: string;
  taskId: string | null;
  status: 'streaming' | 'complete' | 'interrupted' | 'error';
  error: string | null;
  actions: ToolAction[];
  model: string | null;
  usage: TokenUsage | null;
}

/**
 * A part exactly as exchanged with the Gemini API. Model parts are stored
 * verbatim (including `thoughtSignature`) because the API requires them to be
 * returned unchanged.
 */
export interface WirePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
}

export interface WireContent {
  role: 'user' | 'model';
  parts: WirePart[];
  /** Model that produced a `model` content; signatures are only replayed to the same model. */
  model?: string;
  /** Marks the first content of a coordinator turn (a safe compaction boundary). */
  turnStart?: boolean;
}

// --------------------------------------------------------------- timeline ---

export type TimelineLevel = 'info' | 'success' | 'warning' | 'error';

export type TimelineKind =
  | 'project'
  | 'session'
  | 'message'
  | 'plan'
  | 'task'
  | 'arena'
  | 'evaluation'
  | 'decision'
  | 'issue'
  | 'gemini'
  | 'error';

export interface TimelineEvent {
  id: string;
  at: IsoTime;
  kind: TimelineKind;
  level: TimelineLevel;
  title: string;
  detail: string;
  taskId: string | null;
}

// ---------------------------------------------------------------- project ---

export interface ProjectCounters {
  task: number;
  milestone: number;
  decision: number;
  issue: number;
  event: number;
  entry: number;
}

export interface ActiveTurnMarker {
  entryId: string;
  startedAt: IsoTime;
}

/** The complete persisted record of a project (one JSON file on disk). */
export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  objective: string;
  instructions: string;
  constraints: string[];
  status: 'active' | 'complete';
  completion: { summary: string; at: IsoTime } | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;

  milestones: Milestone[];
  currentMilestoneId: string | null;
  tasks: ArenaTask[];
  currentTaskId: string | null;
  decisions: Decision[];
  issues: KnownIssue[];
  timeline: TimelineEvent[];
  session: SessionState;

  conversation: ConversationEntry[];
  /** Model-facing history; compacted into `contextSummary` when it grows. */
  transcript: WireContent[];
  contextSummary: string;
  /** Set while a coordinator turn runs so an interrupted turn can be repaired after a crash. */
  activeTurn: ActiveTurnMarker | null;
  /** Things that happened outside the conversation; passed to the coordinator with its next turn. */
  pendingNotices: string[];

  counters: ProjectCounters;
}

export interface ProjectSummary {
  id: string;
  name: string;
  objective: string;
  status: Project['status'];
  sessionStatus: SessionStatus;
  updatedAt: IsoTime;
  openTaskId: string | null;
  tasksCompleted: number;
}

/** What the UI receives: the project without the model-facing transcript. */
export type ProjectView = Omit<Project, 'transcript' | 'conversation' | 'schemaVersion' | 'counters'>;

// ----------------------------------------------------------------- gemini ---

export type GeminiConnectionState =
  | 'no_key'
  | 'unverified'
  | 'checking'
  | 'connected'
  | 'invalid_key'
  | 'permission_denied'
  | 'model_unavailable'
  | 'rate_limited'
  | 'unreachable'
  | 'error';

export type GeminiErrorKind =
  | 'no_key'
  | 'invalid_key'
  | 'permission_denied'
  | 'model_not_found'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'blocked'
  | 'bad_request'
  | 'malformed_response'
  | 'unknown';

export interface GeminiErrorInfo {
  kind: GeminiErrorKind;
  message: string;
  status: number | null;
  retryable: boolean;
}

export interface GeminiModelInfo {
  id: string;
  displayName: string;
  description: string;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
}

export interface GeminiStatus {
  state: GeminiConnectionState;
  model: string;
  keyConfigured: boolean;
  keySource: 'saved' | 'environment' | null;
  /** Short non-reversible fingerprint so two keys can be told apart. Never the key. */
  keyFingerprint: string | null;
  lastCheckedAt: IsoTime | null;
  lastOkAt: IsoTime | null;
  error: GeminiErrorInfo | null;
}

export type ThinkingLevelSetting = 'default' | 'low' | 'medium' | 'high';

export interface CompanionSettings {
  model: string;
  thinkingLevel: ThinkingLevelSetting;
  /** Extra attempts after the first one for retryable failures. */
  maxRetries: number;
  /** Max wait for the first streamed chunk of a response. */
  firstChunkTimeoutMs: number;
  /** Max silence between streamed chunks. */
  idleTimeoutMs: number;
  /** Hard cap for a single Gemini request. */
  totalTimeoutMs: number;
  /** Tool-calling rounds Gemini may take within one coordinator turn. */
  maxToolRounds: number;
  /**
   * Safety limit on tasks sent to Arena in one session. It exists to stop a
   * runaway loop, not to ask for approval; reaching it blocks the session.
   */
  maxTasksPerSession: number;
  /** Approximate size of the model-facing transcript before older turns are summarised. */
  contextBudgetChars: number;
  /** How much of one Arena response is passed to Gemini (head and tail are kept). */
  arenaResponseContextChars: number;
}

export interface TurnState {
  projectId: string;
  active: boolean;
  entryId: string | null;
  kind: 'user' | 'evaluation' | 'continue' | null;
  phase: 'idle' | 'waiting' | 'streaming' | 'tools' | 'retrying' | 'compacting';
  startedAt: IsoTime | null;
  retry: { attempt: number; maxAttempts: number; delayMs: number; reason: string } | null;
}

/** Whether the browser extension that carries tasks to Arena is in contact with the companion. */
export interface RelayLink {
  online: boolean;
  seenAt: IsoTime | null;
}
