import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ARENA_ADAPTER_CONFIG, type ContentRequest } from '../../src/shared/messages.js';
import type { ArenaTask } from '../../src/shared/types.js';
import { ArenaDispatcher, DispatchError, type BrowserTab, type DispatcherClient, type RelayTiming, type TabsPort } from '../../src/extension/background/dispatcher.js';
import { createArenaAdapter, type ArenaAdapter } from '../../src/extension/content/arenaAdapter.js';
import { CompanionClient, CompanionError } from '../../src/extension/lib/companionClient.js';
import { DEFAULT_EXTENSION_SETTINGS, type ExtensionSettings } from '../../src/extension/lib/settings.js';
import { createFakeArena, type FakeArena, type FakeArenaOptions } from '../helpers/fakeArena.js';
import { textResponse, toolResponse, type Scripted } from '../helpers/fakeGemini.js';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

/**
 * End to end over real parts: the companion's HTTP API, the extension's
 * client and relay, and the Arena adapter running against a stand-in Arena
 * page. Only Gemini's HTTP endpoint and the browser's tab API are faked.
 *
 * Nothing in these tests approves, sends or captures anything by hand: the
 * only thing a test does on behalf of the extension is let its timer fire
 * (`dispatcher.tick()`).
 */

const PAGE_TIMING = { afterFillMs: 5, submitConfirmMs: 300, pollMs: 15 };
const RELAY_TIMING: Partial<RelayTiming> = { markerSettleMs: 30, verifyMs: 200, noReplyMs: 300, retryBackoffMs: [5, 5], reportMs: 5, missingAttentionMs: 100 };

const TASK = {
  title: 'Add the health endpoint',
  instructions: 'Add GET /health returning {"ok":true} and a test for it.',
  context: 'Express app in src/server.ts.',
  acceptance_criteria: ['`npm test` passes'],
  rationale: 'Smallest verifiable first step.',
};
const NEXT_TASK = {
  title: 'Document the health endpoint',
  instructions: 'Describe GET /health in README.md, including an example response.',
  context: 'The endpoint was added in the previous task.',
  acceptance_criteria: ['README.md has a "Health check" section'],
  rationale: 'The second and last step.',
};

interface FakeTab {
  tab: BrowserTab;
  page: FakeArena;
  adapter: ArenaAdapter | null;
  requests: ContentRequest[];
  attach: () => void;
}

let h: Harness;
let settings: ExtensionSettings;
let tabs: Map<number, FakeTab>;
let pages: FakeArena[];
let dispatcher: ArenaDispatcher;
let client: CompanionClient;
let port: TabsPort;
let injected: number[];
let focused: number[];
let projectId: string;
/** Added to the relay's clock, to let "time pass" without waiting. */
let skewMs: number;
/** Lets a test make the tab API misbehave for one request. */
let sendHook: ((tabId: number, request: ContentRequest, answer: unknown) => unknown) | null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function openTab(id: number, options: FakeArenaOptions & { withAdapter?: boolean; title?: string; page?: FakeArena } = {}): FakeTab {
  const page = options.page ?? createFakeArena({ path: `/c/conv-${id}`, ...options });
  if (!options.page) pages.push(page);
  const entry: FakeTab = {
    tab: { id, windowId: 1, title: options.title ?? `Arena ${id}`, url: page.win.location.href, active: false },
    page,
    adapter: null,
    requests: [],
    attach: () => {
      entry.adapter = createArenaAdapter({ doc: page.doc, win: page.win, timing: PAGE_TIMING });
    },
  };
  if (options.withAdapter !== false) entry.attach();
  tabs.set(id, entry);
  return entry;
}

/** A new relay that remembers nothing, as after the browser or the extension restarted. */
function newRelay(overrides: { client?: DispatcherClient; timing?: Partial<RelayTiming> } = {}): ArenaDispatcher {
  return new ArenaDispatcher({
    tabs: port,
    client: overrides.client ?? client,
    getSettings: async () => settings,
    saveSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    timing: { ...RELAY_TIMING, ...overrides.timing },
    now: () => Date.now() + skewMs,
  });
}

