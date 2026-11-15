/**
 * The Arena adapter: everything AgentLink does inside an Arena tab.
 *
 * It types an approved task into Arena's composer, confirms that Arena
 * accepted it, and reads Arena's visible reply. It never invents a result:
 * a reply is only reported when it can be tied to the task that was sent
 * (the task's own heading is located in the page and only what follows it is
 * read), and uncertainty is reported as uncertainty.
 *
 * Arena's markup is not a public contract, so elements are found by role and
 * behaviour rather than by class names, and every selector can be overridden
 * in AgentLink's settings.
 */
import type {
  ArenaAdapterConfig,
  ArenaPageStatus,
  CaptureResult,
  ContentEvent,
  ContentRequest,
  SubmitPromptResult,
} from '../../shared/messages.js';
import { collapse, extractText, isVisible } from './domText.js';

export interface AdapterTiming {
  /** Pause after typing so the page's framework can enable its send control. */
  afterFillMs: number;
  /** How long to wait for evidence that Arena accepted the message. */
  submitConfirmMs: number;
  pollMs: number;
  /** Minimum gap between progress notifications. */
  progressMs: number;
  /** How long to look for the task in the page before giving up watching. */
  anchorWaitMs: number;
}

export const DEFAULT_TIMING: AdapterTiming = {
  afterFillMs: 250,
  submitConfirmMs: 12_000,
  pollMs: 1_000,
  progressMs: 2_000,
  anchorWaitMs: 90_000,
};

/** The page's window, including its constructors (events and DOM classes must come from the page's own realm). */
export type PageWindow = Window & typeof globalThis;

export interface AdapterEnv {
  doc: Document;
  win: PageWindow;
  emit: (event: ContentEvent) => void;
  timing?: Partial<AdapterTiming>;
}

export interface ArenaAdapter {
  handle(request: ContentRequest): Promise<unknown>;
  dispose(): void;
}

const MAX_RESPONSE_CHARS = 400_000;
const SEND_LABEL = /\b(send|submit|run|start|ask|go)\b/i;
const NOT_SEND_LABEL = /\b(stop|cancel|attach|upload|file|image|voice|mic|record|new chat|settings|menu|model|share|copy|retry|regenerate)\b/i;
const BUSY_LABEL = /^(stop|interrupt|abort|cancel)\b|\bstop (generating|response|streaming|agent|task|run)/i;
const COMPOSER_HINT = /\b(ask|message|prompt|task|describe|build|type|tell|what|chat|reply|instruct)/i;

interface Watch {
  projectId: string;
  taskId: string;
  dispatchId: string;
  prompt: string;
  config: ArenaAdapterConfig;
  startedAt: number;
  lastText: string;
  lastActivityAt: number;
  lastProgressAt: number;
  lastReportedChars: number;
  lastReportedBusy: boolean;
  sawBusy: boolean;
  timer: number;
}

