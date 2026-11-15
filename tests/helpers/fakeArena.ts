import { JSDOM } from 'jsdom';
import type { PageWindow } from '../../src/extension/content/arenaAdapter.js';

export interface FakeArenaOptions {
  /** How the message box is built. */
  composer?: 'textarea' | 'contenteditable';
  /** Render the user's message the way a markdown chat does (headings and list items become elements). */
  renderMarkdown?: boolean;
  /** `ignore`: the send control does nothing. `swallow`: the box is emptied but no message appears. */
  onSend?: 'accept' | 'ignore' | 'swallow';
  /** Whether a "Stop" control is shown while the agent works. */
  showStop?: boolean;
  /** Maximum characters the box accepts. */
  maxLength?: number;
  /** Hide the send button entirely so only the Enter key can submit. */
  noSendButton?: boolean;
  agentModeSelected?: boolean;
  path?: string;
}

export interface FakeArena {
  dom: JSDOM;
  win: PageWindow;
  doc: Document;
  /** Texts of the messages the page accepted, in order. */
  sent: string[];
  composerText(): string;
  /** Streams an agent reply in pieces; resolves when the page shows it as finished. */
  reply(pieces: string[], intervalMs?: number): Promise<void>;
  /** Adds earlier conversation so the page is not empty. */
  seedHistory(userText: string, agentText: string): void;
  close(): void;
}

const PAGE = `<!doctype html>
<html><head><title>Arena — Agent Mode</title></head>
<body>
  <nav aria-label="Conversations">
    <button type="button">New chat</button>
    <a href="/c/older">Older conversation about something else</a>
  </nav>
  <main>
    <div role="tablist">
      <button role="tab" id="tab-agent">Agent Mode</button>
      <button role="tab" id="tab-battle">Battle</button>
    </div>
    <div id="thread"></div>
    <form id="composer-form">
      <div id="composer-slot"></div>
      <button type="button" aria-label="Attach file">+</button>
      <button type="submit" id="send" aria-label="Send message" disabled>↑</button>
    </form>
  </main>
  <footer>Arena can make mistakes.</footer>
</body></html>`;

/** A small stand-in for an Arena conversation page, behaving like a framework-driven chat UI. */
export function createFakeArena(options: FakeArenaOptions = {}): FakeArena {
  const {
    composer = 'textarea',
    renderMarkdown = false,
    onSend = 'accept',
    showStop = true,
    maxLength,
    noSendButton = false,
    agentModeSelected = true,
    path = '/c/abc123',
  } = options;
  const dom = new JSDOM(PAGE, { url: `https://arena.ai${path}`, pretendToBeVisual: true });
  const win = dom.window as unknown as PageWindow;
  const doc = dom.window.document;
  const thread = doc.getElementById('thread') as HTMLElement;
  const form = doc.getElementById('composer-form') as HTMLFormElement;
  const send = doc.getElementById('send') as HTMLButtonElement;
  const sent: string[] = [];

  doc.getElementById(agentModeSelected ? 'tab-agent' : 'tab-battle')?.setAttribute('aria-selected', 'true');
  if (noSendButton) send.remove();

  let box: HTMLElement;
  if (composer === 'textarea') {
    const area = doc.createElement('textarea');
    area.setAttribute('placeholder', 'Describe a task for the agent');
    if (maxLength) area.maxLength = maxLength;
    box = area;
  } else {
    box = doc.createElement('div');
    box.setAttribute('contenteditable', 'true');
    box.setAttribute('role', 'textbox');
    box.setAttribute('aria-label', 'Message the agent');
  }
  (doc.getElementById('composer-slot') as HTMLElement).append(box);

  // Like a controlled component: the page's own state only changes on input events.
  let state = '';
  const read = (): string => (composer === 'textarea' ? (box as HTMLTextAreaElement).value : (box.textContent ?? ''));
  const write = (value: string): void => {
    if (composer === 'textarea') (box as HTMLTextAreaElement).value = value;
    else box.textContent = value;
  };
  box.addEventListener('input', () => {
    state = maxLength ? read().slice(0, maxLength) : read();
    if (maxLength && read() !== state) write(state);
    send.disabled = state.trim().length === 0;
  });

  function renderUserMessage(text: string): HTMLElement {
    const row = doc.createElement('div');
    row.className = 'row user';
    const who = doc.createElement('span');
    who.textContent = 'You';
    const bubble = doc.createElement('div');
    bubble.className = 'bubble';
    if (!renderMarkdown) {
      bubble.style.whiteSpace = 'pre-wrap';
      bubble.textContent = text;
    } else {
      let list: HTMLElement | null = null;
      for (const line of text.split('\n')) {
        const heading = /^(#+)\s+(.*)$/.exec(line);
        const item = /^-\s+(.*)$/.exec(line);
        if (!item) list = null;
        if (heading) {
          const h = doc.createElement(`h${Math.min(6, heading[1]?.length ?? 1)}`);
          h.textContent = heading[2] ?? '';
          bubble.append(h);
        } else if (item) {
          if (!list) {
            list = doc.createElement('ul');
            bubble.append(list);
          }
          const li = doc.createElement('li');
          li.textContent = item[1] ?? '';
          list.append(li);
        } else if (line.trim()) {
          const p = doc.createElement('p');
          p.textContent = line;
          bubble.append(p);
        }
      }
    }
    row.append(who, bubble);
    return row;
  }

  function submit(): void {
    const text = state;
    if (!text.trim() || onSend === 'ignore') return;
    state = '';
    write('');
    send.disabled = true;
    if (onSend === 'swallow') return;
    sent.push(text);
    thread.append(renderUserMessage(text));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  box.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter' && !(event as KeyboardEvent).shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  function agentRow(): { row: HTMLElement; body: HTMLElement } {
    const row = doc.createElement('div');
    row.className = 'row agent';
    const who = doc.createElement('span');
    who.textContent = 'Agent';
    const body = doc.createElement('div');
    body.className = 'agent-message';
    row.append(who, body);
    return { row, body };
  }

  return {
    dom,
    win,
    doc,
    sent,
    composerText: read,
    seedHistory(userText: string, agentText: string): void {
      thread.append(renderUserMessage(userText));
      const { row, body } = agentRow();
      body.textContent = agentText;
      thread.append(row);
    },
    async reply(pieces: string[], intervalMs = 15): Promise<void> {
      const { row, body } = agentRow();
      thread.append(row);
      let stop: HTMLElement | null = null;
      if (showStop) {
        stop = doc.createElement('button');
        stop.setAttribute('type', 'button');
        stop.setAttribute('aria-label', 'Stop generating');
        stop.textContent = '■';
        form.append(stop);
      }
      for (const piece of pieces) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const p = doc.createElement('p');
        p.textContent = piece;
        body.append(p);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      stop?.remove();
      const copy = doc.createElement('button');
      copy.setAttribute('type', 'button');
      copy.textContent = 'Copy';
      row.append(copy);
    },
    close(): void {
      dom.window.close();
    },
  };
}
