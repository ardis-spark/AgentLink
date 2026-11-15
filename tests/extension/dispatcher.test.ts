import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ARENA_ADAPTER_CONFIG, type ArenaExecutionStatus, type ContentRequest } from '../../src/shared/messages.js';
import { ArenaDispatcher, DispatchError, type BrowserTab, type TabsPort } from '../../src/extension/background/dispatcher.js';
import { createArenaAdapter, type ArenaAdapter } from '../../src/extension/content/arenaAdapter.js';
import { CompanionClient } from '../../src/extension/lib/companionClient.js';
import { DEFAULT_EXTENSION_SETTINGS, type ExtensionSettings } from '../../src/extension/lib/settings.js';
import { createFakeArena, type FakeArena, type FakeArenaOptions } from '../helpers/fakeArena.js';
import { textResponse, toolResponse } from '../helpers/fakeGemini.js';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

/**
 * End-to-end over real parts: the companion's HTTP API, the extension's
 * client and dispatcher, and the Arena adapter running against a stand-in
 * Arena page. Only Gemini's HTTP endpoint and the browser's tab API are faked.
 */

const TIMING = { afterFillMs: 5, submitConfirmMs: 300, pollMs: 15, progressMs: 15, anchorWaitMs: 250 };
const PROPOSAL = {
  title: 'Add the health endpoint',
  instructions: 'Add GET /health returning {"ok":true} and a test for it.',
  context: 'Express app in src/server.ts.',
  acceptance_criteria: ['`npm test` passes'],
  rationale: 'Smallest verifiable first step.',
};

interface FakeTab {
  tab: BrowserTab;
  page: FakeArena;
  adapter: ArenaAdapter | null;
  requests: ContentRequest[];
}

let h: Harness;
let settings: ExtensionSettings;
let tabs: Map<number, FakeTab>;
let dispatcher: ArenaDispatcher;
let client: CompanionClient;
let statuses: ArenaExecutionStatus[];
let injected: number[];
let focused: number[];
let projectId: string;

function openTab(id: number, options: FakeArenaOptions & { withAdapter?: boolean; title?: string } = {}): FakeTab {
  const page = createFakeArena({ path: `/c/conv-${id}`, ...options });
  const entry: FakeTab = { tab: { id, windowId: 1, title: options.title ?? `Arena ${id}`, url: page.win.location.href, active: false }, page, adapter: null, requests: [] };
  const attach = (): void => {
    entry.adapter = createArenaAdapter({ doc: page.doc, win: page.win, timing: TIMING, emit: (event) => void dispatcher.onContentEvent(event, id) });
  };
  if (options.withAdapter !== false) attach();
  (entry as FakeTab & { attach: () => void }).attach = attach;
  tabs.set(id, entry);
  return entry;
}

beforeEach(async () => {
  h = await createHarness();
  await h.companion.server.listen();
  settings = { ...DEFAULT_EXTENSION_SETTINGS, companionUrl: h.companion.server.address, pairingToken: h.companion.token, adapter: { ...DEFAULT_ARENA_ADAPTER_CONFIG, settleMs: 60, maxWaitMs: 4_000 } };
  tabs = new Map();
  statuses = [];
  injected = [];
  focused = [];
  client = new CompanionClient(() => ({ url: settings.companionUrl, token: settings.pairingToken }));

  const port: TabsPort = {
    queryArenaTabs: async () => Array.from(tabs.values(), (t) => t.tab),
    send: async (tabId, request) => {
      const entry = tabs.get(tabId);
      if (!entry || !entry.adapter) throw new Error('Could not establish connection. Receiving end does not exist.');
      entry.requests.push(request);
      return entry.adapter.handle(request);
    },
    inject: async (tabId) => {
      injected.push(tabId);
      const entry = tabs.get(tabId) as (FakeTab & { attach: () => void }) | undefined;
      if (!entry) throw new Error('No tab');
      entry.attach();
    },
    focus: async (tabId) => {
      focused.push(tabId);
    },
  };
  dispatcher = new ArenaDispatcher({
    tabs: port,
    client,
    getSettings: async () => settings,
    saveSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    broadcast: (status) => statuses.push(status),
    retryDelayMs: 5,
  });

  projectId = (await client.createProject({ name: 'Billing service', objective: 'Expose a health endpoint' })).project.id;
});

afterEach(async () => {
  for (const entry of tabs.values()) {
    entry.adapter?.dispose();
    entry.page.close();
  }
  await h.cleanup();
});

