import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UiRequest, UiResult } from '../../src/shared/messages.js';
import { errorBody, textResponse, toolResponse, VALID_KEY, type Scripted } from '../helpers/fakeGemini.js';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

/**
 * Runs the real, bundled workspace UI in a DOM against a real companion.
 * Only the browser extension API, the background script and Gemini are stand-ins.
 *
 * The page is a window onto work that runs by itself. The tests therefore
 * never "approve" or "send" anything: after the objective is given, what
 * the relay would do is done directly on the companion, and the page has to
 * show it.
 */

let bundle = '';
let h: Harness;
let dom: JSDOM;
let stored: Record<string, unknown>;
let backgroundRequests: UiRequest[];
let openedTabs: string[];
let pageErrors: string[];

beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../src/extension/ui/main.tsx', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { __AGENTLINK_VERSION__: '"test"' },
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0]?.text ?? '';
});

function boot(search = ''): void {
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `https://extension.invalid/ui/index.html${search}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as unknown as Record<string, unknown>;
  const storageListeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  win.browser = {
    storage: {
      local: {
        get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(stored, items);
        },
      },
      onChanged: { addListener: (l: (changes: Record<string, unknown>, area: string) => void) => storageListeners.add(l), removeListener: (l: (changes: Record<string, unknown>, area: string) => void) => storageListeners.delete(l) },
    },
    runtime: {
      onMessage: { addListener: () => undefined },
      sendMessage: async (request: UiRequest): Promise<UiResult<unknown>> => {
        backgroundRequests.push(request);
        if (request.type === 'agentlink:ui:listArenaTabs') return { ok: true, value: [] };
        if (request.type === 'agentlink:ui:captureResponse') return { ok: true, value: { chars: 0 } };
        return { ok: true, value: null };
      },
    },
    tabs: {
      create: async ({ url }: { url: string }) => {
        openedTabs.push(url);
      },
    },
  };
  // The page talks to the companion with the platform's own fetch.
  win.fetch = fetch;
  win.AbortController = AbortController;
  win.AbortSignal = AbortSignal;
  win.TextDecoder = TextDecoder;
  win.matchMedia = () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined });
  dom.window.addEventListener('error', (event) => pageErrors.push(String(event.message)));
  dom.window.eval(bundle);
}

const text = (): string => (dom.window.document.body.textContent ?? '').replace(/\s+/g, ' ');
const $ = <T extends Element>(selector: string): T => {
  const el = dom.window.document.querySelector<T>(selector);
  if (!el) throw new Error(`Not on the page: ${selector}\n${text().slice(0, 600)}`);
  return el;
};
const button = (label: string | RegExp): HTMLButtonElement => {
  const found = Array.from(dom.window.document.querySelectorAll('button')).find((b) => (typeof label === 'string' ? (b.textContent ?? '').trim() === label : label.test(b.textContent ?? '')));
  if (!found) throw new Error(`No button "${String(label)}"\n${text().slice(0, 600)}`);
  return found as HTMLButtonElement;
};
function type(selector: string, value: string): void {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(selector);
  el.value = value;
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
/** Lets the page re-render first, as it would have long before a person reaches the submit button. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
async function submit(selector: string): Promise<void> {
  await settle();
  $<HTMLElement>(selector).closest('form')?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}
const shows = async (needle: string | RegExp, timeoutMs = 4_000): Promise<void> => {
  try {
    await waitFor(() => (typeof needle === 'string' ? text().includes(needle) : needle.test(text())), `the page to show ${String(needle)}`, timeoutMs);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nPage: ${text().slice(0, 900)}\nErrors: ${pageErrors.join(' | ')}`);
  }
};

const TASK_ARGS = {
  title: 'Add the health endpoint',
  instructions: 'Add GET /health returning {"ok":true}.',
  context: 'Express app in src/server.ts.',
  acceptance_criteria: ['`npm test` passes'],
  rationale: 'Smallest verifiable step.',
};
/** Gemini's first turn: it sends a task to Arena straight away. */
const sendsTask = (): Scripted[] => [toolResponse([{ name: 'dispatch_arena_task', args: TASK_ARGS }]), textResponse('I sent **T-1** to Arena and will review its report.')];
const REPLY = 'Added GET /health in src/server.ts.\n$ npm test\n 12 passed, 0 failed\nAGENTLINK-DONE';

