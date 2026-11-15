import { afterEach, describe, expect, it } from 'vitest';
import { renderArenaPrompt } from '../../src/shared/arenaPrompt.js';
import { DEFAULT_ARENA_ADAPTER_CONFIG, type ArenaAdapterConfig, type ArenaPageStatus, type CaptureResult, type ContentEvent, type SubmitPromptResult } from '../../src/shared/messages.js';
import { createArenaAdapter, promptProbes, taskNeedles, type ArenaAdapter } from '../../src/extension/content/arenaAdapter.js';
import { createFakeArena, type FakeArena, type FakeArenaOptions } from '../helpers/fakeArena.js';
import { waitFor } from '../helpers/harness.js';

const CONFIG: ArenaAdapterConfig = { ...DEFAULT_ARENA_ADAPTER_CONFIG, settleMs: 60, maxWaitMs: 4_000 };
const TIMING = { afterFillMs: 5, submitConfirmMs: 300, pollMs: 15, progressMs: 15, anchorWaitMs: 250 };

const PROMPT = renderArenaPrompt({
  task: {
    id: 'T-3',
    title: 'Add the login form',
    instructions: 'Create src/components/LoginForm.tsx with email and password fields.\nValidate both fields before submitting.',
    context: 'Vite + React + TypeScript project. Components live in src/components.',
    acceptanceCriteria: ['`npm test` passes', 'The form renders at /login without console errors'],
  },
  projectName: 'Demo app',
  constraints: ['Do not add runtime dependencies'],
});

let pages: FakeArena[] = [];
let adapters: ArenaAdapter[] = [];
afterEach(() => {
  adapters.forEach((a) => a.dispose());
  pages.forEach((p) => p.close());
  pages = [];
  adapters = [];
});

function setup(options: FakeArenaOptions = {}, config: ArenaAdapterConfig = CONFIG) {
  const page = createFakeArena(options);
  const events: ContentEvent[] = [];
  const adapter = createArenaAdapter({ doc: page.doc, win: page.win, emit: (e) => events.push(e), timing: TIMING });
  pages.push(page);
  adapters.push(adapter);
  const ids = { projectId: 'p_1', taskId: 'T-3', dispatchId: 'd-1' };
  return {
    page,
    events,
    adapter,
    ping: () => adapter.handle({ type: 'agentlink:arena:ping', config }) as Promise<ArenaPageStatus>,
    submit: (prompt = PROMPT) => adapter.handle({ type: 'agentlink:arena:submit', ...ids, prompt, config }) as Promise<SubmitPromptResult>,
    watch: (prompt = PROMPT) => adapter.handle({ type: 'agentlink:arena:watch', ...ids, prompt, config }),
    capture: (prompt = PROMPT) => adapter.handle({ type: 'agentlink:arena:capture', prompt, config }) as Promise<CaptureResult>,
    response: () => events.find((e) => e.type === 'agentlink:arena:response') as Extract<ContentEvent, { type: 'agentlink:arena:response' }> | undefined,
  };
}

describe('recognising the Arena page', () => {
  it('reports what it found without touching the page', async () => {
    const t = setup();
    const status = await t.ping();
    expect(status).toEqual({
      ok: true,
      url: 'https://arena.ai/c/abc123',
      title: 'Arena — Agent Mode',
      agentMode: true,
      composerFound: true,
      sendButtonFound: true,
      busy: false,
      watchingDispatchId: null,
    });
    expect(t.page.composerText()).toBe('');
    expect(t.page.sent).toEqual([]);
  });

  it('says so when another mode is selected, and does not guess when the page gives no signal', async () => {
    expect((await setup({ agentModeSelected: false }).ping()).agentMode).toBe(false);
    const unknown = setup();
    unknown.page.doc.querySelector('[role="tablist"]')?.remove();
    expect((await unknown.ping()).agentMode).toBeNull();
    expect((await setup({ path: '/agent/session-9', agentModeSelected: false }).ping()).agentMode).toBe(true);
  });

  it('reports a missing message box instead of pretending', async () => {
    const t = setup();
    t.page.doc.getElementById('composer-form')?.remove();
    const status = await t.ping();
    expect(status.composerFound).toBe(false);
    expect(status.sendButtonFound).toBe(false);
    const result = await t.submit();
    expect(result).toMatchObject({ ok: false, submitted: false });
    expect(t.page.sent).toEqual([]);
  });

  it('honours selector overrides and tolerates invalid ones', async () => {
    const page = setup({}, { ...CONFIG, composerSelector: '#does-not-exist' });
    expect((await page.ping()).composerFound).toBe(false);
    const broken = setup({}, { ...CONFIG, composerSelector: '!!not a selector' });
    expect((await broken.ping()).composerFound).toBe(false);
    const explicit = setup({}, { ...CONFIG, composerSelector: '#composer-slot textarea', sendButtonSelector: '#send' });
    expect(await explicit.ping()).toMatchObject({ composerFound: true, sendButtonFound: true });
  });

  it('ignores a search box when looking for the message box', async () => {
    const t = setup();
    const search = t.page.doc.createElement('textarea');
    search.setAttribute('placeholder', 'Search conversations');
    t.page.doc.querySelector('footer')?.append(search);
    await t.submit();
    expect(t.page.sent).toEqual([PROMPT]);
    expect(search.value).toBe('');
  });
});