function safeQuery(root: ParentNode, selector: string): Element[] {
  if (!selector.trim()) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function accessibleName(el: Element): string {
  return collapse([el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.textContent].filter(Boolean).join(' '));
}

/** The line that identifies a task inside the page, e.g. "Task T-3: Add the login form". */
export function taskNeedles(prompt: string): { full: string; short: string } {
  const firstLine = collapse((prompt.split('\n').find((line) => line.trim()) ?? '').replace(/^#+\s*/, ''));
  const id = /^Task\s+[A-Za-z]+-\d+:/.exec(firstLine)?.[0] ?? '';
  return { full: firstLine.slice(0, 120), short: id };
}

/** Plain passages of the prompt that survive markdown rendering unchanged; used to recognise the sent message. */
export function promptProbes(prompt: string): string[] {
  const lines = prompt
    .split('\n')
    .slice(1)
    .map((line) => collapse(line.replace(/^\s*(?:[-+]|\d+\.)\s+/, '')))
    .filter((line) => line.length >= 30 && !/[*_`#[\]<>|~\\]/.test(line));
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return [];
  const probes = [first.slice(0, 60), last.slice(-60)];
  return probes[0] === probes[1] ? [probes[0] as string] : probes;
}

export function createArenaAdapter(env: AdapterEnv): ArenaAdapter {
  const { doc, win } = env;
  const timing: AdapterTiming = { ...DEFAULT_TIMING, ...env.timing };
  let watch: Watch | null = null;
  let lastMutationAt = 0;
  let observer: MutationObserver | null = null;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => win.setTimeout(resolve, ms));
  const now = (): number => Date.now();

  // ------------------------------------------------------------- locating ---

  function isEditable(el: Element): boolean {
    if (el instanceof win.HTMLTextAreaElement || (el as HTMLElement).tagName === 'TEXTAREA') {
      const area = el as HTMLTextAreaElement;
      return !area.disabled && !area.readOnly;
    }
    const editable = el.getAttribute('contenteditable');
    return editable === '' || editable === 'true' || editable === 'plaintext-only';
  }

  function findComposer(config: ArenaAdapterConfig): HTMLElement | null {
    const configured = safeQuery(doc, config.composerSelector).find((el) => isVisible(el, win));
    if (configured) return configured as HTMLElement;
    if (config.composerSelector.trim()) return null;

    const candidates = Array.from(doc.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')).filter(
      (el) => isEditable(el) && isVisible(el, win),
    );
    let best: HTMLElement | null = null;
    let bestScore = -Infinity;
    candidates.forEach((el, index) => {
      let score = index; // Later in the document wins ties: the composer sits below the conversation.
      const hint = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-placeholder'), el.getAttribute('name'), el.id].filter(Boolean).join(' ');
      if (COMPOSER_HINT.test(hint)) score += 100;
      if (el.closest('form')) score += 20;
      if (el.closest('[role="search"], [type="search"]') || /search|filter/i.test(hint)) score -= 200;
      if (el.closest('[role="dialog"]')) score -= 50;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) score += Math.min(60, rect.width / 10);
      if (score > bestScore) {
        bestScore = score;
        best = el as HTMLElement;
      }
    });
    return best;
  }

  /** The smallest container that holds the composer together with its controls. */
  function composerRoot(composer: HTMLElement): HTMLElement {
    const form = composer.closest('form');
    if (form) return form as HTMLElement;
    let node: HTMLElement = composer;
    for (let depth = 0; depth < 4 && node.parentElement && node.parentElement !== doc.body; depth += 1) {
      node = node.parentElement;
      if (node.querySelector('button, [role="button"]')) return node;
    }
    return composer;
  }

  function findSendButton(composer: HTMLElement, config: ArenaAdapterConfig): HTMLElement | null {
    const configured = safeQuery(doc, config.sendButtonSelector).find((el) => isVisible(el, win));
    if (configured) return configured as HTMLElement;
    if (config.sendButtonSelector.trim()) return null;

    const root = composerRoot(composer);
    const buttons = Array.from(root.querySelectorAll('button, [role="button"], input[type="submit"]')).filter((el) => isVisible(el, win)) as HTMLElement[];
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const button of buttons) {
      const name = accessibleName(button);
      if (NOT_SEND_LABEL.test(name)) continue;
      let score = 0;
      if (button.getAttribute('type') === 'submit') score += 3;
      if (SEND_LABEL.test(name)) score += 4;
      if (score > bestScore) {
        bestScore = score;
        best = button;
      }
    }
    return best;
  }

  function isDisabled(el: HTMLElement): boolean {
    return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  function isBusy(config: ArenaAdapterConfig): boolean {
    if (config.busySelector.trim()) return safeQuery(doc, config.busySelector).some((el) => isVisible(el, win));
    for (const el of Array.from(doc.querySelectorAll('button, [role="button"]'))) {
      const name = collapse([el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' '));
      if (name.length <= 40 && BUSY_LABEL.test(name) && isVisible(el, win) && !el.closest('[role="dialog"]')) return true;
    }
    return Array.from(doc.querySelectorAll('[aria-busy="true"], [data-streaming="true"], [data-is-streaming="true"], [data-state="streaming"]')).some((el) => isVisible(el, win));
  }

  function detectAgentMode(): boolean | null {
    if (/agent/i.test(win.location.pathname + win.location.search)) return true;
    const selected = Array.from(
      doc.querySelectorAll('[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"], [aria-current="page"], [aria-current="true"], [data-state="active"], [data-state="on"], [data-state="checked"]'),
    ).filter((el) => isVisible(el, win));
    if (selected.some((el) => /\bagent\b/i.test(accessibleName(el)))) return true;
    // A mode switch that is visibly set to something else is the only case reported as "not Agent Mode".
    if (selected.some((el) => /\b(battle|side by side|direct chat|chat mode)\b/i.test(accessibleName(el)))) return false;
    return null;
  }

  // ---------------------------------------------------------- composer I/O ---

  function composerText(composer: HTMLElement): string {
    if (composer.tagName === 'TEXTAREA') return (composer as HTMLTextAreaElement).value;
    return extractText(composer, { win });
  }

  function holdsPrompt(composer: HTMLElement, prompt: string): boolean {
    const current = collapse(composerText(composer));
    const wanted = collapse(prompt);
    return current.length >= wanted.length * 0.9 && current.includes(wanted.slice(0, 80));
  }

  function fireInput(el: HTMLElement, data: string | null, inputType: string): void {
    let event: Event;
    try {
      event = new win.InputEvent('input', { bubbles: true, cancelable: false, data, inputType });
    } catch {
      event = new win.Event('input', { bubbles: true });
    }
    el.dispatchEvent(event);
  }

  function setTextareaValue(area: HTMLTextAreaElement, value: string): void {
    // Frameworks such as React replace the `value` setter on the element; the prototype's setter updates the
    // real DOM value so that the following input event is seen as a genuine change.
    const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(area, value);
    else area.value = value;
    fireInput(area, value || null, value ? 'insertText' : 'deleteContentBackward');
    area.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  function selectContents(el: HTMLElement): void {
    const selection = win.getSelection();
    if (!selection) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function setEditableText(el: HTMLElement, value: string): void {
    el.focus();
    selectContents(el);
    const exec = (doc as Document & { execCommand?: (command: string, ui: boolean, value?: string) => boolean }).execCommand;

    // 1. The editing command path: what rich-text editors expect from real typing.
    if (typeof exec === 'function') {
      try {
        if (value) exec.call(doc, 'insertText', false, value);
        else exec.call(doc, 'delete', false);
      } catch {
        // Fall through to the next strategy.
      }
      if (value ? holdsPrompt(el, value) : !collapse(composerText(el))) return;
    }

    // 2. A paste event: editors that manage their own model read the clipboard payload.
    if (value && typeof win.DataTransfer === 'function' && typeof win.ClipboardEvent === 'function') {
      try {
        selectContents(el);
        const data = new win.DataTransfer();
        data.setData('text/plain', value);
        el.dispatchEvent(new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      } catch {
        // Fall through to the next strategy.
      }
      if (holdsPrompt(el, value)) return;
    }

    // 3. Plain DOM replacement for simple contenteditable boxes.
    el.textContent = value;
    fireInput(el, value || null, value ? 'insertText' : 'deleteContentBackward');
  }

  function setComposer(composer: HTMLElement, value: string): void {
    composer.focus();
    if (composer.tagName === 'TEXTAREA') setTextareaValue(composer as HTMLTextAreaElement, value);
    else setEditableText(composer, value);
  }

  function pressEnter(composer: HTMLElement): void {
    const init: KeyboardEventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      composer.dispatchEvent(new win.KeyboardEvent(type, init));
    }
  }

  // --------------------------------------------------------- reading replies ---

  function excluder(composer: HTMLElement | null): (el: Element) => boolean {
    const root = composer ? composerRoot(composer) : null;
    return (el) => el === root || el === composer;
  }

  /**
   * Finds the user messages in the conversation that carry this task. A match needs the task heading and, where
   * the prompt allows it, another passage of the prompt — so a reply from Arena that merely mentions the task
   * by name is not mistaken for the message that was sent.
   */
  function findAnchors(prompt: string, composer: HTMLElement | null): Element[] {
    const { full, short } = taskNeedles(prompt);
    if (!short) return [];
    const probes = promptProbes(prompt);
    const root = composer ? composerRoot(composer) : null;
    const promptLength = collapse(prompt).length;
    const anchors: Element[] = [];
    const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = collapse(node.nodeValue ?? '');
      if (!text.includes(short)) continue;
      const parent = node.parentElement;
      if (!parent || (root && root.contains(parent)) || !isVisible(parent, win)) continue;
      // The heading opens the message, either as raw text ("# Task T-1: …") or rendered as a heading.
      const lead = text.replace(/^#+\s*/, '');
      if (!lead.startsWith(short) && !collapse(parent.textContent ?? '').includes(full.slice(0, 40))) continue;

      // Climb to the smallest element that holds the whole message, without swallowing neighbouring messages.
      let message: Element = parent;
      for (;;) {
        const content = collapse(message.textContent ?? '');
        const whole = content.length >= promptLength * 0.8 || (probes.length > 0 && probes.every((probe) => content.includes(probe)));
        if (whole) break;
        const up = message.parentElement;
        if (!up || up === doc.body || collapse(up.textContent ?? '').length > promptLength * 1.25 + 160) break;
        // A message never contains another message: stop below anything that already holds a known one.
        if (anchors.some((known) => up.contains(known))) break;
        message = up;
      }
      const content = collapse(message.textContent ?? '');
      const isSentMessage = probes.length > 0 ? probes.some((probe) => content.includes(probe)) : content.length >= promptLength * 0.5;
      if (isSentMessage && !anchors.some((known) => known === message || known.contains(message))) anchors.push(message);
    }
    return anchors;
  }

  function responseAfter(anchor: Element, composer: HTMLElement | null, config: ArenaAdapterConfig): string {
    let text: string;
    if (config.responseSelector.trim()) {
      const following = safeQuery(doc, config.responseSelector).filter(
        (el) => (anchor.compareDocumentPosition(el) & 4) /* FOLLOWING */ !== 0 && !anchor.contains(el) && isVisible(el, win),
      );
      // Nested matches would repeat text, so only the outermost ones are read.
      const outer = following.filter((el) => !following.some((other) => other !== el && other.contains(el)));
      text = outer.map((el) => extractText(el, { win, skipChrome: true })).filter(Boolean).join('\n\n');
    } else {
      text = extractText(doc.body, { win, after: anchor, exclude: excluder(composer), skipChrome: true });
    }
    return text.length > MAX_RESPONSE_CHARS ? text.slice(0, MAX_RESPONSE_CHARS) : text;
  }

  // ----------------------------------------------------------------- status ---

  function status(config: ArenaAdapterConfig): ArenaPageStatus {
    const composer = findComposer(config);
    return {
      ok: true,
      url: win.location.href,
      title: doc.title,
      agentMode: detectAgentMode(),
      composerFound: composer !== null,
      sendButtonFound: composer !== null && findSendButton(composer, config) !== null,
      busy: isBusy(config),
      watchingDispatchId: watch?.dispatchId ?? null,
    };
  }

  // ----------------------------------------------------------------- submit ---

  async function submit(prompt: string, config: ArenaAdapterConfig): Promise<SubmitPromptResult> {
    const composer = findComposer(config);
    if (!composer) {
      return { ok: false, submitted: false, error: "Arena's message box was not found in this tab. Open an Arena Agent Mode conversation, or set the composer selector in AgentLink settings." };
    }
    if (isBusy(config)) {
      return { ok: false, submitted: false, error: 'Arena is still working on a previous request in this tab. Wait for it to finish, then send again.' };
    }
    if (collapse(composerText(composer))) {
      return { ok: false, submitted: false, error: "Arena's message box already contains text. Clear or send it first so AgentLink does not overwrite your draft." };
    }

    const anchorsBefore = findAnchors(prompt, composer).length;
    setComposer(composer, prompt);
    await sleep(timing.afterFillMs);

    if (!holdsPrompt(composer, prompt)) {
      const got = collapse(composerText(composer)).length;
      setComposer(composer, '');
      const cleared = !collapse(composerText(composer));
      return {
        ok: false,
        submitted: cleared ? false : 'unknown',
        error:
          got > 0
            ? `Arena's message box kept only ${got} of ${collapse(prompt).length} characters, so the task was not sent. It may be too long for Arena.`
            : "AgentLink could not type into Arena's message box. Use \"Send manually\" instead.",
      };
    }

    const button = findSendButton(composer, config);
    if (button && !isDisabled(button)) button.click();
    else pressEnter(composer);

    // Evidence that Arena took the message: the task appears in the conversation, or the box was emptied and
    // Arena started working.
    const deadline = now() + timing.submitConfirmMs;
    let clearedAt: number | null = null;
    while (now() < deadline) {
      await sleep(Math.min(200, timing.pollMs));
      const current = findComposer(config) ?? composer;
      if (findAnchors(prompt, current).length > anchorsBefore) return { ok: true, confirmed: true };
      const cleared = !current.isConnected || !holdsPrompt(current, prompt);
      if (cleared) {
        clearedAt ??= now();
        if (isBusy(config)) return { ok: true, confirmed: true };
      }
    }

    if (clearedAt !== null) {
      return {
        ok: false,
        submitted: 'unknown',
        error: "Arena's message box was emptied, but the task did not appear in the conversation. Check the Arena tab before sending anything again.",
      };
    }
    // Nothing happened: take the text back out so the task can be retried without leaving a stray draft.
    setComposer(composer, '');
    const removed = !collapse(composerText(composer));
    return {
      ok: false,
      submitted: removed ? false : 'unknown',
      error: removed
        ? 'Arena did not accept the message (its send control did not respond). Nothing was sent. Try again, set the send-button selector in settings, or use "Send manually".'
        : 'Arena did not confirm the message and the text is still in its message box. Check the Arena tab before sending anything again.',
    };
  }

  // ------------------------------------------------------------------ watch ---

  function stopWatch(): void {
    if (watch) win.clearTimeout(watch.timer);
    watch = null;
    observer?.disconnect();
    observer = null;
  }

  function tick(): void {
    const current = watch;
    if (!current) return;
    const { config } = current;
    const base = { projectId: current.projectId, taskId: current.taskId, dispatchId: current.dispatchId };
    const elapsed = now() - current.startedAt;
    const composer = findComposer(config);
    const anchor = findAnchors(current.prompt, composer).pop() ?? null;

    if (!anchor) {
      if (elapsed > timing.anchorWaitMs) {
        stopWatch();
        env.emit({ type: 'agentlink:arena:timeout', ...base, chars: 0 });
        return;
      }
      current.timer = win.setTimeout(tick, timing.pollMs);
      return;
    }

    const text = responseAfter(anchor, composer, config);
    const busy = isBusy(config);
    const time = now();
    if (text !== current.lastText) {
      current.lastText = text;
      current.lastActivityAt = time;
    }
    if (busy) {
      current.sawBusy = true;
      current.lastActivityAt = time;
    }
    const quietFor = time - Math.max(current.lastActivityAt, lastMutationAt);
    // If this page never showed a recognisable "working" signal, silence is weaker evidence that Arena has
    // finished, so a longer quiet period is required before the reply is treated as final.
    const required = current.sawBusy ? config.settleMs : config.settleMs * 3;

    if (text.length > 0 && !busy && quietFor >= required) {
      stopWatch();
      env.emit({ type: 'agentlink:arena:response', ...base, text });
      return;
    }
    if (elapsed > config.maxWaitMs) {
      stopWatch();
      env.emit({ type: 'agentlink:arena:timeout', ...base, chars: text.length });
      return;
    }
    const changed = text.length !== current.lastReportedChars || busy !== current.lastReportedBusy;
    if (changed && time - current.lastProgressAt >= timing.progressMs) {
      current.lastProgressAt = time;
      current.lastReportedChars = text.length;
      current.lastReportedBusy = busy;
      env.emit({ type: 'agentlink:arena:progress', ...base, generating: busy || quietFor < required, chars: text.length });
    }
    current.timer = win.setTimeout(tick, timing.pollMs);
  }

  function startWatch(request: Extract<ContentRequest, { type: 'agentlink:arena:watch' }>): { ok: true } {
    stopWatch();
    const time = now();
    lastMutationAt = time;
    watch = {
      projectId: request.projectId,
      taskId: request.taskId,
      dispatchId: request.dispatchId,
      prompt: request.prompt,
      config: request.config,
      startedAt: time,
      lastText: '',
      lastActivityAt: time,
      lastProgressAt: 0,
      lastReportedChars: -1,
      lastReportedBusy: false,
      sawBusy: false,
      timer: win.setTimeout(tick, timing.pollMs),
    };
    if (typeof win.MutationObserver === 'function') {
      let root: HTMLElement | null = null;
      let rootCheckedAt = 0;
      observer = new win.MutationObserver((records) => {
        const at = now();
        if (at - rootCheckedAt > 2_000 || (root && !root.isConnected)) {
          const composer = findComposer(request.config);
          root = composer ? composerRoot(composer) : null;
          rootCheckedAt = at;
        }
        // Typing in the composer is not Arena working.
        if (records.some((record) => !(root && root.contains(record.target)))) lastMutationAt = at;
      });
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    }
    return { ok: true };
  }

  function capture(prompt: string, config: ArenaAdapterConfig): CaptureResult {
    const composer = findComposer(config);
    const anchor = findAnchors(prompt, composer).pop() ?? null;
    if (!anchor) {
      return { ok: false, error: 'This task was not found in the Arena tab, so its reply cannot be identified. Open the conversation it was sent in, or paste the reply instead.' };
    }
    const text = responseAfter(anchor, composer, config);
    if (!text) return { ok: false, error: 'Arena has not replied to this task yet.' };
    return { ok: true, text };
  }

  return {
    async handle(request: ContentRequest): Promise<unknown> {
      switch (request.type) {
        case 'agentlink:arena:ping':
          return status(request.config);
        case 'agentlink:arena:submit':
          return submit(request.prompt, request.config);
        case 'agentlink:arena:watch':
          return startWatch(request);
        case 'agentlink:arena:capture':
          return capture(request.prompt, request.config);
        case 'agentlink:arena:cancel':
          if (!request.dispatchId || watch?.dispatchId === request.dispatchId) stopWatch();
          return { ok: true };
        default:
          return undefined;
      }
    },
    dispose: stopWatch,
  };
}