beforeEach(async () => {
  h = await createHarness();
  await h.companion.server.listen();
  settings = { ...DEFAULT_EXTENSION_SETTINGS, companionUrl: h.companion.server.address, pairingToken: h.companion.token, adapter: { ...DEFAULT_ARENA_ADAPTER_CONFIG, settleMs: 60, maxWaitMs: 4_000 } };
  tabs = new Map();
  pages = [];
  injected = [];
  focused = [];
  skewMs = 0;
  sendHook = null;
  client = new CompanionClient(() => ({ url: settings.companionUrl, token: settings.pairingToken }));

  port = {
    queryArenaTabs: async () => Array.from(tabs.values(), (t) => t.tab),
    send: async (tabId, request) => {
      const entry = tabs.get(tabId);
      if (!entry || !entry.adapter) throw new Error('Could not establish connection. Receiving end does not exist.');
      entry.requests.push(request);
      const answer = await entry.adapter.handle(request);
      return sendHook ? sendHook(tabId, request, answer) : answer;
    },
    inject: async (tabId) => {
      injected.push(tabId);
      const entry = tabs.get(tabId);
      if (!entry) throw new Error('No tab');
      entry.attach();
    },
    focus: async (tabId) => {
      focused.push(tabId);
    },
  };
  dispatcher = newRelay();
});

afterEach(async () => {
  pages.forEach((page) => page.close());
  await h.cleanup();
});

// ------------------------------------------------------------------ helpers ---

const orchestrator = () => h.companion.orchestrator;
const view = () => orchestrator().getProject(projectId).project;
const session = () => view().session;
const task = (id = 'T-1'): ArenaTask => orchestrator().getTask(projectId, id);
const findTask = (id: string): ArenaTask | undefined => (view().tasks.some((t) => t.id === id) ? task(id) : undefined);
const done = (id = 'T-1'): string => `AGENTLINK-DONE ${task(id).dispatch?.ref ?? ''}`;

/** Gemini's verdict. Its evidence must be quoted from Arena's reply word for word, or the companion refuses it. */
function evaluates(taskId: string, verdict = 'complete', evidence: string[] = ['Ran `npm test`: 9 passed, 0 failed.']): Scripted {
  return toolResponse([{ name: 'evaluate_arena_result', args: { task_id: taskId, verdict, summary: 'Checked against the criteria.', evidence } }]);
}
/** A turn that ends with a question to the user: the only way a turn may end with nothing in motion. */
function asks(question = 'How should I proceed?'): Scripted[] {
  return [toolResponse([{ name: 'request_user_input', args: { question, why: 'Arena did not deliver.', options: [] } }]), textResponse(question)];
}
function completes(): Scripted[] {
  return [toolResponse([{ name: 'mark_objective_complete', args: { summary: 'The health endpoint is built and tested.' } }]), textResponse('Everything is done.')];
}

/** The user states the objective. From here on nobody presses anything. */
async function giveObjective(): Promise<void> {
  h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: TASK }]), textResponse('T-1 is on its way to Arena.'));
  projectId = (await client.createProject({ name: 'Billing service', objective: 'Expose a health endpoint', start: true })).project.id;
  await waitFor(() => view().tasks.length === 1 && !orchestrator().turnState(projectId).active, 'Gemini to send the first task');
  expect(task().status).toBe('queued');
}