async function proposeAndApprove(): Promise<void> {
  h.fake.enqueue(toolResponse([{ name: 'propose_arena_task', args: PROPOSAL }]), textResponse('Proposed.'));
  await client.sendMessage(projectId, 'Add a health endpoint.');
  await h.companion.orchestrator.whenIdle(projectId);
  await client.approveTask(projectId, 'T-1');
}

const task = async () => (await client.getTask(projectId, 'T-1')).task;
const phases = (): string[] => statuses.map((s) => s.phase);

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(DispatchError);
    return (error as Error).message;
  }
  throw new Error('Expected the dispatcher to refuse.');
}

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

  it('remembers the preferred tab and never guesses between several', async () => {
    openTab(1);
    openTab(2);
    await proposeAndApprove();
    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('2 Arena tabs are open');
    expect((await task()).status).toBe('approved');

    const list = await dispatcher.setPreferredTab(2);
    expect(list.find((t) => t.tabId === 2)?.preferred).toBe(true);
    expect(settings.preferredTab).toEqual({ tabId: 2, url: 'https://arena.ai/c/conv-2', title: 'Arena 2' });
    await dispatcher.focusTarget();
    expect(focused).toEqual([2]);

    await dispatcher.dispatch(projectId, 'T-1');
    expect(tabs.get(2)?.page.sent).toHaveLength(1);
    expect(tabs.get(1)?.page.sent).toHaveLength(0);
    expect((await task()).dispatch).toMatchObject({ tabId: 2, tabUrl: 'https://arena.ai/c/conv-2' });
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

describe('sending an approved task and bringing the reply back', () => {
  it('runs the whole loop: approve → send → Arena replies → Gemini evaluates', async () => {
    const arena = openTab(1);
    await proposeAndApprove();

    const sent = await dispatcher.dispatch(projectId, 'T-1');
    expect(sent.phase).toBe('submitted');
    const dispatched = await task();
    expect(dispatched.status).toBe('awaiting_response');
    // What reached Arena is exactly what the companion recorded as sent.
    expect(arena.page.sent).toEqual([dispatched.dispatch?.prompt]);
    expect(arena.page.sent[0]).toContain('# Task T-1: Add the health endpoint');

    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'Endpoint added; tests pass.', evidence: ['Ran npm test: 3 passed, 0 failed.'] } }]),
      textResponse('T-1 is verified.'),
    );
    await arena.page.reply(['Added GET /health in src/server.ts.', 'Ran npm test: 3 passed, 0 failed.'], 20);
    await waitFor(() => phases().includes('captured'), 'the reply to be captured');
    await waitFor(() => h.companion.orchestrator.getTask(projectId, 'T-1').status === 'completed', 'the evaluation');

    const done = await task();
    expect(done.arenaResponse).toMatchObject({ source: 'auto' });
    expect(done.arenaResponse?.text).toBe('Agent\nAdded GET /health in src/server.ts.\nRan npm test: 3 passed, 0 failed.');
    expect(done.evaluation).toMatchObject({ verdict: 'complete', evidence: ['Ran npm test: 3 passed, 0 failed.'] });
    // Gemini was shown the text that was actually on the page.
    const evaluationRequest = h.fake.generateRequests.find((r) => JSON.stringify(r.body.contents.at(-1)).includes('ARENA_RESPONSE_BEGIN'));
    expect(JSON.stringify(evaluationRequest?.body.contents.at(-1))).toContain('Ran npm test: 3 passed, 0 failed.');
    expect(phases()).toEqual(expect.arrayContaining(['sending', 'submitted', 'generating', 'captured']));
  });

  it('cannot send a task that the user has not approved', async () => {
    const arena = openTab(1);
    h.fake.enqueue(toolResponse([{ name: 'propose_arena_task', args: PROPOSAL }]), textResponse('Proposed.'));
    await client.sendMessage(projectId, 'Add a health endpoint.');
    await h.companion.orchestrator.whenIdle(projectId);

    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('has not been approved');
    expect(arena.page.sent).toEqual([]);
    expect(arena.page.composerText()).toBe('');
    expect((await task()).status).toBe('proposed');
  });

  it('sends a task once, however often it is asked to', async () => {
    const arena = openTab(1);
    await proposeAndApprove();
    const results = await Promise.allSettled([dispatcher.dispatch(projectId, 'T-1'), dispatcher.dispatch(projectId, 'T-1'), dispatcher.dispatch(projectId, 'T-1')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('already been handed to Arena');
    expect(arena.page.sent).toHaveLength(1);
    expect(h.companion.orchestrator.getProject(projectId).project.session.tasksDispatched).toBe(1);
  });

  it('checks the tab before claiming, so a tab problem leaves the task ready to send', async () => {
    await proposeAndApprove();
    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('No Arena tab is open');
    expect((await task()).status).toBe('approved');
    expect((await task()).dispatch).toBeNull();

    openTab(1, { agentModeSelected: false });
    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('not in Agent Mode');
    expect((await task()).status).toBe('approved');
    expect(tabs.get(1)?.page.sent).toEqual([]);
  });

  it('returns the task to "approved" when Arena did not take it, and can retry', async () => {
    const arena = openTab(1, { onSend: 'ignore' });
    await proposeAndApprove();
    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('Nothing was sent');
    const failed = await task();
    expect(failed.status).toBe('approved');
    expect(failed.dispatch?.error).toContain('Nothing was sent');
    expect(statuses.at(-1)).toMatchObject({ phase: 'error' });
    expect(arena.page.composerText()).toBe('');

    // The page recovers; the same approved task can be sent again.
    tabs.clear();
    const working = openTab(2);
    await dispatcher.dispatch(projectId, 'T-1');
    expect(working.page.sent).toHaveLength(1);
    expect((await task()).dispatch?.attempt).toBe(2);
  });

  it('never re-sends when it cannot tell whether Arena received the task', async () => {
    const arena = openTab(1, { onSend: 'swallow' });
    await proposeAndApprove();
    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('Check the Arena tab');
    const uncertain = await task();
    expect(uncertain.status).toBe('awaiting_response');
    expect(uncertain.dispatch?.unconfirmed).toBe(true);
    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('already been handed to Arena');
    expect(arena.requests.filter((r) => r.type === 'agentlink:arena:submit')).toHaveLength(1);
  });

  it('treats a tab that vanishes mid-send as "unknown", not as sent or failed', async () => {
    const arena = openTab(1);
    await proposeAndApprove();
    const realHandle = arena.adapter!.handle.bind(arena.adapter);
    arena.adapter!.handle = async (request) => {
      if (request.type === 'agentlink:arena:submit') throw new Error('Message manager disconnected');
      return realHandle(request);
    };
    expect(await refusal(dispatcher.dispatch(projectId, 'T-1'))).toContain('closed or reloaded');
    expect((await task()).dispatch?.unconfirmed).toBe(true);
  });

  it('captures the reply on request when automatic capture gave up', async () => {
    const arena = openTab(1);
    await proposeAndApprove();
    await dispatcher.dispatch(projectId, 'T-1');
    await dispatcher.cancel(projectId, 'T-1'); // stop the automatic watcher
    expect((await arena.adapter!.handle({ type: 'agentlink:arena:ping', config: settings.adapter }) as { watchingDispatchId: string | null }).watchingDispatchId).toBeNull();

    expect(await refusal(dispatcher.capture(projectId, 'T-1'))).toBe('Arena has not replied to this task yet.');
    await arena.page.reply(['Added the endpoint. npm test: 3 passed.'], 5);

    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'ok', evidence: ['npm test: 3 passed'] } }]), textResponse('Verified.'));
    const status = await dispatcher.capture(projectId, 'T-1');
    expect(status.phase).toBe('captured');
    await waitFor(() => h.companion.orchestrator.getTask(projectId, 'T-1').status === 'completed', 'the evaluation');
    expect((await task()).arenaResponse?.source).toBe('manual_capture');
    expect(await refusal(dispatcher.capture(projectId, 'T-1'))).toContain('not waiting for a reply');
  });

  it('supports sending by hand: records the task as sent, returns the exact text, and watches for the reply', async () => {
    const arena = openTab(1);
    await proposeAndApprove();
    const manual = await dispatcher.manualSend(projectId, 'T-1');
    expect(manual.watching).toBe(true);
    expect(manual.prompt).toContain('# Task T-1: Add the health endpoint');
    expect((await task()).status).toBe('awaiting_response');
    expect(arena.page.sent).toEqual([]); // nothing was typed for the user
    expect(statuses.at(-1)?.phase).toBe('needs_manual_send');
    expect(await refusal(dispatcher.manualSend(projectId, 'T-1'))).toContain('already been handed to Arena');

    // The user pastes it into Arena themselves.
    const area = arena.page.doc.querySelector('textarea') as HTMLTextAreaElement;
    area.value = manual.prompt;
    area.dispatchEvent(new arena.page.win.Event('input', { bubbles: true }));
    (arena.page.doc.getElementById('send') as HTMLButtonElement).click();

    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'partial', summary: 'No test output shown.', evidence: ['Added the endpoint.'], missing: ['Test results'] } }]), textResponse('Partial.'));
    await arena.page.reply(['Added the endpoint.'], 10);
    await waitFor(() => h.companion.orchestrator.getTask(projectId, 'T-1').status === 'partial', 'the evaluation');
  });

  it('still works by hand with no Arena tab at all', async () => {
    await proposeAndApprove();
    const manual = await dispatcher.manualSend(projectId, 'T-1');
    expect(manual.watching).toBe(false);
    expect((await task()).dispatch).toMatchObject({ tabId: null, unconfirmed: false });
    expect(statuses.at(-1)?.message).toContain('paste its reply here');
  });

  it('re-attaches the watcher after a reload or restart', async () => {
    const arena = openTab(1);
    await proposeAndApprove();
    await dispatcher.dispatch(projectId, 'T-1');

    // A fresh background script (browser restart) with no memory of the task.
    const fresh = new ArenaDispatcher({
      tabs: { queryArenaTabs: async () => [arena.tab], send: async (_id, request) => arena.adapter!.handle(request), inject: async () => undefined, focus: async () => undefined },
      client,
      getSettings: async () => settings,
      saveSettings: async (patch) => ({ ...settings, ...patch }),
      broadcast: (status) => statuses.push(status),
      retryDelayMs: 5,
    });
    arena.adapter!.dispose();
    arena.adapter = createArenaAdapter({ doc: arena.page.doc, win: arena.page.win, timing: TIMING, emit: (event) => void fresh.onContentEvent(event, 1) });

    const resumed = await fresh.resumeWatch(projectId, 'T-1');
    expect(resumed).toMatchObject({ phase: 'submitted', taskId: 'T-1' });
    h.fake.enqueue(toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'ok', evidence: ['All 3 tests pass'] } }]), textResponse('Verified.'));
    await arena.page.reply(['Done. All 3 tests pass.'], 10);
    await waitFor(() => h.companion.orchestrator.getTask(projectId, 'T-1').status === 'completed', 'the evaluation after resuming');
  });

  it('ignores reply events that do not belong to the dispatch it sent', async () => {
    openTab(1);
    await proposeAndApprove();
    await dispatcher.dispatch(projectId, 'T-1');
    const dispatchId = (await task()).dispatch!.dispatchId;
    const before = h.fake.generateRequests.length;
    await dispatcher.onContentEvent({ type: 'agentlink:arena:response', projectId, taskId: 'T-1', dispatchId: 'forged', text: 'All done!' }, 1);
    await dispatcher.onContentEvent({ type: 'agentlink:arena:response', projectId, taskId: 'T-1', dispatchId, text: 'All done!' }, 77);
    await dispatcher.onContentEvent({ type: 'agentlink:arena:response', projectId: 'p_other', taskId: 'T-1', dispatchId, text: 'All done!' }, 1);
    expect((await task()).status).toBe('awaiting_response');
    expect((await task()).arenaResponse).toBeNull();
    expect(h.fake.generateRequests).toHaveLength(before);
  });

  it('says so when the Arena tab is closed before a reply arrives', async () => {
    openTab(1);
    await proposeAndApprove();
    await dispatcher.dispatch(projectId, 'T-1');
    dispatcher.tabClosed(1);
    expect(statuses.at(-1)).toMatchObject({ phase: 'error' });
    expect(statuses.at(-1)?.message).toContain('tab was closed');
    expect((await task()).status).toBe('awaiting_response');
  });

  it('stops watching when the task is cancelled', async () => {
    const arena = openTab(1);
    await proposeAndApprove();
    await dispatcher.dispatch(projectId, 'T-1');
    await client.cancelTask(projectId, 'T-1');
    await dispatcher.cancel(projectId, 'T-1');
    expect(dispatcher.statuses()).toEqual([]);
    expect(statuses.at(-1)?.phase).toBe('idle');
    const before = h.fake.generateRequests.length;
    await arena.page.reply(['Too late.'], 5);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.fake.generateRequests).toHaveLength(before);
    expect((await task()).status).toBe('cancelled');
  });
});