describe('sending a task', () => {
  it('types the exact task into the message box and confirms that Arena accepted it', async () => {
    const t = setup();
    const result = await t.submit();
    expect(result).toEqual({ ok: true, confirmed: true });
    expect(t.page.sent).toEqual([PROMPT]);
    expect(t.page.composerText()).toBe('');
  });

  it('works with a rich-text (contenteditable) message box', async () => {
    const t = setup({ composer: 'contenteditable' });
    expect(await t.submit()).toEqual({ ok: true, confirmed: true });
    expect(t.page.sent).toHaveLength(1);
    expect(t.page.sent[0]?.replace(/\s+/g, ' ')).toBe(PROMPT.replace(/\s+/g, ' '));
  });

  it('falls back to the Enter key when there is no send button', async () => {
    const t = setup({ noSendButton: true });
    expect((await t.ping()).sendButtonFound).toBe(false);
    expect(await t.submit()).toEqual({ ok: true, confirmed: true });
    expect(t.page.sent).toEqual([PROMPT]);
  });

  it('recognises the sent task when the page renders it as markdown', async () => {
    const t = setup({ renderMarkdown: true });
    expect(await t.submit()).toEqual({ ok: true, confirmed: true });
  });

  it('reports "not sent" and leaves no draft behind when Arena does not take the message', async () => {
    const t = setup({ onSend: 'ignore' });
    const result = await t.submit();
    expect(result).toMatchObject({ ok: false, submitted: false });
    expect((result as { error: string }).error).toContain('Nothing was sent');
    expect(t.page.sent).toEqual([]);
    expect(t.page.composerText()).toBe('');
  });

  it('reports "unknown" — never "sent" — when the box empties but no message appears', async () => {
    const t = setup({ onSend: 'swallow' });
    const result = await t.submit();
    expect(result).toMatchObject({ ok: false, submitted: 'unknown' });
    expect((result as { error: string }).error).toContain('Check the Arena tab');
  });

  it('refuses to overwrite a draft the user is typing', async () => {
    const t = setup();
    const area = t.page.doc.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'my half-written note';
    const result = await t.submit();
    expect(result).toMatchObject({ ok: false, submitted: false });
    expect(area.value).toBe('my half-written note');
    expect(t.page.sent).toEqual([]);
  });

  it('refuses to send while Arena is still working on something else', async () => {
    const t = setup();
    const stop = t.page.doc.createElement('button');
    stop.textContent = 'Stop';
    t.page.doc.querySelector('main')?.append(stop);
    expect((await t.ping()).busy).toBe(true);
    const result = await t.submit();
    expect(result).toMatchObject({ ok: false, submitted: false });
    expect(t.page.sent).toEqual([]);
  });

  it('does not send a task that the message box would truncate', async () => {
    const t = setup({ maxLength: 120 });
    const result = await t.submit();
    expect(result).toMatchObject({ ok: false, submitted: false });
    expect((result as { error: string }).error).toMatch(/kept only 1[12]\d of \d+ characters/);
    expect(t.page.sent).toEqual([]);
    expect(t.page.composerText()).toBe('');
  });
});