/** Lets the extension's timer fire until something is true. */
async function run(until: () => boolean, what: string, relay: ArenaDispatcher = dispatcher, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await relay.tick();
    if (until()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Task: ${JSON.stringify(findTask('T-1')?.relay)} / ${findTask('T-1')?.status}`);
    await sleep(15);
  }
}

/** Fires the timer a number of times, for assertions that something does *not* happen. */
async function ticks(count: number, relay: ArenaDispatcher = dispatcher): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await relay.tick();
    await sleep(10);
  }
}

async function sendFirstTask(id = 1, options: Parameters<typeof openTab>[1] = {}): Promise<FakeTab> {
  const entry = openTab(id, options);
  await giveObjective();
  await run(() => task().status === 'awaiting_response' && task().dispatch?.unconfirmed === false, 'T-1 to be sent');
  return entry;
}

function addStopButton(page: FakeArena): HTMLElement {
  const stop = page.doc.createElement('button');
  stop.setAttribute('type', 'button');
  stop.setAttribute('aria-label', 'Stop generating');
  stop.textContent = '■';
  page.doc.querySelector('form')?.append(stop);
  return stop;
}

// -------------------------------------------------------------------- tabs ---

describe('Arena tab discovery and selection', () => {
  it('lists Arena tabs with what the adapter found in each', async () => {
    openTab(1, { title: 'Arena — project chat' });
    openTab(2, { agentModeSelected: false });
    const list = await dispatcher.listTabs();
    expect(list.map((t) => [t.tabId, t.title, t.preferred, t.page?.composerFound, t.page?.agentMode])).toEqual([
      [1, 'Arena — project chat', false, true, true],
      [2, 'Arena 2', false, true, false],
    ]);
  });

  it('loads the adapter into a tab that was open before the extension', async () => {
    openTab(5, { withAdapter: false });
    const list = await dispatcher.listTabs();
    expect(injected).toEqual([5]);
    expect(list[0]?.page?.composerFound).toBe(true);
    expect(list[0]?.error).toBeNull();
  });

  it('never guesses between several Arena tabs: it waits, says why, and goes on once one is chosen', async () => {
    openTab(1);
    openTab(2);
    await giveObjective();
    await ticks(3);
    expect(task().status).toBe('queued');
    expect(task().dispatch).toBeNull();
    expect(task().relay).toMatchObject({ phase: 'waiting_for_arena', attention: true });
    expect(task().relay?.message).toContain('2 Arena tabs are open');

    const list = await dispatcher.setPreferredTab(2);
    expect(list.find((t) => t.tabId === 2)?.preferred).toBe(true);
    expect(settings.preferredTab).toEqual({ tabId: 2, url: 'https://arena.ai/c/conv-2', title: 'Arena 2' });
    await dispatcher.focusTarget();
    expect(focused).toEqual([2]);

    await run(() => task().status === 'awaiting_response', 'T-1 to be sent to the chosen tab');
    expect(tabs.get(2)?.page.sent).toHaveLength(1);
    expect(tabs.get(1)?.page.sent).toHaveLength(0);
    expect(task().dispatch).toMatchObject({ tabId: 2, tabUrl: 'https://arena.ai/c/conv-2' });
  });

  it('finds the preferred conversation again after tab ids change, and asks when it is gone', async () => {
    openTab(1);
    await dispatcher.setPreferredTab(1);
    // Browser restart: same conversation, new tab id.
    const old = tabs.get(1)!;
    tabs.delete(1);
    tabs.set(9, { ...old, tab: { ...old.tab, id: 9 } });
    expect((await dispatcher.resolveTarget(settings)).id).toBe(9);
    expect(settings.preferredTab?.tabId).toBe(9);

    tabs.delete(9);
    openTab(3);
    // One Arena tab is open: there is nothing to confuse it with.
    expect((await dispatcher.resolveTarget(settings)).id).toBe(3);
    openTab(4);
    tabs.delete(3);
    openTab(5);
    await expect(dispatcher.resolveTarget(settings)).rejects.toThrow('no longer open');
    tabs.clear();
    await expect(dispatcher.resolveTarget(settings)).rejects.toThrow('no other Arena tab is open');
    await expect(dispatcher.setPreferredTab(42)).rejects.toThrow('no longer open on Arena');
  });

  it('tests the connection without typing or sending anything', async () => {
    const none = await dispatcher.test();
    expect(none).toMatchObject({ ok: false, tab: null });
    expect(none.message).toContain('No Arena tab is open');

    const entry = openTab(1);
    const ready = await dispatcher.test();
    expect(ready.ok).toBe(true);
    expect(ready.message).toBe('Arena is reachable and ready.');
    expect(ready.checks.map((c) => [c.label, c.ok])).toEqual([
      ['Arena tab', true],
      ['AgentLink adapter', true],
      ['Message box', true],
      ['Send control', true],
      ['Agent Mode', true],
      ['Ready', true],
    ]);
    expect(entry.page.sent).toEqual([]);
    expect(entry.page.composerText()).toBe('');
    expect(entry.requests.every((r) => r.type === 'agentlink:arena:ping')).toBe(true);

    openTab(2, { agentModeSelected: false });
    const wrongMode = await dispatcher.test(2);
    expect(wrongMode.ok).toBe(false);
    expect(wrongMode.message).toContain('Switch the Arena tab to Agent Mode');
  });
});

// --------------------------------------------------------------- the loop ---

describe('the autonomous loop', () => {
  it('runs objective → task → Arena → review → next task → … → complete, with nobody pressing anything', async () => {
    const { page } = openTab(1, { showStop: true });
    await giveObjective();

    // Round 1: the task goes out by itself.
    await run(() => task().status === 'awaiting_response', 'T-1 to be sent');
    expect(page.sent).toEqual([task().dispatch?.prompt]);
    expect(task().dispatch).toMatchObject({ attempt: 1, unconfirmed: false, tabId: 1 });
    expect(task().dispatch?.confirmedAt).not.toBeNull();
    // The tab the project works in is remembered without anyone choosing it.
    expect(settings.preferredTab?.tabId).toBe(1);

    // Arena works and reports; Gemini reviews the report and sends the next task.
    h.fake.enqueue(evaluates('T-1'), toolResponse([{ name: 'dispatch_arena_task', args: NEXT_TASK }]), textResponse('T-1 is verified. T-2 is on its way.'));
    const firstReport = ['Added GET /health in src/server.ts and a test in tests/health.test.ts.', 'Ran `npm test`: 9 passed, 0 failed.', done('T-1')];
    void page.reply(firstReport, 20);
    await run(() => findTask('T-2')?.status === 'awaiting_response', 'T-2 to be sent after the review of T-1');

    expect(task('T-1').status).toBe('completed');
    expect(task('T-1').arenaResponse).toMatchObject({ source: 'auto', completion: 'marker', text: `Agent\n${firstReport.join('\n')}` });
    expect(task('T-1').evaluation?.verdict).toBe('complete');
    expect(page.sent).toHaveLength(2);
    expect(page.sent[1]).toContain('Task T-2: Document the health endpoint');
    // The review Gemini did was based on Arena's actual words.
    const review = JSON.stringify(h.fake.generateRequests.at(-3));
    expect(review).toContain('9 passed, 0 failed');

    // Round 2: the last report; Gemini declares the objective complete.
    h.fake.enqueue(evaluates('T-2', 'complete', ['Added a "Health check" section to README.md']), ...completes());
    void page.reply(['Added a "Health check" section to README.md with an example response.', done('T-2')], 20);
    await run(() => session().status === 'completed', 'the session to complete');

    expect(view().status).toBe('complete');
    expect(view().tasks.map((t) => [t.id, t.status])).toEqual([
      ['T-1', 'completed'],
      ['T-2', 'completed'],
    ]);
    expect(session().tasksDispatched).toBe(2);
    expect(session().blocker).toBeNull();
    expect(h.fake.pending).toBe(0);
    // Nothing is left for the relay, and it leaves the finished conversation alone.
    expect((await client.relayWork()).items).toEqual([]);
    await ticks(3);
    expect(page.sent).toHaveLength(2);
    expect(page.composerText()).toBe('');
  });

  it('picks up a report that is already in the Arena tab and continues with the next task', async () => {
    // T-1 was sent, and Arena finished it while no relay was running: the browser was closed, the extension was
    // reloaded, or the computer slept. The finished report is simply sitting in the conversation.
    const { page } = await sendFirstTask(1);
    await page.reply(['Added GET /health and its test.', 'Ran `npm test`: 9 passed, 0 failed.', done('T-1')], 5);
    expect(task().status).toBe('awaiting_response');

    // A relay that has never seen this task starts up (new tab id, adapter not loaded yet).
    tabs.clear();
    openTab(7, { page, withAdapter: false });
    const restarted = newRelay();
    h.fake.enqueue(evaluates('T-1'), toolResponse([{ name: 'dispatch_arena_task', args: NEXT_TASK }]), textResponse('T-1 is verified. T-2 is on its way.'));
    await run(() => findTask('T-2')?.status === 'awaiting_response', 'the T-1 report to be ingested and T-2 to be sent', restarted);

    expect(injected).toContain(7);
    expect(task('T-1').status).toBe('completed');
    expect(task('T-1').arenaResponse?.text).toContain('9 passed, 0 failed');
    expect(task('T-1').arenaResponse?.completion).toBe('marker');
    // T-1 was not typed again; T-2 went into the same conversation.
    expect(page.sent).toHaveLength(2);
    expect(page.sent[1]).toContain('Task T-2: Document the health endpoint');
    expect(task('T-2').dispatch?.tabId).toBe(7);
    expect(session().status).toBe('running');
  });

  it('sends a task exactly once, however often and however concurrently the timer fires', async () => {
    const { page } = openTab(1);
    await giveObjective();
    await Promise.all([dispatcher.tick(), dispatcher.tick(), dispatcher.tick()]);
    await ticks(5);
    // A second relay (a second browser window's background page would be one) does not send it again either.
    await ticks(3, newRelay());
    expect(page.sent).toHaveLength(1);
    expect(task().dispatch?.attempt).toBe(1);
    expect(task().status).toBe('awaiting_response');
  });

  it('waits for Arena to be usable without spending an attempt, and sends as soon as it is', async () => {
    await giveObjective();
    await ticks(2);
    expect(task().status).toBe('queued');
    expect(task().dispatch).toBeNull();
    expect(task().relay).toMatchObject({ phase: 'waiting_for_arena', attention: true });
    expect(task().relay?.message).toContain('No Arena tab is open');

    // A tab appears, with somebody's half-written note in the message box.
    const { page } = openTab(1);
    const area = page.doc.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'my half-written note';
    area.dispatchEvent(new page.win.Event('input', { bubbles: true }));
    await ticks(2);
    expect(task().relay?.message).toContain('contains a draft');
    expect(area.value).toBe('my half-written note');
    expect(task().dispatch).toBeNull();

    // Arena is busy with something else.
    area.value = '';
    area.dispatchEvent(new page.win.Event('input', { bubbles: true }));
    const stop = addStopButton(page);
    await ticks(2);
    expect(task().relay).toMatchObject({ phase: 'waiting_for_arena', attention: false });
    expect(task().relay?.message).toContain('still working on a previous request');
    expect(page.sent).toEqual([]);

    stop.remove();
    await run(() => task().status === 'awaiting_response', 'T-1 to be sent once Arena is free');
    expect(page.sent).toHaveLength(1);
    expect(task().dispatch?.attempt).toBe(1);
  });

  it('tries again by itself when Arena does not take the task, and stops with an explanation after five attempts', async () => {
    const { page } = openTab(1, { onSend: 'ignore' });
    await giveObjective();
    await run(() => (task().dispatch?.attempt ?? 0) >= 2 && task().status === 'queued', 'a second attempt');
    expect(task().dispatch?.error).toContain('Nothing was sent');
    expect(task().relay?.message).toContain('Trying again shortly');
    expect(page.composerText()).toBe('');

    await run(() => session().status === 'blocked', 'the session to stop with an explanation');
    expect(task().dispatch?.attempt).toBe(5);
    expect(session().blocker).toMatchObject({ kind: 'arena', taskId: 'T-1' });
    expect(session().blocker?.detail).toContain('tried 5 times');
    expect(page.sent).toEqual([]);
    // No attempt is made while the session waits for the user.
    await ticks(3);
    expect(task().dispatch?.attempt).toBe(5);
  });

  it('never types a task again while it cannot tell whether Arena received it', async () => {
    const { page } = openTab(1, { onSend: 'swallow' });
    await giveObjective();
    await run(() => task().status === 'awaiting_response', 'the delivery to be recorded as in doubt');
    expect(task().dispatch).toMatchObject({ attempt: 1, unconfirmed: true });
    expect(task().dispatch?.error).toContain('did not appear in the conversation');
    await ticks(3);
    expect(task().relay?.phase).toBe('verifying');
    expect(task().dispatch?.attempt).toBe(1);

    // The page was watched for long enough: the task is certainly not there, so it is safe to send it again.
    await run(() => (task().dispatch?.attempt ?? 0) >= 2, 'a second delivery after the page was checked');
    const resets = view().timeline.filter((e) => JSON.stringify(e).includes('did not appear in any open Arena tab'));
    expect(resets.length).toBeGreaterThan(0);
    expect(page.sent).toEqual([]);
  });

  it('confirms a delivery that looked lost when the task turns out to be in the page', async () => {
    const { page } = openTab(1);
    await giveObjective();
    // The tab stops answering in the middle of the submission, after Arena took the message.
    sendHook = (_tabId, request, answer) => {
      if (request.type !== 'agentlink:arena:submit') return answer;
      sendHook = null;
      throw new Error('Message manager disconnected');
    };
    await dispatcher.tick();
    expect(task().status).toBe('awaiting_response');
    expect(task().dispatch).toMatchObject({ unconfirmed: true, attempt: 1 });
    expect(task().dispatch?.error).toContain('closed or reloaded while the task was being sent');

    await run(() => task().dispatch?.unconfirmed === false, 'the delivery to be confirmed from the page');
    expect(page.sent).toHaveLength(1);
    expect(task().dispatch?.attempt).toBe(1);
  });

  it('takes over a delivery that a previous run of the browser left half-done', async () => {
    const { page } = openTab(1);
    await giveObjective();
    // An earlier relay claimed the task and died before it typed anything.
    const claim = await client.claimDispatch(projectId, 'T-1', { tabId: 1, tabUrl: page.win.location.href });
    const restarted = newRelay();
    await ticks(3, restarted);
    // It might still be in progress elsewhere, so nothing is touched yet.
    expect(task().status).toBe('dispatching');
    expect(page.sent).toEqual([]);

    skewMs = 46_000;
    await restarted.tick();
    expect(task().status).toBe('awaiting_response');
    expect(task().dispatch).toMatchObject({ dispatchId: claim.dispatchId, unconfirmed: true });
    // Not in the page: back to the queue, and out again — once.
    await run(() => task().dispatch?.attempt === 2 && task().status === 'awaiting_response' && task().dispatch?.unconfirmed === false, 'the task to be sent after the takeover', restarted);
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]).toBe(task().dispatch?.prompt);
  });
});

// ------------------------------------------------------- reading the reply ---

describe('bringing Arena’s reply back', () => {
  it('waits while Arena is still writing, and accepts a reply without the closing line once it has gone quiet', async () => {
    const { page } = await sendFirstTask(1, { showStop: true });
    h.fake.enqueue(evaluates('T-1', 'complete', ['Ran `npm test`: 9 passed.']), ...completes());
    const replying = page.reply(['Step 1 of 3 done.', 'Step 2 of 3 done.', 'Step 3 of 3 done. Ran `npm test`: 9 passed.'], 120);
    await run(() => (task().relay?.chars ?? 0) > 0, 'progress to be reported');
    expect(task().relay?.phase).toBe('generating');
    expect(task().status).toBe('awaiting_response');
    expect(task().arenaResponse).toBeNull();

    await replying;
    await run(() => task().arenaResponse !== null, 'the reply to be handed over');
    expect(task().arenaResponse).toMatchObject({ completion: 'quiet', source: 'auto' });
    expect(task().arenaResponse?.text).toBe('Agent\nStep 1 of 3 done.\nStep 2 of 3 done.\nStep 3 of 3 done. Ran `npm test`: 9 passed.');
    await run(() => session().status === 'completed', 'the review');
  });

  it('hands over a reply that stopped moving while Arena still claims to work, marked as possibly incomplete', async () => {
    const { page } = await sendFirstTask(1);
    settings = { ...settings, adapter: { ...settings.adapter, maxWaitMs: 250 } };
    addStopButton(page);
    await page.reply(['Created the route. Running the tests now…'], 5);
    // The stop control never goes away.
    addStopButton(page);
    h.fake.enqueue(evaluates('T-1', 'unclear', []), ...asks('Arena stopped half-way. Retry?'));
    await run(() => task().arenaResponse !== null, 'the stalled reply to be handed over');
    expect(task().arenaResponse).toMatchObject({ completion: 'stalled', text: 'Agent\nCreated the route. Running the tests now…' });
    // Gemini is told that the report may be cut short.
    await run(() => task().status === 'inconclusive', 'the review');
    const review = JSON.stringify(h.fake.generateRequests.at(-3));
    expect(review.toLowerCase()).toMatch(/incomplete|stopped|stalled/);
  });

  it('never invents a result: a task Arena does not answer is closed as "no reply" and Gemini decides what next', async () => {
    const { page } = await sendFirstTask(1);
    h.fake.enqueue(...asks('Arena did not answer T-1. Should I send it again?'));
    await run(() => task().status === 'no_response', 'the task to be closed without a reply');
    expect(task().arenaResponse).toBeNull();
    expect(task().evaluation).toBeNull();
    expect(task().closedReason).toContain('had written nothing');
    await run(() => session().status === 'blocked', 'Gemini to react');
    expect(session().blocker).toMatchObject({ kind: 'question' });
    expect(JSON.stringify(h.fake.generateRequests.at(-2))).toContain('T-1');
    expect(page.sent).toHaveLength(1);
  });

  it('finds the reply in whichever Arena tab shows the conversation, and says so when none does', async () => {
    const { page } = await sendFirstTask(1);
    // The conversation is closed; another Arena tab is open.
    tabs.clear();
    openTab(2);
    await run(() => task().relay?.phase === 'searching' && task().relay?.attention === true, 'the missing conversation to be reported');
    expect(task().relay?.message).toContain('its conversation is not open in any Arena tab');
    expect(task().status).toBe('awaiting_response');
    expect(tabs.get(2)?.page.sent).toEqual([]);

    tabs.clear();
    await run(() => (task().relay?.message ?? '').includes('No Arena tab is open'), 'the closed tab to be reported');

    // It is opened again, in a new tab, next to the unrelated one. Arena has finished meanwhile.
    await page.reply(['All done. Ran `npm test`: 9 passed, 0 failed.', done()], 5);
    openTab(2);
    openTab(11, { page });
    h.fake.enqueue(evaluates('T-1'), ...completes());
    await run(() => session().status === 'completed', 'the reply to be found in the reopened tab');
    expect(task().arenaResponse?.text).toContain('9 passed, 0 failed');
    expect(page.sent).toHaveLength(1);
  });

  it('keeps a reply it has read until the companion has it', async () => {
    const { page } = openTab(1);
    let refusals = 2;
    const flaky = Object.create(client) as CompanionClient;
    flaky.recordArenaResponse = async (...args) => {
      if (refusals > 0) {
        refusals -= 1;
        throw new CompanionError(0, 'offline', 'The companion is not running.');
      }
      return client.recordArenaResponse(...args);
    };
    const relay = newRelay({ client: flaky });
    await giveObjective();
    await run(() => task().status === 'awaiting_response', 'T-1 to be sent', relay);
    await page.reply(['Done. Ran `npm test`: 9 passed, 0 failed.', done()], 5);
    await run(() => refusals < 2, 'the first hand-over to fail', relay);
    expect(task().arenaResponse).toBeNull();
    // The conversation disappears; the reply that was read is not lost with it.
    tabs.clear();
    h.fake.enqueue(evaluates('T-1'), ...completes());
    await run(() => task().arenaResponse !== null, 'the reply to reach the companion', relay);
    expect(refusals).toBe(0);
    expect(task().arenaResponse?.text).toBe(`Agent\nDone. Ran \`npm test\`: 9 passed, 0 failed.\n${done()}`);
    await run(() => session().status === 'completed', 'the review', relay);
  });

  it('reports whether the companion can be reached', async () => {
    expect(dispatcher.link()).toBe('starting');
    await dispatcher.tick();
    expect(dispatcher.link()).toBe('online');
    expect((await client.status()).relay.online).toBe(true);

    const token = settings.pairingToken;
    settings = { ...settings, pairingToken: 'wrong-token' };
    await dispatcher.tick();
    expect(dispatcher.link()).toBe('unauthorized');
    settings = { ...settings, pairingToken: '' };
    await dispatcher.tick();
    expect(dispatcher.link()).toBe('unpaired');
    settings = { ...settings, pairingToken: token, companionUrl: 'http://127.0.0.1:9' };
    await dispatcher.tick();
    expect(dispatcher.link()).toBe('offline');
  });
});