const orchestrator = () => h.companion.orchestrator;
const projectId = (): string => h.companion.store.list()[0]?.id ?? '';
const buttons = (): string[] => Array.from(dom.window.document.querySelectorAll('button'), (b) => (b.textContent ?? '').trim());
const alertText = (): string => dom.window.document.querySelector('[role="alert"]')?.textContent ?? '';

/** What the relay does once the Arena tab is usable: it types the task in and sees it accepted. */
function relayDelivers(): string {
  orchestrator().relayWork();
  const claim = orchestrator().claimDispatch(projectId(), 'T-1', { tabId: 7, tabUrl: 'https://arena.ai/c/abc' });
  orchestrator().confirmDispatch(projectId(), 'T-1', claim.dispatchId);
  orchestrator().reportRelay(projectId(), 'T-1', { dispatchId: claim.dispatchId, phase: 'submitted', message: 'Arena accepted the task. Waiting for it to start…', attention: false, chars: 0 });
  return claim.dispatchId;
}

/** Pairs, fills in the project form and presses Start. That is the last thing the user has to do. */
async function pairAndCreateProject(script: Scripted[] = sendsTask()): Promise<void> {
  h.fake.enqueue(...script);
  boot();
  await shows('Companion not running');
  type('#companion-url', h.companion.server.address);
  type('#companion-token', h.companion.token);
  await submit('#companion-url');
  await shows('Start your first project');
  type('#project-name', 'Billing service');
  type('#project-objective', 'Expose a health endpoint');
  type('#project-constraints', 'Do not change the public API\n- Keep tests green');
  await submit('#project-name');
  await shows('Expose a health endpoint');
}

beforeEach(async () => {
  h = await createHarness();
  await h.companion.server.listen();
  stored = {};
  backgroundRequests = [];
  openedTabs = [];
  pageErrors = [];
});

afterEach(async () => {
  dom?.window.close();
  await h.cleanup();
  expect(pageErrors).toEqual([]);
});

