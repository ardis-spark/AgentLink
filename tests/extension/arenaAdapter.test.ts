import { afterEach, describe, expect, it } from 'vitest';
import { arenaRef, hasCompletionMarker, renderArenaPrompt } from '../../src/shared/arenaPrompt.js';
import { DEFAULT_ARENA_ADAPTER_CONFIG, type ArenaAdapterConfig, type ArenaPageStatus, type CaptureResult, type ProbeResult, type SubmitPromptResult } from '../../src/shared/messages.js';
import { digestOf } from '../../src/shared/text.js';
import { createArenaAdapter, promptProbes, taskNeedles } from '../../src/extension/content/arenaAdapter.js';
import { createFakeArena, type FakeArena, type FakeArenaOptions } from '../helpers/fakeArena.js';

const CONFIG: ArenaAdapterConfig = { ...DEFAULT_ARENA_ADAPTER_CONFIG, settleMs: 60, maxWaitMs: 4_000 };
const TIMING = { afterFillMs: 5, submitConfirmMs: 300, pollMs: 15 };

const TASK = {
  id: 'T-3',
  title: 'Add the login form',
  instructions: 'Create src/components/LoginForm.tsx with email and password fields.\nValidate both fields before submitting.',
  context: 'Vite + React + TypeScript project. Components live in src/components.',
  acceptanceCriteria: ['`npm test` passes', 'The form renders at /login without console errors'],
};

/** The text of one delivery attempt of the task, with the reference code that identifies it. */
function promptFor(dispatchId: string): { prompt: string; ref: string } {
  const ref = arenaRef(TASK.id, dispatchId);
  return { ref, prompt: renderArenaPrompt({ task: TASK, projectName: 'Demo app', constraints: ['Do not add runtime dependencies'], ref }) };
}

const { prompt: PROMPT, ref: REF } = promptFor('0a1b2c3d-first-attempt');
const DONE = `AGENTLINK-DONE ${REF}`;

let pages: FakeArena[] = [];
afterEach(() => {
  pages.forEach((p) => p.close());
  pages = [];
});

