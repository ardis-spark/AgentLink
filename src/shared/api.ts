/** HTTP contract between the extension (or the companion's own settings page) and the companion. */

import type {
  ArenaCompletion,
  ArenaResponseSource,
  ArenaTask,
  CompanionSettings,
  ConversationEntry,
  GeminiModelInfo,
  GeminiStatus,
  ProjectSummary,
  ProjectView,
  RelayLink,
  RelayPhase,
  TurnState,
} from './types.js';

export const COMPANION_DEFAULT_PORT = 47821;
export const COMPANION_DEFAULT_URL = `http://127.0.0.1:${COMPANION_DEFAULT_PORT}`;
export const COMPANION_NAME = 'agentlink-companion';
export const API_PREFIX = '/v1';

export interface HealthResponse {
  ok: true;
  name: typeof COMPANION_NAME;
  version: string;
}

export interface StatusResponse {
  version: string;
  gemini: GeminiStatus;
  settings: CompanionSettings;
  activeProjectId: string | null;
  dataDir: string;
  relay: RelayLink;
}

export interface CredentialStatusResponse {
  gemini: GeminiStatus;
}

export interface SaveCredentialRequest {
  apiKey: string;
}

export interface ModelsResponse {
  models: GeminiModelInfo[];
  current: string;
  /** False when the configured model is not offered to this API key. */
  currentAvailable: boolean;
}

export interface ProjectListResponse {
  projects: ProjectSummary[];
  activeProjectId: string | null;
}

export interface CreateProjectRequest {
  name: string;
  objective: string;
  instructions?: string;
  constraints?: string[];
  /** Start working on the objective straight away (what the workspace does). */
  start?: boolean;
}

export interface UpdateProjectRequest {
  name?: string;
  objective?: string;
  instructions?: string;
  constraints?: string[];
}

export interface ProjectResponse {
  project: ProjectView;
  conversation: ConversationEntry[];
  turn: TurnState;
}

export interface SendMessageRequest {
  text: string;
}

export type SessionAction = 'start' | 'pause' | 'resume' | 'stop';

export interface SessionRequest {
  action: SessionAction;
}

export interface ClaimDispatchRequest {
  tabId?: number | null;
  tabUrl?: string | null;
}

export interface ClaimDispatchResponse {
  dispatchId: string;
  prompt: string;
  task: ArenaTask;
}

export interface DispatchResultRequest {
  dispatchId: string;
}

export interface DispatchFailureRequest {
  dispatchId: string;
  error: string;
  /**
   * `false`: the prompt definitely did not reach Arena, so the task returns to
   * the queue and is sent again. `'unknown'`: it may have, so the task is kept
   * as awaiting a response until the Arena page has been checked for it.
   */
  submitted: false | 'unknown';
}

export interface ResetDispatchRequest {
  dispatchId: string;
  /** What was checked to conclude the task is not in Arena. */
  reason: string;
}

export interface ArenaResponseRequest {
  dispatchId?: string | null;
  text: string;
  source: ArenaResponseSource;
  /** How the reply was judged to be finished. Defaults to `manual` for captured or pasted replies. */
  completion?: ArenaCompletion;
}

/** Arena received the task but produced no reply. */
export interface NoResponseRequest {
  dispatchId: string;
  reason: string;
}

/** One task the browser extension has to carry to Arena or watch for a reply. */
export interface RelayWorkItem {
  projectId: string;
  projectName: string;
  task: ArenaTask;
}

export interface RelayWorkResponse {
  items: RelayWorkItem[];
}

export interface RelayReportRequest {
  dispatchId?: string | null;
  phase: RelayPhase;
  message: string;
  attention: boolean;
  chars: number;
}

export interface TaskResponse {
  task: ArenaTask;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** Events pushed over the `/v1/events` stream. */
export type CompanionEvent =
  | { type: 'hello'; version: string }
  | { type: 'gemini'; status: GeminiStatus }
  | { type: 'settings'; settings: CompanionSettings }
  | { type: 'projects'; projects: ProjectSummary[]; activeProjectId: string | null }
  | { type: 'project'; projectId: string; project: ProjectView }
  | { type: 'entry'; projectId: string; entry: ConversationEntry }
  | { type: 'delta'; projectId: string; entryId: string; text: string }
  | { type: 'turn'; projectId: string; turn: TurnState }
  | { type: 'relay'; relay: RelayLink };