describe('reading Arena’s reply', () => {
  it('waits until Arena has finished, then reports the complete visible reply', async () => {
    const t = setup();
    t.page.seedHistory('An earlier question about something unrelated.', 'An earlier answer that must not be captured.');
    await t.submit();
    await t.watch();
    expect((await t.ping()).watchingDispatchId).toBe('d-1');

    const pieces = ['Created src/components/LoginForm.tsx.', 'Ran npm test: 14 passed, 0 failed.', 'The form renders at /login.'];
    const replying = t.page.reply(pieces, 40);
    await waitFor(() => t.events.some((e) => e.type === 'agentlink:arena:progress'), 'a progress event');
    // Nothing is reported as a reply while Arena is still working.
    expect(t.response()).toBeUndefined();
    await replying;
    await waitFor(() => t.response() !== undefined, 'the reply');

    const reply = t.response()!;
    expect(reply).toMatchObject({ projectId: 'p_1', taskId: 'T-3', dispatchId: 'd-1' });
    expect(reply.text).toBe(`Agent\n${pieces.join('\n')}`);
    expect(reply.text).not.toContain('earlier answer');
    expect(reply.text).not.toContain('Copy');
    expect(reply.text).not.toContain('Arena can make mistakes');
    expect(reply.text).not.toContain('Older conversation');
    expect((await t.ping()).watchingDispatchId).toBeNull();

    const progress = t.events.filter((e) => e.type === 'agentlink:arena:progress');
    expect(progress.some((e) => e.type === 'agentlink:arena:progress' && e.generating)).toBe(true);
  });

  it('waits longer when the page never shows a "working" signal', async () => {
    const t = setup({ showStop: false });
    await t.submit();
    await t.watch();
    await t.page.reply(['Part one of the answer.'], 10);
    // One settle period of silence is not enough without a busy signal…
    await new Promise((resolve) => setTimeout(resolve, CONFIG.settleMs + 40));
    expect(t.response()).toBeUndefined();
    // …three are.
    await waitFor(() => t.response() !== undefined, 'the reply after the longer quiet period');
    expect(t.response()?.text).toContain('Part one of the answer.');
  });

  it('only reads the reply that follows this task, using a configured reply selector when given', async () => {
    const t = setup({}, { ...CONFIG, responseSelector: '.agent-message' });
    t.page.seedHistory('Old question', 'Old answer that belongs to another task.');
    await t.submit();
    await t.watch();
    await t.page.reply(['Done. All checks pass.'], 10);
    await waitFor(() => t.response() !== undefined, 'the reply');
    expect(t.response()?.text).toBe('Done. All checks pass.');
  });

  it('captures on request, and refuses when the task is not in this tab', async () => {
    const t = setup();
    t.page.seedHistory('Unrelated question', 'Unrelated answer.');
    const missing = await t.capture();
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toContain('was not found in the Arena tab');

    await t.submit();
    expect(await t.capture()).toEqual({ ok: false, error: 'Arena has not replied to this task yet.' });
    await t.page.reply(['Implemented and tested.'], 5);
    const captured = await t.capture();
    expect(captured).toEqual({ ok: true, text: 'Agent\nImplemented and tested.' });
  });

  it('is not fooled by a reply that mentions the task by name', async () => {
    const t = setup({ renderMarkdown: true });
    await t.submit();
    await t.page.reply(['Task T-3: Add the login form — final report', 'Everything listed was implemented; npm test passes with 14 tests.'], 5);
    const captured = await t.capture();
    expect(captured.ok).toBe(true);
    // The whole reply is read, starting at its first line — not only what follows the echoed heading.
    expect((captured as { text: string }).text).toContain('Task T-3: Add the login form — final report');
    expect((captured as { text: string }).text).toContain('npm test passes with 14 tests');
  });

  it('uses the most recent copy when the same task appears twice in the conversation', async () => {
    const t = setup();
    await t.submit();
    await t.page.reply(['First attempt: failed with a build error.'], 5);
    await t.submit();
    await t.page.reply(['Second attempt: build and tests pass.'], 5);
    expect(t.page.sent).toHaveLength(2);
    const captured = await t.capture();
    expect((captured as { text: string }).text).toBe('Agent\nSecond attempt: build and tests pass.');
  });

  it('gives up with a timeout event — not a made-up reply — when the task never appears', async () => {
    const t = setup();
    t.page.seedHistory('Something else', 'Some other answer.');
    await t.watch();
    await waitFor(() => t.events.some((e) => e.type === 'agentlink:arena:timeout'), 'the timeout');
    expect(t.response()).toBeUndefined();
    expect(t.events.find((e) => e.type === 'agentlink:arena:timeout')).toMatchObject({ chars: 0, taskId: 'T-3' });
  });

  it('times out while Arena is still working, keeping what it has for a manual capture', async () => {
    const t = setup({}, { ...CONFIG, maxWaitMs: 150 });
    await t.submit();
    await t.watch();
    void t.page.reply(['Still going…', 'and going…', 'and going…', 'and going…', 'and going…', 'and going…', 'and going…'], 60);
    await waitFor(() => t.events.some((e) => e.type === 'agentlink:arena:timeout'), 'the timeout');
    expect(t.response()).toBeUndefined();
    const timeout = t.events.find((e) => e.type === 'agentlink:arena:timeout');
    expect(timeout && timeout.type === 'agentlink:arena:timeout' && timeout.chars).toBeGreaterThan(0);
  });

  it('stops watching when cancelled', async () => {
    const t = setup();
    await t.submit();
    await t.watch();
    await t.adapter.handle({ type: 'agentlink:arena:cancel', dispatchId: 'another-dispatch' });
    expect((await t.ping()).watchingDispatchId).toBe('d-1');
    await t.adapter.handle({ type: 'agentlink:arena:cancel', dispatchId: 'd-1' });
    expect((await t.ping()).watchingDispatchId).toBeNull();
    await t.page.reply(['A reply nobody is waiting for.'], 5);
    await new Promise((resolve) => setTimeout(resolve, CONFIG.settleMs * 4));
    expect(t.events).toEqual([]);
  });
});

describe('prompt fingerprints', () => {
  it('derives the task heading and stable passages from the prompt', () => {
    expect(taskNeedles(PROMPT)).toEqual({ full: 'Task T-3: Add the login form', short: 'Task T-3:' });
    const probes = promptProbes(PROMPT);
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(PROMPT.replace(/\s+/g, ' ')).toContain(probe);
    expect(taskNeedles('hello there')).toEqual({ full: 'hello there', short: '' });
  });
});