function setup(options: FakeArenaOptions = {}, config: ArenaAdapterConfig = CONFIG) {
  const page = createFakeArena(options);
  const adapter = createArenaAdapter({ doc: page.doc, win: page.win, timing: TIMING });
  pages.push(page);
  return {
    page,
    adapter,
    ping: () => adapter.handle({ type: 'agentlink:arena:ping', config }) as Promise<ArenaPageStatus>,
    submit: (prompt = PROMPT, ref = REF) => adapter.handle({ type: 'agentlink:arena:submit', prompt, ref, config }) as Promise<SubmitPromptResult>,
    probe: (prompt = PROMPT, ref = REF) => adapter.handle({ type: 'agentlink:arena:probe', prompt, ref, config }) as Promise<ProbeResult>,
    capture: (prompt = PROMPT, ref = REF) => adapter.handle({ type: 'agentlink:arena:capture', prompt, ref, config }) as Promise<CaptureResult>,
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
      composerDraft: '',
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
    expect((result as { error: string }).error).toContain('did not appear in the conversation');
    // The page is the judge of what happened: the task is not there, and the box is empty.
    expect(await t.probe()).toMatchObject({ found: false, composerHoldsPrompt: false });
  });

  it('never types a task a second time when it is already in the conversation', async () => {
    const t = setup();
    expect(await t.submit()).toEqual({ ok: true, confirmed: true });
    expect(await t.submit()).toEqual({ ok: true, confirmed: true });
    // A new delivery attempt of the same task (new reference code) finds the earlier one as well.
    const retry = promptFor('ffffffff-second-attempt');
    expect(await t.submit(retry.prompt, retry.ref)).toEqual({ ok: true, confirmed: true });
    expect(t.page.sent).toEqual([PROMPT]);
  });

  it('replaces its own unsent text from an earlier attempt, but reports it first', async () => {
    const t = setup({ onSend: 'ignore' });
    const area = t.page.doc.querySelector('textarea') as HTMLTextAreaElement;
    area.value = PROMPT;
    expect(await t.probe()).toMatchObject({ found: false, composerHoldsPrompt: true });
    expect((await t.ping()).composerDraft).toContain('Task T-3: Add the login form');
    // Its own leftover is not treated as somebody's draft.
    const result = await t.submit();
    expect(result).toMatchObject({ ok: false, submitted: false });
    expect((result as { error: string }).error).toContain('Nothing was sent');
  });

  it('refuses to overwrite a draft the user is typing', async () => {
    const t = setup();
    const area = t.page.doc.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'my half-written note';
    const result = await t.submit();
    expect(result).toMatchObject({ ok: false, submitted: false });
    expect(area.value).toBe('my half-written note');
    expect(t.page.sent).toEqual([]);
    expect((await t.ping()).composerDraft).toBe('my half-written note');
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
  it('reports what the page shows for a task at any moment, without keeping any state of its own', async () => {
    const t = setup();
    t.page.seedHistory('An earlier question about something unrelated.', 'An earlier answer that must not be captured.');
    expect(await t.probe()).toMatchObject({ ok: true, found: false, match: null, chars: 0, marker: false, busy: false });

    await t.submit();
    const sent = await t.probe();
    expect(sent).toMatchObject({ found: true, match: 'ref', chars: 0, marker: false, composerHoldsPrompt: false });

    const pieces = ['Created src/components/LoginForm.tsx.', 'Ran npm test: 14 passed, 0 failed.', 'The form renders at /login.', DONE];
    const replying = t.page.reply(pieces, 40);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const during = await t.probe();
    // While Arena is writing: it is busy, some text is there, and the closing line is not.
    expect(during).toMatchObject({ found: true, busy: true, marker: false });
    expect(during.chars).toBeGreaterThan(0);
    await replying;

    const after = await t.probe();
    expect(after).toMatchObject({ found: true, busy: false, marker: true });
    expect(after.digest).not.toBe(during.digest);
    // Asking again gives the same answer: the reply has stopped changing.
    expect((await t.probe()).digest).toBe(after.digest);

    const captured = await t.capture();
    expect(captured).toEqual({ ok: true, text: `Agent\n${pieces.join('\n')}`, marker: true, busy: false });
    const text = (captured as { text: string }).text;
    expect(digestOf(text)).toBe(after.digest);
    expect(after.chars).toBe(text.length);
    expect(text).not.toContain('earlier answer');
    expect(text).not.toContain('Copy');
    expect(text).not.toContain('Arena can make mistakes');
    expect(text).not.toContain('Older conversation');
  });

  it('does not mistake the instruction to write the closing line for the closing line itself', async () => {
    const t = setup();
    await t.submit();
    expect(hasCompletionMarker(PROMPT, REF)).toBe(false);
    await t.page.reply(['Working on it. I will end with the completion line as asked.'], 5);
    expect(await t.probe()).toMatchObject({ found: true, marker: false });
    await t.page.reply([`**AGENTLINK-DONE** ${REF}`], 5);
    expect((await t.probe()).marker).toBe(true);
  });

  it('finds the task again in a fresh page, as after a browser restart', async () => {
    const first = setup();
    await first.submit();
    await first.page.reply(['Implemented and tested.', DONE], 5);
    // A new adapter on the same page knows nothing in advance and reads the same reply.
    const again = createArenaAdapter({ doc: first.page.doc, win: first.page.win, timing: TIMING });
    const probe = (await again.handle({ type: 'agentlink:arena:probe', prompt: PROMPT, ref: REF, config: CONFIG })) as ProbeResult;
    expect(probe).toMatchObject({ found: true, match: 'ref', marker: true, busy: false });
    const captured = (await again.handle({ type: 'agentlink:arena:capture', prompt: PROMPT, ref: REF, config: CONFIG })) as CaptureResult;
    expect(captured).toMatchObject({ ok: true, text: `Agent\nImplemented and tested.\n${DONE}` });
  });

  it('only reads the reply that follows this task, using a configured reply selector when given', async () => {
    const t = setup({}, { ...CONFIG, responseSelector: '.agent-message' });
    t.page.seedHistory('Old question', 'Old answer that belongs to another task.');
    await t.submit();
    await t.page.reply(['Done. All checks pass.'], 10);
    expect(await t.capture()).toMatchObject({ ok: true, text: 'Done. All checks pass.', marker: false });
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
    expect(await t.capture()).toEqual({ ok: true, text: 'Agent\nImplemented and tested.', marker: false, busy: false });
  });

  it('is not fooled by a reply that mentions the task by name', async () => {
    const t = setup({ renderMarkdown: true });
    await t.submit();
    await t.page.reply(['Task T-3: Add the login form — final report', 'Everything listed was implemented; npm test passes with 14 tests.', DONE], 5);
    const captured = await t.capture();
    expect(captured.ok).toBe(true);
    // The whole reply is read, starting at its first line — not only what follows the echoed heading.
    expect((captured as { text: string }).text).toContain('Task T-3: Add the login form — final report');
    expect((captured as { text: string }).text).toContain('npm test passes with 14 tests');
    expect((captured as { marker: boolean }).marker).toBe(true);
  });

  it('tells two delivery attempts of the same task apart by their reference code', async () => {
    const t = setup();
    await t.submit();
    await t.page.reply(['First attempt: failed with a build error.'], 5);
    // The same task typed again by hand, as a second attempt with its own code.
    const second = promptFor('ffffffff-second-attempt');
    const area = t.page.doc.querySelector('textarea') as HTMLTextAreaElement;
    area.value = second.prompt;
    area.dispatchEvent(new t.page.win.Event('input', { bubbles: true }));
    (t.page.doc.querySelector('#send') as HTMLButtonElement).click();
    await t.page.reply(['Second attempt: build and tests pass.'], 5);
    expect(t.page.sent).toHaveLength(2);

    expect(((await t.capture(second.prompt, second.ref)) as { text: string }).text).toBe('Agent\nSecond attempt: build and tests pass.');
    // The first attempt's reply runs up to the end of the conversation, so it contains the first reply.
    expect(((await t.capture()) as { text: string }).text).toContain('First attempt: failed with a build error.');
    // Without a code, the most recent copy is used.
    expect(((await t.capture(second.prompt, '')) as { text: string }).text).toBe('Agent\nSecond attempt: build and tests pass.');
  });

  it('reports a task that never appeared as not found — it does not make up a reply', async () => {
    const t = setup();
    t.page.seedHistory('Something else', 'Some other answer.');
    expect(await t.probe()).toMatchObject({ found: false, chars: 0, marker: false });
    expect((await t.capture()).ok).toBe(false);
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
