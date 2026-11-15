import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UiRequest, UiResult } from '../../src/shared/messages.js';
import { errorBody, textResponse, toolResponse, VALID_KEY } from '../helpers/fakeGemini.js';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

/**
 * Runs the real, bundled workspace UI in a DOM against a real companion.
 * Only the browser extension API, the background script and Gemini are stand-ins.
 */

let bundle = '';
let h: Harness;
let dom: JSDOM;
let stored: Record<string, unknown>;
let backgroundRequests: UiRequest[];
let openedTabs: string[];
let pageErrors: string[];
let deliverDispatches: boolean;

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
        if (request.type === 'agentlink:ui:dispatchTask' && deliverDispatches) {
          // Stands in for the background script typing the task into Arena and seeing it accepted.
          const claim = h.companion.orchestrator.claimDispatch(request.projectId, request.taskId, { tabId: 7, tabUrl: 'https://arena.ai/c/abc' });
          h.companion.orchestrator.confirmDispatch(request.projectId, request.taskId, claim.dispatchId);
        }
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

async function pairAndCreateProject(): Promise<void> {
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
  await shows('Describe what you want built.');
}

beforeEach(async () => {
  h = await createHarness();
  await h.companion.server.listen();
  stored = {};
  backgroundRequests = [];
  openedTabs = [];
  pageErrors = [];
  deliverDispatches = false;
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

  it('pairs, creates a project and shows live Gemini state', async () => {
    await pairAndCreateProject();
    expect(text()).toContain('Expose a health endpoint');
    expect(text()).toMatch(/Gemini/);
    // The constraint list is cleaned up and kept with the project.
    const project = h.companion.store.list()[0];
    expect(project?.name).toBe('Billing service');
    expect(h.companion.store.get(project?.id ?? '')?.constraints).toEqual(['Do not change the public API', 'Keep tests green']);
    // Pairing survives a reload; the Gemini key never reaches extension storage or the page.
    expect(JSON.stringify(stored)).toContain(h.companion.token);
    expect(JSON.stringify(stored)).not.toContain(VALID_KEY);
    expect(dom.window.document.documentElement.outerHTML).not.toContain(VALID_KEY);
  });

  it('streams a coordinator turn, shows the proposed task and waits for approval', async () => {
    await pairAndCreateProject();
    h.fake.enqueue(
      toolResponse([
        {
          name: 'propose_arena_task',
          args: { title: 'Add the health endpoint', instructions: 'Add GET /health returning {"ok":true}.', context: 'Express app in src/server.ts.', acceptance_criteria: ['`npm test` passes'], rationale: 'Smallest verifiable step.' },
        },
      ]),
      textResponse('I proposed **T-1**. Review it and approve when ready.'),
    );
    type('#composer-input', 'Add a health endpoint.');
    await submit('#composer-input');

    await shows('Approve and send to Arena');
    await shows('Review it and approve when ready.');
    expect(text()).toContain('Add the health endpoint');
    expect(text()).toContain('Needs your approval');
    expect(text()).toContain('T-1 is waiting for your decision');
    expect($('.stage--waiting').textContent).toContain('Approve');
    expect($('.prose strong').textContent).toBe('T-1');
    // Nothing went to the background before the user decided.
    expect(backgroundRequests.some((r) => r.type === 'agentlink:ui:dispatchTask')).toBe(false);

    // The exact prompt is available for inspection, constraints included.
    button(/Exact text that will be sent to Arena/).click();
    await shows('Do not change the public API');
    expect($('pre.reply').textContent).toMatch(/^# Task T-1: Add the health endpoint/);

    button('Approve and send to Arena').click();
    await waitFor(() => backgroundRequests.some((r) => r.type === 'agentlink:ui:dispatchTask'), 'the dispatch request');
    const dispatch = backgroundRequests.find((r) => r.type === 'agentlink:ui:dispatchTask');
    expect(dispatch).toMatchObject({ taskId: 'T-1' });
    await shows('Approved, not sent');
  });

  it('lets the user edit a proposed task before approving and reject it with a reason', async () => {
    await pairAndCreateProject();
    h.fake.enqueue(
      toolResponse([{ name: 'propose_arena_task', args: { title: 'Add endpoint', instructions: 'Add GET /health.', context: '', acceptance_criteria: ['It works'], rationale: 'First step.' } }]),
      textResponse('Proposed.'),
    );
    type('#composer-input', 'Go.');
    await submit('#composer-input');
    await shows('Approve and send to Arena');

    button('Edit').click();
    await waitFor(() => dom.window.document.querySelector('#task-criteria') !== null, 'the task editor');
    type('#task-title', 'Add the health endpoint with a test');
    type('#task-criteria', '`npm test` passes\nGET /health returns 200');
    await submit('#task-title');
    await shows('Add the health endpoint with a test');
    await shows('edited by you');
    expect(text()).toContain('GET /health returns 200');

    h.fake.enqueue(textResponse('Understood. I will propose something smaller.'));
    button('Reject').click();
    await waitFor(() => dom.window.document.querySelector('#reject-reason') !== null, 'the reason field');
    type('#reject-reason', 'Too broad');
    await submit('#reject-reason');
    await shows('Rejected by you');
    await shows('I will propose something smaller.');
    const project = h.companion.store.list()[0];
    expect(h.companion.store.get(project?.id ?? '')?.tasks[0]?.rejection?.reason).toBe('Too broad');
  });

  it('carries a task through Arena and shows the review with its quoted evidence', async () => {
    deliverDispatches = true;
    await pairAndCreateProject();
    h.fake.enqueue(
      toolResponse([{ name: 'propose_arena_task', args: { title: 'Add endpoint', instructions: 'Add GET /health.', context: '', acceptance_criteria: ['`npm test` passes'], rationale: 'First step.' } }]),
      textResponse('Proposed.'),
    );
    type('#composer-input', 'Go.');
    await submit('#composer-input');
    await shows('Approve and send to Arena');
    button('Approve and send to Arena').click();

    await shows('Capture reply now');
    expect(text()).toContain('Arena is working on T-1');
    expect($('.stage--active').textContent).toContain('Execute');

    // Arena's reply comes back by hand; Gemini reviews it and must quote it.
    const reply = 'Added GET /health in src/server.ts.\n$ npm test\n 12 passed, 0 failed';
    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'The endpoint exists and the suite passes.', evidence: ['12 passed, 0 failed'], missing: [] } }]),
      textResponse('T-1 is verified. Next I will propose the readiness check.'),
    );
    button('Paste reply…').click();
    await waitFor(() => dom.window.document.querySelector('#paste-reply') !== null, 'the paste field');
    type('#paste-reply', reply);
    await submit('#paste-reply');

    await shows('Verified complete');
    await shows('Next I will propose the readiness check.');
    expect($('.verdict').textContent).toContain('The endpoint exists and the suite passes.');
    expect($('.quotes').textContent).toContain('12 passed, 0 failed');
    expect(text()).toContain('pasted by you');
    expect(text()).toContain('No task in progress');

    // The record is in the activity log and survives a reload of the page.
    dom.window.close();
    boot();
    await shows('Verified complete');
    expect(text()).toContain('T-1 is verified.');
  });

  it('shows a Gemini failure in the conversation and keeps the composer usable', async () => {
    await pairAndCreateProject();
    h.fake.enqueue({ kind: 'error', status: 403, body: errorBody(403, 'PERMISSION_DENIED', 'The caller does not have permission') });
    type('#composer-input', 'Hello');
    await submit('#composer-input');
    await waitFor(() => dom.window.document.querySelector('.entry__flag--bad') !== null, 'the failed turn');
    expect($<HTMLTextAreaElement>('#composer-input').disabled).toBe(false);
    expect($('.entry__flag--bad').textContent?.length).toBeGreaterThan(10);
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
