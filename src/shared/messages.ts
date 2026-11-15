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
  /** Matches assistant messages; everything they contain after the sent task is the reply. */
  responseSelector: string;
  /** Matches an element that is only present while Arena is still working. */
  busySelector: string;
  /**
   * How long Arena must be idle and the reply unchanged before a reply that
   * lacks the completion line counts as finished.
   */
  settleMs: number;
  /**
   * Longest time without any visible change before AgentLink stops waiting:
   * what Arena has written by then is handed over marked as possibly
   * incomplete, or the task is closed as "no reply" if nothing was written.
   */
  maxWaitMs: number;
}

export const DEFAULT_ARENA_ADAPTER_CONFIG: ArenaAdapterConfig = {
  composerSelector: '',
  sendButtonSelector: '',
  responseSelector: '',
  busySelector: '',
  settleMs: 12_000,
  maxWaitMs: 20 * 60_000,
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
  /** The beginning of whatever text is sitting in the message box (empty when the box is empty). */
  composerDraft: string;
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

// ------------------------------------------------ background ⇄ content script
//
// The adapter in the Arena tab keeps no state of its own. The background
// script asks it questions ("is this task in the page? what does the reply
// look like right now?") and decides everything itself, so a reloaded page, a
// navigation or a throttled background tab cannot lose track of a task.

export interface SubmitPromptMessage {
  type: 'agentlink:arena:submit';
  prompt: string;
  /** Reference code of this delivery attempt (part of the prompt). */
  ref: string;
  config: ArenaAdapterConfig;
}

export type ContentRequest =
  | { type: 'agentlink:arena:ping'; config: ArenaAdapterConfig }
  | SubmitPromptMessage
  | { type: 'agentlink:arena:probe'; prompt: string; ref: string; config: ArenaAdapterConfig }
  | { type: 'agentlink:arena:capture'; prompt: string; ref: string; config: ArenaAdapterConfig };

export type SubmitPromptResult =
  | { ok: true; confirmed: true }
  | { ok: false; submitted: false | 'unknown'; error: string };

/** A snapshot of one task in the Arena page, taken on request. */
export interface ProbeResult {
  ok: true;
  url: string;
  /** The message carrying this task is in the conversation. */
  found: boolean;
  /** How it was recognised: by its reference code, by its text, or only by its heading. */
  match: 'ref' | 'prompt' | 'heading' | null;
  /** Arena shows that it is still working. */
  busy: boolean;
  /** Characters of reply text after the task's message. */
  chars: number;
  /** Changes whenever the reply text changes. */
  digest: string;
  /** The reply ends its report with the completion line that was asked for. */
  marker: boolean;
  /** The message box still holds this task: it was typed but not sent. */
  composerHoldsPrompt: boolean;
}

export type CaptureResult = { ok: true; text: string; marker: boolean; busy: boolean } | { ok: false; error: string };

// ------------------------------------------------------- UI ⇄ background

export type UiRequest =
  | { type: 'agentlink:ui:listArenaTabs' }
  | { type: 'agentlink:ui:setPreferredTab'; tabId: number | null }
  | { type: 'agentlink:ui:testArena'; tabId?: number | null }
  | { type: 'agentlink:ui:focusArenaTab' }
  /** Look for work right now instead of at the next scheduled check. */
  | { type: 'agentlink:ui:wake' }
  /**
   * Recovery tool, never part of the normal flow: read what Arena has written
   * for a task right now and hand it over, without waiting for it to settle.
   */
  | { type: 'agentlink:ui:captureResponse'; projectId: string; taskId: string };

export type UiResult<T> = { ok: true; value: T } | { ok: false; error: string };