describe('workspace UI', () => {
  it('says the companion is not running when nothing answers at the default address', async () => {
    boot();
    await shows('Companion not running');
    expect(text()).toContain('npm start');
    expect(dom.window.document.querySelector('#project-name')).toBeNull();
  });

  it('asks for the pairing token when the companion is there, and explains a wrong one in place', async () => {
    stored['agentlink.settings'] = { companionUrl: h.companion.server.address };
    boot();
    await shows('Connect AgentLink to its companion');
    type('#companion-token', 'not-the-token');
    await submit('#companion-url');
    await shows('Pairing token rejected');
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toMatch(/rejected the pairing token/);
    expect(dom.window.document.querySelector('#project-name')).toBeNull();
  });

  it('fills both pairing fields from the pasted settings link', async () => {
    boot();
    await shows('Companion not running');
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => `${h.companion.server.address}/settings#token=${h.companion.token}` } });
    $('#companion-token').dispatchEvent(paste);
    await waitFor(() => $<HTMLInputElement>('#companion-url').value === h.companion.server.address, 'the address to be filled in');
    expect($<HTMLInputElement>('#companion-token').value).toBe(h.companion.token);
    await submit('#companion-url');
    await shows('Start your first project');
  });

  it('pairs, takes the objective once, and the work starts with no further step', async () => {
    await pairAndCreateProject();
    await shows('will review its report.');
    await shows('Going to Arena');
    expect(text()).toContain('Running by itself');
    expect(text()).toContain('Add the health endpoint');
    expect($('.prose strong').textContent).toBe('T-1');
    // The objective was the project form; nobody had to type a message or approve anything.
    expect(Array.from(dom.window.document.querySelectorAll('.entry__who'), (el) => el.textContent)).not.toContain('You');
    expect(text()).not.toMatch(/approv|your decision/i);
    expect(buttons().filter((label) => /approve|reject|send to arena|edit task/i.test(label))).toEqual([]);
    expect(backgroundRequests.every((r) => r.type === 'agentlink:ui:listArenaTabs' || r.type === 'agentlink:ui:wake')).toBe(true);

    // The constraint list is cleaned up and kept with the project.
    const project = h.companion.store.list()[0];
    expect(project?.name).toBe('Billing service');
    expect(h.companion.store.get(project?.id ?? '')?.constraints).toEqual(['Do not change the public API', 'Keep tests green']);
    expect(h.companion.store.get(project?.id ?? '')?.session.status).toBe('running');
    // Pairing survives a reload; the Gemini key never reaches extension storage or the page.
    expect(JSON.stringify(stored)).toContain(h.companion.token);
    expect(JSON.stringify(stored)).not.toContain(VALID_KEY);
    expect(dom.window.document.documentElement.outerHTML).not.toContain(VALID_KEY);

    // What Arena will be told can be read, constraints included.
    button(/Text that will be sent to Arena/).click();
    await shows('Do not change the public API');
    expect($('pre.reply').textContent).toMatch(/^# Task T-1: Add the health endpoint/);
  });

  it('shows the one thing that holds the work up, and nothing when it runs', async () => {
    await pairAndCreateProject();
    await shows('Going to Arena');
    // No part of the extension has asked the companion for work yet.
    await shows('The browser relay is not reaching the companion');
    orchestrator().relayWork();
    await waitFor(() => !text().includes('The browser relay is not reaching the companion'), 'the relay warning to clear');
    expect(dom.window.document.querySelector('[role="alert"]')).toBeNull();

    // The relay cannot deliver: there is no Arena tab.
    orchestrator().reportRelay(projectId(), 'T-1', { dispatchId: null, phase: 'waiting_for_arena', message: 'No Arena tab is open. Open Arena Agent Mode in a tab; AgentLink sends the task as soon as it is there.', attention: true, chars: 0 });
    await shows('T-1 is waiting on the Arena tab');
    expect(alertText()).toContain('AgentLink sends the task as soon as it is there.');
    expect(text()).toContain('Waiting for Arena');
    expect($('.stage--problem').textContent).toContain('Send');
    button('Arena settings');
    button('Go to Arena tab').click();
    await waitFor(() => backgroundRequests.some((r) => r.type === 'agentlink:ui:focusArenaTab'), 'the request to show the Arena tab');

    // The tab is opened; the relay delivers by itself and the warning goes away.
    relayDelivers();
    await shows('Arena is working');
    await waitFor(() => dom.window.document.querySelector('[role="alert"]') === null, 'the warning to clear');
    expect($('.stage--active').textContent).toContain('Execute');
    expect(text()).toContain('Arena accepted the task.');
    expect(text()).toContain('arena.ai');
  });

  it('follows a task through Arena and the review, then hands a question to the user and goes on with the answer', async () => {
    await pairAndCreateProject();
    await shows('Going to Arena');
    const dispatchId = relayDelivers();
    await shows('Arena is working');
    orchestrator().reportRelay(projectId(), 'T-1', { dispatchId, phase: 'generating', message: 'Arena is working…', attention: false, chars: 1234 });
    await shows(/1[,.\s]?234 characters so far/);

    // The relay brings the reply back; Gemini reviews it, must quote it, and then needs a decision.
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'The endpoint exists and the suite passes.', evidence: ['12 passed, 0 failed'], missing: [] } }]),
      toolResponse([{ name: 'request_user_input', args: { question: 'Should the endpoint also report the build version?', why: 'It changes the response format.', options: ['Yes, add the version', 'No, keep it minimal'] } }]),
      textResponse('T-1 is verified. One decision is yours before I continue.'),
    );
    orchestrator().recordArenaResponse(projectId(), 'T-1', { dispatchId, text: REPLY, source: 'auto', completion: 'marker' });

    await shows('Verified complete');
    await shows('One decision is yours before I continue.');
    expect($('.verdict').textContent).toContain('The endpoint exists and the suite passes.');
    expect($('.quotes').textContent).toContain('12 passed, 0 failed');
    expect(text()).toContain('read from the Arena tab');
    await shows('Waiting for your answer');
    expect(alertText()).toContain('Should the endpoint also report the build version?');
    // An open question needs an answer, not "Continue".
    expect(Array.from(dom.window.document.querySelectorAll('[role="alert"] button'), (b) => (b.textContent ?? '').trim())).toEqual(['Yes, add the version', 'No, keep it minimal']);
    expect($<HTMLTextAreaElement>('#composer-input').placeholder).toBe('Your answer');

    // One click answers, and the work goes on to its end.
    h.fake.enqueue(toolResponse([{ name: 'mark_objective_complete', args: { summary: 'GET /health is built and tested.' } }]), textResponse('Kept it minimal. The objective is met.'));
    button('No, keep it minimal').click();
    await shows('Objective complete');
    await shows('The objective is met.');
    expect(dom.window.document.querySelector('[role="alert"]')).toBeNull();
    expect(h.fake.pending).toBe(0);

    // The record survives a reload of the page.
    dom.window.close();
    boot();
    await shows('Verified complete');
    expect(text()).toContain('T-1 is verified.');
    expect(text()).toContain('Objective complete');
  });

  it('pauses, resumes and stops the session from the top bar', async () => {
    await pairAndCreateProject();
    await shows('Going to Arena');
    orchestrator().relayWork();

    button('Pause').click();
    await shows('Paused');
    await shows('This task is sent when you resume.');
    expect((await h.companion.orchestrator.relayWork()).items).toEqual([]);
    expect($<HTMLTextAreaElement>('#composer-input').disabled).toBe(true);
    expect(text()).toContain('Session paused. Resume it to continue.');

    button('Resume').click();
    await shows('Running by itself');
    expect(orchestrator().relayWork().items).toHaveLength(1);
    expect($<HTMLTextAreaElement>('#composer-input').disabled).toBe(false);

    // Stopping asks once more, then cancels the open task.
    button('Stop').click();
    await waitFor(() => buttons().includes('Stop session?'), 'the confirmation');
    button('Stop session?').click();
    await shows('Stopped');
    await shows('Cancelled');
    expect(h.companion.store.get(projectId())?.tasks[0]?.status).toBe('cancelled');
    expect(orchestrator().relayWork().items).toEqual([]);
    button('Continue the work');
  });

  it('explains a Gemini failure where the user will see it, and continues on request', async () => {
    await pairAndCreateProject([{ kind: 'error', status: 403, body: errorBody(403, 'PERMISSION_DENIED', 'The caller does not have permission') }]);
    await shows('Needs you');
    await waitFor(() => alertText().length > 0, 'the explanation');
    expect(alertText()).toMatch(/Gemini/);
    expect(alertText()).toMatch(/permission/i);
    button('Gemini settings');
    expect($<HTMLTextAreaElement>('#composer-input').disabled).toBe(false);
    expect(h.companion.store.get(projectId())?.session.blocker?.kind).toBe('gemini');

    h.fake.enqueue(...sendsTask());
    Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>('[role="alert"] button')).find((b) => (b.textContent ?? '').trim() === 'Continue')?.click();
    await shows('Going to Arena');
    await shows('Running by itself');
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent ?? '').not.toMatch(/permission/i);
  });

  it('offers recovery by hand for a reply AgentLink cannot read, without making it part of the flow', async () => {
    await pairAndCreateProject();
    await shows('Going to Arena');
    relayDelivers();
    await shows('AgentLink collects the reply by itself when Arena has finished.');

    button('Take the reply as it is now').click();
    await waitFor(() => backgroundRequests.some((r) => r.type === 'agentlink:ui:captureResponse'), 'the capture request');
    expect(backgroundRequests.find((r) => r.type === 'agentlink:ui:captureResponse')).toMatchObject({ projectId: projectId(), taskId: 'T-1' });

    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'partial', summary: 'The endpoint exists; the test run is not shown.', evidence: ['Added GET /health in src/server.ts.'], missing: ['`npm test` passes'] } }]),
      toolResponse([{ name: 'request_user_input', args: { question: 'The test run is missing. Ask Arena to run the tests?', why: 'The criterion is not shown.', options: [] } }]),
      textResponse('T-1 is only partly shown.'),
    );
    button('Paste the reply by hand…').click();
    await waitFor(() => dom.window.document.querySelector('#paste-reply') !== null, 'the paste field');
    type('#paste-reply', 'Added GET /health in src/server.ts.');
    await submit('#paste-reply');

    await shows('Partly done');
    await shows('pasted by you');
    expect($('.verdict').textContent).toContain('the test run is not shown');
    expect(text()).toContain('`npm test` passes');
  });

  it('opens the companion page for the API key instead of asking for it', async () => {
    await pairAndCreateProject();
    button('Settings').click();
    await shows('Change API key');
    expect(dom.window.document.querySelector('input[id*="key" i]')).toBeNull();
    button('Change API key').click();
    await waitFor(() => openedTabs.length === 1, 'the settings tab');
    expect(openedTabs[0]).toBe(`${h.companion.server.address}/settings#token=${encodeURIComponent(h.companion.token)}`);
    expect(text()).toContain('No Arena tab is open in this browser.');
  });

  it('uses the single-pane layout in the sidebar', async () => {
    stored = {};
    boot('?surface=sidebar');
    await shows('Companion not running');
    expect(dom.window.document.documentElement.dataset.surface).toBe('sidebar');
  });
});