// ----------------------------------------------------------------- control ---

describe('pause, stop and recovery by hand', () => {
  it('sends nothing while the session is paused, still collects a reply that is under way, and goes on after resume', async () => {
    const { page } = openTab(1);
    await giveObjective();
    await client.controlSession(projectId, 'pause');
    await ticks(3);
    expect(page.sent).toEqual([]);
    expect(task().status).toBe('queued');

    await client.controlSession(projectId, 'resume');
    await run(() => task().status === 'awaiting_response', 'T-1 to be sent after resume');
    await client.controlSession(projectId, 'pause');
    await page.reply(['Done. Ran `npm test`: 9 passed, 0 failed.', done()], 5);
    await run(() => task().arenaResponse !== null, 'the reply to be collected while paused');
    // Collected, but not acted on.
    const requests = h.fake.generateRequests.length;
    await ticks(3);
    expect(task().evaluation).toBeNull();
    expect(h.fake.generateRequests.length).toBe(requests);
    expect(session().status).toBe('paused');

    h.fake.enqueue(evaluates('T-1'), ...completes());
    await client.controlSession(projectId, 'resume');
    await run(() => session().status === 'completed', 'the review after resume');
    expect(task().status).toBe('completed');
  });

  it('stops for good: the open task is cancelled and a late reply is not recorded', async () => {
    const { page } = await sendFirstTask(1);
    await client.controlSession(projectId, 'stop');
    expect(task().status).toBe('cancelled');
    await page.reply(['Done. Ran `npm test`: 9 passed, 0 failed.', done()], 5);
    const requests = h.fake.generateRequests.length;
    await ticks(5);
    expect(task().arenaResponse).toBeNull();
    expect(session().status).toBe('stopped');
    expect(h.fake.generateRequests.length).toBe(requests);
    expect(tabs.get(1)?.requests.at(-1)?.type).not.toBe('agentlink:arena:capture');
  });

  it('can hand over on request what Arena has written so far', async () => {
    const { page } = await sendFirstTask(1);
    await expect(dispatcher.capture(projectId, 'T-1')).rejects.toThrow('Arena has not replied to this task yet.');
    addStopButton(page);
    await page.reply(['Half of the work is done; the tests are still running.'], 5);
    addStopButton(page);

    h.fake.enqueue(evaluates('T-1', 'partial', ['Half of the work is done']), ...asks('Only half was reported. Continue?'));
    expect(await dispatcher.capture(projectId, 'T-1')).toEqual({ chars: 'Agent\nHalf of the work is done; the tests are still running.'.length });
    expect(task().arenaResponse).toMatchObject({ source: 'manual_capture', completion: 'manual' });
    await waitFor(() => task().status === 'partial', 'the review');

    const refused = await dispatcher.capture(projectId, 'T-1').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DispatchError);
    expect((refused as Error).message).toContain('not waiting for a reply');
  });
});
