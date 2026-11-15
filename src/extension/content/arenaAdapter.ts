/**
 * The Arena adapter: everything AgentLink does inside an Arena tab.
 *
 * It types a task into Arena's composer, confirms that Arena accepted it, and
 * reads Arena's visible reply. It never invents a result: a reply is only
 * reported when it can be tied to the task that was sent (the task's own
 * message is located in the page and only what follows it is read), and
 * uncertainty is reported as uncertainty.
 *
 * The adapter keeps no state. Every request is answered from what the page
 * shows at that moment, so reloading the page, navigating inside Arena or
 * restarting the extension never loses track of a task: the background script
 * simply asks again.
 *
 * Arena's markup is not a public contract, so elements are found by role and
 * behaviour rather than by class names, and every selector can be overridden
 * in AgentLink's settings.
 */
import { hasCompletionMarker } from '../../shared/arenaPrompt.js';
import { digestOf } from '../../shared/text.js';
import type { ArenaAdapterConfig, ArenaPageStatus, CaptureResult, ContentRequest, ProbeResult, SubmitPromptResult } from '../../shared/messages.js';
import { CHROME_SELECTOR, collapse, extractText, isVisible } from './domText.js';

export interface AdapterTiming {
  /** Pause after typing so the page's framework can enable its send control. */
  afterFillMs: number;
  /** How long to wait for evidence that Arena accepted the message. */
  submitConfirmMs: number;
  pollMs: number;
}

export const DEFAULT_TIMING: AdapterTiming = {
  afterFillMs: 250,
  submitConfirmMs: 12_000,
  pollMs: 1_000,
};

/** The page's window, including its constructors (events and DOM classes must come from the page's own realm). */
export type PageWindow = Window & typeof globalThis;

export interface AdapterEnv {
  doc: Document;
  win: PageWindow;
  timing?: Partial<AdapterTiming>;
}

export interface ArenaAdapter {
  handle(request: ContentRequest): Promise<unknown>;
}

export const MAX_RESPONSE_CHARS = 1_000_000;
const SEND_LABEL = /\b(send|submit|run|start|ask|go)\b/i;
const NOT_SEND_LABEL = /\b(stop|cancel|attach|upload|file|image|voice|mic|record|new chat|settings|menu|model|share|copy|retry|regenerate)\b/i;
const BUSY_LABEL = /^(stop|interrupt|abort|cancel)\b|\bstop (generating|response|streaming|agent|task|run)/i;
const COMPOSER_HINT = /\b(ask|message|prompt|task|describe|build|type|tell|what|chat|reply|instruct)/i;

export interface TaskAnchor {
  el: Element;
  match: NonNullable<ProbeResult['match']>;
}

