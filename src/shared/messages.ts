/** Messages exchanged inside the extension (workspace UI ⇄ background ⇄ Arena content script). */

export const ARENA_URL_PATTERNS = [
  '*://arena.ai/*',
  '*://*.arena.ai/*',
  '*://lmarena.ai/*',
  '*://*.lmarena.ai/*',
] as const;

/** User-adjustable behaviour of the Arena adapter. Empty selectors mean "detect automatically". */
export interface ArenaAdapterConfig {
  composerSelector: string;
  sendButtonSelector: string;
  /** Matches assistant messages; the last match is treated as the response. */
  responseSelector: string;
  /** Matches an element that is only present while Arena is still working. */
  busySelector: string;
  /** How long the page must stay unchanged before a response counts as finished. */
  settleMs: number;
  /** Give up watching after this long (the response can still be captured manually). */
  maxWaitMs: number;
}

export const DEFAULT_ARENA_ADAPTER_CONFIG: ArenaAdapterConfig = {
  composerSelector: '',
  sendButtonSelector: '',
  responseSelector: '',
  busySelector: '',
  settleMs: 12_000,
  maxWaitMs: 45 * 60_000,
};

export interface ArenaPageStatus {
  ok: true;
  url: string;
  title: string;
  /** `null` when the page gives no clear signal either way. */
  agentMode: boolean | null;
  composerFound: boolean;
  sendButtonFound: boolean;
  busy: boolean;
  watchingDispatchId: string | null;
}

export interface ArenaTabInfo {
  tabId: number;
  windowId: number | null;
  title: string;
  url: string;
  active: boolean;
  preferred: boolean;
  /** Result of asking the page's adapter; `null` when the adapter could not be reached. */
  page: ArenaPageStatus | null;
  error: string | null;
}

export interface PreferredArenaTab {
  tabId: number;
  url: string;
  title: string;
}

export interface ArenaConnectionTest {
  ok: boolean;
  tab: ArenaTabInfo | null;
  checks: { label: string; ok: boolean; detail: string }[];
  message: string;
}

export type ArenaExecutionPhase =
  | 'idle'
  | 'sending'
  | 'submitted'
  | 'needs_manual_send'
  | 'generating'
  | 'settling'
  | 'captured'
  | 'timeout'
  | 'error';

export interface ArenaExecutionStatus {
  projectId: string;
  taskId: string;
  dispatchId: string | null;
  phase: ArenaExecutionPhase;
  message: string;
  chars: number;
  updatedAt: number;
}

// ------------------------------------------------ background ⇄ content script

export interface SubmitPromptMessage {
  type: 'agentlink:arena:submit';
  projectId: string;
  taskId: string;
  dispatchId: string;
  prompt: string;
  config: ArenaAdapterConfig;
}

export type ContentRequest =
  | { type: 'agentlink:arena:ping'; config: ArenaAdapterConfig }
  | SubmitPromptMessage
  | {
      type: 'agentlink:arena:watch';
      projectId: string;
      taskId: string;
      dispatchId: string;
      prompt: string;
      config: ArenaAdapterConfig;
    }
  | { type: 'agentlink:arena:capture'; prompt: string; config: ArenaAdapterConfig }
  | { type: 'agentlink:arena:cancel'; dispatchId: string | null };

export type SubmitPromptResult =
  | { ok: true; confirmed: true }
  | { ok: false; submitted: false | 'unknown'; error: string };

export type CaptureResult = { ok: true; text: string } | { ok: false; error: string };

/** Content script → background notifications. */
export type ContentEvent =
  | {
      type: 'agentlink:arena:progress';
      projectId: string;
      taskId: string;
      dispatchId: string;
      generating: boolean;
      chars: number;
    }
  | {
      type: 'agentlink:arena:response';
      projectId: string;
      taskId: string;
      dispatchId: string;
      text: string;
    }
  | {
      type: 'agentlink:arena:timeout';
      projectId: string;
      taskId: string;
      dispatchId: string;
      chars: number;
    };

// ------------------------------------------------------- UI ⇄ background

export type UiRequest =
  | { type: 'agentlink:ui:listArenaTabs' }
  | { type: 'agentlink:ui:setPreferredTab'; tabId: number | null }
  | { type: 'agentlink:ui:testArena'; tabId?: number | null }
  | { type: 'agentlink:ui:focusArenaTab' }
  | { type: 'agentlink:ui:dispatchTask'; projectId: string; taskId: string }
  /**
   * Fallback for when the adapter cannot type into Arena: the task is recorded as sent and the exact prompt is
   * returned so the user can paste it into Arena themselves. AgentLink then watches the tab for the reply.
   */
  | { type: 'agentlink:ui:manualSend'; projectId: string; taskId: string }
  | { type: 'agentlink:ui:captureResponse'; projectId: string; taskId: string }
  /** Re-attach the reply watcher to a task that is already waiting for Arena (for example after a browser restart). */
  | { type: 'agentlink:ui:resumeWatch'; projectId: string; taskId: string }
  /** Stop watching Arena for a task (it was cancelled, or the session was stopped). */
  | { type: 'agentlink:ui:cancelExecution'; projectId: string; taskId: string }
  | { type: 'agentlink:ui:getExecutionStatus' };

export interface ManualSendResult {
  prompt: string;
  watching: boolean;
}

export type UiResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Background → UI broadcast. */
export interface ExecutionStatusBroadcast {
  type: 'agentlink:bg:execution';
  status: ArenaExecutionStatus;
}