/** Letters only, lower case: the same for a prompt as typed and as a page renders it (headings, lists, emphasis). */
function lettersOnly(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}]+/gu, '');
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
   * Climbs from an element inside the sent message to the smallest element that holds the whole message,
   * without swallowing what comes after it. Going one level up is accepted while the text that it adds is
   * either trivial (a name, a time, "Show more") or recognisably part of the prompt.
   */
  function messageOf(start: Element, prompt: string, stop: (up: Element) => boolean = () => false): Element {
    const promptLength = collapse(prompt).length;
    const promptLetters = lettersOnly(prompt);
    const probes = promptProbes(prompt);
    let message = start;
    for (;;) {
      const content = collapse(message.textContent ?? '');
      const whole = content.length >= promptLength * 0.8 || (probes.length > 0 && probes.every((probe) => content.includes(probe)));
      if (whole) break;
      const up = message.parentElement;
      if (!up || up === doc.body || up === doc.documentElement) break;
      const upText = collapse(up.textContent ?? '');
      if (upText.length > promptLength * 1.25 + 160) break;
      if (stop(up)) break;
      const at = upText.indexOf(content);
      const added = lettersOnly(at >= 0 ? `${upText.slice(0, at)} ${upText.slice(at + content.length)}` : upText);
      if (added.length > 24) {
        const middle = Math.floor(added.length / 2);
        const samples = [added.slice(0, 24), added.slice(middle - 12, middle + 12), added.slice(-24)];
        // Text that is nowhere in the prompt belongs to another message (usually Arena's reply).
        if (samples.every((sample) => !promptLetters.includes(sample))) break;
      }
      message = up;
    }
    return message;
  }

  /** Visible text nodes of the conversation: not the composer, not page furniture such as a sidebar. */
  function conversationTextNodes(composer: HTMLElement | null, accept: (text: string) => boolean): { parent: Element; text: string }[] {
    const root = composer ? composerRoot(composer) : null;
    const found: { parent: Element; text: string }[] = [];
    const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = collapse(node.nodeValue ?? '');
      if (!text || !accept(text)) continue;
      const parent = node.parentElement;
      if (!parent || (root && root.contains(parent)) || parent.closest(CHROME_SELECTOR) || !isVisible(parent, win)) continue;
      found.push({ parent, text });
    }
    return found;
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
    const promptLength = collapse(prompt).length;
    const anchors: Element[] = [];
    for (const { parent, text } of conversationTextNodes(composer, (value) => value.includes(short))) {
      // The heading opens the message, either as raw text ("# Task T-1: …") or rendered as a heading.
      const lead = text.replace(/^#+\s*/, '');
      if (!lead.startsWith(short) && !collapse(parent.textContent ?? '').includes(full.slice(0, 40))) continue;
      // A message never contains another message: stop below anything that already holds a known one.
      const message = messageOf(parent, prompt, (up) => anchors.some((known) => up.contains(known)));
      const content = collapse(message.textContent ?? '');
      const isSentMessage = probes.length > 0 ? probes.some((probe) => content.includes(probe)) : content.length >= promptLength * 0.5;
      if (isSentMessage && !anchors.some((known) => known === message || known.contains(message))) anchors.push(message);
    }
    return anchors;
  }

  /**
   * Locates the message that carries this task, trying the strongest evidence first:
   *
   *  1. the reference code of the delivery attempt. It is unique, so it survives a page that shortens long
   *     messages. Arena repeats the code in the closing line of its report; that line is left out, and of
   *     the remaining places the one holding the most text of the task is the sent message;
   *  2. the task heading together with further passages of the prompt (also finds an earlier delivery
   *     attempt of the same task);
   *  3. the task heading alone, taking the first place it appears: a message always precedes its reply.
   */
  function findAnchor(prompt: string, ref: string, composer: HTMLElement | null): TaskAnchor | null {
    if (ref) {
      const places = conversationTextNodes(composer, (value) => value.includes(ref));
      // Arena repeats the code in its closing line. Those places are part of the reply, never of the message,
      // and the message must not be widened until it swallows them.
      const closing = places.filter((place) => hasCompletionMarker(place.text, ref)).map((place) => place.parent);
      const holdsReply = (up: Element): boolean => closing.some((line) => up.contains(line));
      let best: Element | null = null;
      let bestLength = 0;
      for (const { parent } of places) {
        if (closing.includes(parent)) continue;
        const message = messageOf(parent, prompt, holdsReply);
        const length = collapse(message.textContent ?? '').length;
        // A message precedes its reply, so of equally good places the first one wins.
        if (length > bestLength) {
          best = message;
          bestLength = length;
        }
      }
      // Anything as short as the code itself is a mention of it, not the message.
      if (best && bestLength > ref.length + 40) return { el: best, match: 'ref' };
    }
    const strong = findAnchors(prompt, composer).pop();
    if (strong) return { el: strong, match: 'prompt' };

    const { full, short } = taskNeedles(prompt);
    if (!short) return null;
    const heading = conversationTextNodes(composer, (value) => value.replace(/^#+\s*/, '').startsWith(short) && value.includes(full.slice(0, 40)))[0];
    return heading ? { el: messageOf(heading.parent, prompt), match: 'heading' } : null;
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
      composerDraft: composer ? collapse(composerText(composer)).slice(0, 160) : '',
    };
  }

  // ----------------------------------------------------------------- submit ---

  async function submit(prompt: string, ref: string, config: ArenaAdapterConfig): Promise<SubmitPromptResult> {
    const composer = findComposer(config);
    // Sending is idempotent: a task that is already in the conversation is never typed a second time.
    if (findAnchor(prompt, ref, composer)) return { ok: true, confirmed: true };
    if (!composer) {
      return { ok: false, submitted: false, error: "Arena's message box was not found in this tab. Open an Arena Agent Mode conversation, or set the composer selector in AgentLink settings." };
    }
    if (isBusy(config)) {
      return { ok: false, submitted: false, error: 'Arena is still working on a previous request in this tab. AgentLink sends the task when Arena is free.' };
    }
    const draft = collapse(composerText(composer));
    // Text left behind by an earlier attempt of this same task is simply replaced; anything else is a person's draft.
    const ownLeftover = draft.length > 0 && draft.includes(taskNeedles(prompt).full.slice(0, 40));
    if (draft && !ownLeftover) {
      return { ok: false, submitted: false, error: "Arena's message box already contains text. Clear or send it; AgentLink does not overwrite a draft and sends the task as soon as the box is empty." };
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
            : "AgentLink could not type into Arena's message box. Set the composer selector in AgentLink settings if the box was not recognised.",
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
      if (findAnchors(prompt, current).length > anchorsBefore || findAnchor(prompt, ref, current)?.match === 'ref') return { ok: true, confirmed: true };
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
        error: "Arena's message box was emptied, but the task did not appear in the conversation yet.",
      };
    }
    // Nothing happened: take the text back out so the task can be retried without leaving a stray draft.
    setComposer(composer, '');
    const removed = !collapse(composerText(composer));
    return {
      ok: false,
      submitted: removed ? false : 'unknown',
      error: removed
        ? 'Arena did not accept the message (its send control did not respond). Nothing was sent. If this keeps happening, set the send-button selector in AgentLink settings.'
        : 'Arena did not confirm the message and the text is still in its message box.',
    };
  }

  // ---------------------------------------------------------------- reading ---

  /** What the page shows for this task right now. Called every few seconds by the background script. */
  function probe(prompt: string, ref: string, config: ArenaAdapterConfig): ProbeResult {
    const composer = findComposer(config);
    const anchor = findAnchor(prompt, ref, composer);
    const text = anchor ? responseAfter(anchor.el, composer, config) : '';
    return {
      ok: true,
      url: win.location.href,
      found: anchor !== null,
      match: anchor?.match ?? null,
      busy: isBusy(config),
      chars: text.length,
      digest: digestOf(text),
      marker: text.length > 0 && hasCompletionMarker(text, ref),
      composerHoldsPrompt: composer !== null && holdsPrompt(composer, prompt),
    };
  }

  function capture(prompt: string, ref: string, config: ArenaAdapterConfig): CaptureResult {
    const composer = findComposer(config);
    const anchor = findAnchor(prompt, ref, composer);
    if (!anchor) {
      return { ok: false, error: 'This task was not found in the Arena tab, so its reply cannot be identified. Open the conversation it was sent in.' };
    }
    const text = responseAfter(anchor.el, composer, config);
    if (!text) return { ok: false, error: 'Arena has not replied to this task yet.' };
    return { ok: true, text, marker: hasCompletionMarker(text, ref), busy: isBusy(config) };
  }

  return {
    async handle(request: ContentRequest): Promise<unknown> {
      const ref = 'ref' in request && typeof request.ref === 'string' ? request.ref : '';
      switch (request.type) {
        case 'agentlink:arena:ping':
          return status(request.config);
        case 'agentlink:arena:submit':
          return submit(request.prompt, ref, request.config);
        case 'agentlink:arena:probe':
          return probe(request.prompt, ref, request.config);
        case 'agentlink:arena:capture':
          return capture(request.prompt, ref, request.config);
        default:
          return undefined;
      }
    },
  };
}
