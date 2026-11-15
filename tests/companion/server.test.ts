import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanionEvent } from '../../src/shared/api.js';
import { invalidKeyBody, INVALID_KEY, OTHER_VALID_KEY, textResponse, toolResponse, VALID_KEY } from '../helpers/fakeGemini.js';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

let h: Harness;
let base: string;

beforeEach(async () => {
  h = await createHarness();
  await h.companion.server.listen();
  base = h.companion.server.address;
});
afterEach(async () => {
  await h.cleanup();
});

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  origin?: string;
  headers?: Record<string, string>;
  rawBody?: string;
}

async function call(path: string, options: CallOptions = {}): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...options.headers };
  const token = options.token === undefined ? h.companion.token : options.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.origin) headers.Origin = options.origin;
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] ??= 'application/json';
  }
  const response = await fetch(`${base}${path}`, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, body, redirect: 'manual' });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

/** A request with a hand-set Host header, which fetch() does not allow. */
function rawGet(path: string, host: string): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path, method: 'GET', headers: { Host: host, Authorization: `Bearer ${h.companion.token}` } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const EXTENSION_ORIGIN = 'moz-extension://0d3f6a2e-1111-2222-3333-444455556666';

describe('access control', () => {
  it('answers the health check without a token and reveals nothing else', async () => {
    const res = await call('/v1/health', { token: null });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, name: 'agentlink-companion', version: 'test' });
  });

  it('requires the pairing token for everything else', async () => {
    for (const path of ['/v1/status', '/v1/projects', '/v1/credentials', '/v1/gemini/models', '/v1/events']) {
      const none = await call(path, { token: null });
      expect([path, none.status, none.json?.error?.code]).toEqual([path, 401, 'unauthorized']);
    }
    expect((await call('/v1/status', { token: 'x'.repeat(43) })).status).toBe(401);
    expect((await call('/v1/status', { token: `${h.companion.token}x` })).status).toBe(401);
    expect((await call('/v1/status')).status).toBe(200);
    expect(h.fake.requests).toHaveLength(0);
  });

  it('refuses web pages, even with a valid token', async () => {
    for (const origin of ['https://evil.example', 'https://arena.ai', 'null', 'http://127.0.0.1:9']) {
      const res = await call('/v1/status', { origin });
      expect([origin, res.status, res.json.error.code]).toEqual([origin, 403, 'forbidden_origin']);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    const preflight = await call('/v1/status', { method: 'OPTIONS', origin: 'https://evil.example', token: null });
    expect(preflight.status).toBe(403);
  });

  it('accepts the extension origin and answers its CORS preflight', async () => {
    const preflight = await call('/v1/projects', { method: 'OPTIONS', origin: EXTENSION_ORIGIN, token: null, headers: { 'Access-Control-Request-Method': 'POST' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(EXTENSION_ORIGIN);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    const res = await call('/v1/status', { origin: EXTENSION_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION_ORIGIN);
  });

  it('only answers requests addressed to its loopback name (DNS-rebinding defence)', async () => {
    const port = new URL(base).port;
    expect((await rawGet('/v1/status', `attacker.example:${port}`)).status).toBe(403);
    expect((await rawGet('/v1/status', 'attacker.example')).status).toBe(403);
    expect((await rawGet('/v1/status', `127.0.0.1:${port}`)).status).toBe(200);
    expect((await rawGet('/v1/status', `localhost:${port}`)).status).toBe(200);
  });

  it('rejects malformed requests cleanly', async () => {
    expect((await call('/v1/nope')).json.error.code).toBe('not_found');
    expect((await call('/v1/status', { method: 'DELETE' })).status).toBe(405);
    const wrongType = await call('/v1/projects', { method: 'POST', rawBody: 'name=x', headers: { 'Content-Type': 'text/plain' } });
    expect(wrongType.status).toBe(415);
    const badJson = await call('/v1/projects', { method: 'POST', rawBody: '{nope', headers: { 'Content-Type': 'application/json' } });
    expect([badJson.status, badJson.json.error.code]).toEqual([400, 'invalid_json']);
    const missing = await call('/v1/projects', { body: { name: 'No objective' } });
    expect([missing.status, missing.json.error.code]).toEqual([400, 'invalid_request']);
    expect((await call('/v1/projects/p_000000000000')).json.error.code).toBe('project_not_found');
  });
});

describe('API key handling over HTTP', () => {
  it('saves and verifies a key from the settings page, and never returns it', async () => {
    const bare = await createHarness({ saveKey: null });
    try {
      await bare.companion.server.listen();
      const url = bare.companion.server.address;
      const auth = { Authorization: `Bearer ${bare.companion.token}`, 'Content-Type': 'application/json', Origin: url };
      const before = await (await fetch(`${url}/v1/credentials`, { headers: auth })).json();
      expect(before.gemini).toMatchObject({ state: 'no_key', keyConfigured: false, keySource: null });

      const saved = await fetch(`${url}/v1/credentials`, { method: 'PUT', headers: auth, body: JSON.stringify({ apiKey: `  ${VALID_KEY}\n` }) });
      const savedText = await saved.text();
      expect(saved.status).toBe(200);
      expect(savedText).not.toContain(VALID_KEY);
      const status = JSON.parse(savedText).gemini;
      expect(status).toMatchObject({ state: 'connected', keyConfigured: true, keySource: 'saved', model: 'gemini-4-hydrogen', error: null });
      expect(status.keyFingerprint).toMatch(/^[0-9a-f]{6,16}$/);
      expect(VALID_KEY).not.toContain(status.keyFingerprint);
      expect(bare.fake.requests.every((r) => r.apiKey === VALID_KEY)).toBe(true);

      for (const path of ['/v1/status', '/v1/credentials', '/v1/gemini/models', '/v1/projects']) {
        const text = await (await fetch(`${url}${path}`, { headers: auth })).text();
        expect(text).not.toContain(VALID_KEY);
      }
      expect(bare.logs.join('\n')).not.toContain(VALID_KEY);
    } finally {
      await bare.cleanup();
    }
  });

  it('reports an invalid key as invalid, not as connected', async () => {
    h.fake.enqueue({ kind: 'error', status: 400, body: invalidKeyBody() });
    const res = await call('/v1/credentials', { method: 'PUT', body: { apiKey: INVALID_KEY }, origin: base });
    expect(res.status).toBe(200);
    expect(res.json.gemini).toMatchObject({ state: 'invalid_key', keyConfigured: true });
    expect(res.json.gemini.error.kind).toBe('invalid_key');
    expect(res.json.gemini.error.message).toMatch(/API key/i);
    expect(res.text).not.toContain(INVALID_KEY);
    expect((await call('/v1/status')).json.gemini.state).toBe('invalid_key');
  });

  it('refuses obviously malformed keys without calling Gemini', async () => {
    for (const apiKey of ['', 'short', 'has spaces in the middle of it', 42, null]) {
      const res = await call('/v1/credentials', { method: 'PUT', body: { apiKey }, origin: base });
      expect([String(apiKey), res.status, res.json.error.code]).toEqual([String(apiKey), 400, 'invalid_request']);
    }
    expect(h.fake.requests).toHaveLength(0);
    expect(h.companion.credentials.resolve()?.apiKey).toBe(VALID_KEY);
  });

  it('does not let extension pages submit, replace or remove a key', async () => {
    const put = await call('/v1/credentials', { method: 'PUT', body: { apiKey: OTHER_VALID_KEY }, origin: EXTENSION_ORIGIN });
    expect([put.status, put.json.error.code]).toEqual([403, 'forbidden_origin']);
    const del = await call('/v1/credentials', { method: 'DELETE', origin: EXTENSION_ORIGIN });
    expect(del.status).toBe(403);
    expect(h.companion.credentials.resolve()?.apiKey).toBe(VALID_KEY);
    // Reading the status (never the key) and testing the connection stay available to the extension.
    const test = await call('/v1/gemini/test', { method: 'POST', origin: EXTENSION_ORIGIN });
    expect(test.json.gemini.state).toBe('connected');
    expect(test.text).not.toContain(VALID_KEY);
  });

  it('updates and removes the key', async () => {
    const updated = await call('/v1/credentials', { method: 'PUT', body: { apiKey: OTHER_VALID_KEY }, origin: base });
    expect(updated.json.gemini.state).toBe('connected');
    expect(h.fake.requests.at(-1)?.apiKey).toBe(OTHER_VALID_KEY);

    const removed = await call('/v1/credentials', { method: 'DELETE', origin: base });
    expect(removed.json.gemini).toMatchObject({ state: 'no_key', keyConfigured: false });
    const test = await call('/v1/gemini/test', { method: 'POST' });
    expect(test.json.gemini.state).toBe('no_key');

    const project = await call('/v1/projects', { body: { name: 'P', objective: 'O' } });
    const message = await call(`/v1/projects/${project.json.project.id}/messages`, { body: { text: 'hi' } });
    expect([message.status, message.json.error.code]).toEqual([409, 'gemini_not_configured']);
  });

  it('lists real models and switches the model without touching anything else', async () => {
    const models = await call('/v1/gemini/models');
    expect(models.json.current).toBe('gemini-4-hydrogen');
    expect(models.json.currentAvailable).toBe(true);
    const ids = models.json.models.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash']));
    // Models that cannot hold a conversation are not offered.
    expect(ids).not.toContain('gemini-embedding-2');
    expect(ids).not.toContain('gemini-3.8-flash-tts');

    const patched = await call('/v1/settings', { method: 'PATCH', body: { model: 'gemini-4-argon' } });
    expect(patched.json.settings.model).toBe('gemini-4-argon');
    await waitFor(() => h.companion.gemini.status().state === 'connected', 'the new model to be verified');
    expect(h.companion.gemini.status().model).toBe('gemini-4-argon');

    const project = await call('/v1/projects', { body: { name: 'P', objective: 'O' } });
    h.fake.enqueue(textResponse('Hello from argon.'));
    await call(`/v1/projects/${project.json.project.id}/messages`, { body: { text: 'hi' } });
    await h.companion.orchestrator.whenIdle(project.json.project.id);
    expect(h.fake.lastGenerate().path).toContain('/models/gemini-4-argon:streamGenerateContent');

    const bad = await call('/v1/settings', { method: 'PATCH', body: { model: 'not a model!' } });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'invalid_request']);
    const unknown = await call('/v1/settings', { method: 'PATCH', body: { thinkingLevel: 'minimal' } });
    expect(unknown.status).toBe(400);
  });
});

describe('the workflow over HTTP and the event stream', () => {
  async function openEvents(projectId?: string): Promise<{ events: CompanionEvent[]; close: () => void }> {
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/events${projectId ? `?projectId=${projectId}` : ''}`, {
      headers: { Authorization: `Bearer ${h.companion.token}`, Origin: EXTENSION_ORIGIN },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events: CompanionEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as CompanionEvent);
          }
        }
      } catch {
        // Closed by the test.
      }
    })();
    await waitFor(() => events.length >= 2, 'the stream greeting');
    return { events, close: () => controller.abort() };
  }

  const README_TASK = { title: 'Add a README', instructions: 'Write a README with install and test steps.', context: 'Empty repo.', acceptance_criteria: ['README.md exists'], rationale: 'First step.' };

  it('runs objective → task → claim → confirm → reply → review → complete through the API, with no approval step', async () => {
    const stream = await openEvents();
    expect(stream.events[0]).toEqual({ type: 'hello', version: 'test' });
    expect(stream.events[1]).toMatchObject({ type: 'gemini' });
    expect(JSON.stringify(stream.events)).not.toContain(VALID_KEY);

    // Nothing for the extension to do yet; asking is what marks it as in contact.
    expect((await call('/v1/status')).json.relay).toMatchObject({ online: false, seenAt: null });
    expect((await call('/v1/relay/work')).json).toEqual({ items: [] });
    expect((await call('/v1/status')).json.relay.online).toBe(true);

    // Creating the project with the objective is the only thing the user does.
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: README_TASK }]), textResponse('The first task is on its way to Arena.', { pieces: 3 }));
    const created = await call('/v1/projects', { body: { name: 'HTTP flow', objective: 'Prove the API works', constraints: ['No secrets in code'], start: true } });
    expect(created.status).toBe(200);
    const id = created.json.project.id as string;
    expect(id).toMatch(/^p_[0-9a-f]{12}$/);
    expect(created.json.project.session.status).toBe('running');
    await h.companion.orchestrator.whenIdle(id);
    await waitFor(() => stream.events.some((e) => e.type === 'project' && e.project.tasks[0]?.status === 'queued'), 'the queued task on the stream');
    const scoped = await openEvents(id);

    // The extension finds the task, reports progress, and delivers it.
    const work = await call('/v1/relay/work');
    expect(work.json.items).toHaveLength(1);
    expect(work.json.items[0]).toMatchObject({ projectId: id, projectName: 'HTTP flow', task: { id: 'T-1', status: 'queued' } });
    const waiting = await call(`/v1/projects/${id}/tasks/T-1/relay`, { body: { phase: 'waiting_for_arena', message: 'No Arena tab is open.', attention: true, chars: 0 } });
    expect(waiting.status).toBe(204);
    expect((await call(`/v1/projects/${id}/tasks/T-1`)).json.task.relay).toMatchObject({ phase: 'waiting_for_arena', attention: true });

    const claim = await call(`/v1/projects/${id}/tasks/T-1/dispatch/claim`, { body: { tabId: 12, tabUrl: 'https://arena.ai/c/1' } });
    expect(claim.status).toBe(200);
    expect(claim.json.prompt).toContain('Write a README with install and test steps.');
    expect(claim.json.prompt).toContain('No secrets in code');
    expect(claim.json.prompt).toContain(claim.json.task.dispatch.ref);
    const again = await call(`/v1/projects/${id}/tasks/T-1/dispatch/claim`, { body: {} });
    expect([again.status, again.json.error.code]).toEqual([409, 'not_dispatchable']);

    const confirmed = await call(`/v1/projects/${id}/tasks/T-1/dispatch/confirm`, { body: { dispatchId: claim.json.dispatchId } });
    expect(confirmed.json.task.status).toBe('awaiting_response');
    expect((await call('/v1/relay/work')).json.items[0].task.status).toBe('awaiting_response');

    h.fake.enqueue(
      toolResponse([{ name: 'evaluate_arena_result', args: { task_id: 'T-1', verdict: 'complete', summary: 'README written.', evidence: ['Created README.md with install and test sections'] } }]),
      toolResponse([{ name: 'mark_objective_complete', args: { summary: 'The README exists.' } }]),
      textResponse('T-1 is verified and the objective is met.', { pieces: 3 }),
    );
    const reply = await call(`/v1/projects/${id}/tasks/T-1/arena-response`, {
      body: { dispatchId: claim.json.dispatchId, text: 'Created README.md with install and test sections.', source: 'auto', completion: 'marker' },
    });
    expect(reply.json.task.status).toBe('evaluating');
    const duplicate = await call(`/v1/projects/${id}/tasks/T-1/arena-response`, { body: { dispatchId: claim.json.dispatchId, text: 'Created README.md with install and test sections.', source: 'auto' } });
    expect([duplicate.status, duplicate.json.error.code]).toEqual([409, 'response_already_recorded']);
    await h.companion.orchestrator.whenIdle(id);
    // The stream is delivered asynchronously: wait until the end of the turn has arrived on it.
    await waitFor(() => scoped.events.some((e) => e.type === 'turn' && !e.turn.active && e.turn.phase === 'idle'), 'the end of the turn on the stream');
    const deltas = scoped.events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : ''));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('T-1 is verified and the objective is met.');
    expect(scoped.events.some((e) => e.type === 'project' && e.project.session.status === 'completed')).toBe(true);
    scoped.close();

    const view = await call(`/v1/projects/${id}`);
    expect(view.json.project.tasks[0]).toMatchObject({ status: 'completed', evaluation: { verdict: 'complete' }, arenaResponse: { completion: 'marker' } });
    expect(view.json.project.session.status).toBe('completed');
    expect(view.json.project.status).toBe('complete');
    expect(view.json.project.transcript).toBeUndefined();
    expect(view.json.conversation.at(-1).text).toBe('T-1 is verified and the objective is met.');
    expect(view.json.conversation.some((e: { role: string }) => e.role === 'user')).toBe(false);
    expect(view.json.turn).toMatchObject({ active: false });
    expect((await call('/v1/relay/work')).json).toEqual({ items: [] });
    stream.close();
  });

  it('has no approval, rejection or task-editing endpoints any more', async () => {
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: README_TASK }]), textResponse('Sent.'));
    const id = (await call('/v1/projects', { body: { name: 'No gates', objective: 'Run by itself', start: true } })).json.project.id as string;
    await h.companion.orchestrator.whenIdle(id);
    for (const [method, path] of [
      ['POST', `/v1/projects/${id}/tasks/T-1/approve`],
      ['POST', `/v1/projects/${id}/tasks/T-1/reject`],
      ['POST', `/v1/projects/${id}/tasks/T-1/evaluate`],
      ['PATCH', `/v1/projects/${id}/tasks/T-1`],
    ] as const) {
      const response = await call(path, { method, body: {} });
      expect([method, path, [404, 405].includes(response.status)]).toEqual([method, path, true]);
    }
    expect((await call(`/v1/projects/${id}/tasks/T-1`)).json.task.status).toBe('queued');
  });

  it('carries the delivery-recovery and no-reply reports of the extension', async () => {
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: README_TASK }]), textResponse('Sent.'));
    const id = (await call('/v1/projects', { body: { name: 'Recovery', objective: 'Recover', start: true } })).json.project.id as string;
    await h.companion.orchestrator.whenIdle(id);
    const base = `/v1/projects/${id}/tasks/T-1`;

    const first = await call(`${base}/dispatch/claim`, { body: {} });
    const failed = await call(`${base}/dispatch/fail`, { body: { dispatchId: first.json.dispatchId, error: 'No acknowledgement from Arena.', submitted: 'unknown' } });
    expect(failed.json.task).toMatchObject({ status: 'awaiting_response', dispatch: { unconfirmed: true } });
    const stale = await call(`${base}/dispatch/reset`, { body: { dispatchId: 'nope', reason: 'x' } });
    expect([stale.status, stale.json.error.code]).toEqual([409, 'stale_dispatch']);
    const reset = await call(`${base}/dispatch/reset`, { body: { dispatchId: first.json.dispatchId, reason: 'The task is not in the Arena conversation.' } });
    expect(reset.json.task.status).toBe('queued');

    const second = await call(`${base}/dispatch/claim`, { body: {} });
    await call(`${base}/dispatch/confirm`, { body: { dispatchId: second.json.dispatchId } });
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: { ...README_TASK, title: 'Add a README (second try)' } }]), textResponse('Trying again.'));
    const silent = await call(`${base}/no-response`, { body: { dispatchId: second.json.dispatchId, reason: 'Arena wrote nothing for 5 minutes.' } });
    expect(silent.json.task).toMatchObject({ status: 'no_response', evaluation: null });
    await h.companion.orchestrator.whenIdle(id);
    expect((await call(`/v1/projects/${id}`)).json.project.tasks.map((t: { status: string }) => t.status)).toEqual(['no_response', 'queued']);
  });

  it('exposes pause, resume and stop, and enforces them', async () => {
    h.fake.enqueue(toolResponse([{ name: 'dispatch_arena_task', args: README_TASK }]), textResponse('Sent.'));
    const id = (await call('/v1/projects', { body: { name: 'Controls', objective: 'Test controls', start: true } })).json.project.id as string;
    await h.companion.orchestrator.whenIdle(id);

    const paused = await call(`/v1/projects/${id}/session`, { body: { action: 'pause' } });
    expect(paused.json.project.session.status).toBe('paused');
    const blocked = await call(`/v1/projects/${id}/messages`, { body: { text: 'still there?' } });
    expect([blocked.status, blocked.json.error.code]).toEqual([409, 'session_not_running']);
    const claim = await call(`/v1/projects/${id}/tasks/T-1/dispatch/claim`, { body: {} });
    expect([claim.status, claim.json.error.code]).toEqual([409, 'session_not_running']);
    expect((await call('/v1/relay/work')).json.items).toEqual([]);
    expect((await call(`/v1/projects/${id}/session`, { body: { action: 'resume' } })).json.project.session.status).toBe('running');
    expect((await call('/v1/relay/work')).json.items).toHaveLength(1);
    expect((await call(`/v1/projects/${id}/session`, { body: { action: 'stop' } })).json.project.session.status).toBe('stopped');
    const bad = await call(`/v1/projects/${id}/session`, { body: { action: 'explode' } });
    expect(bad.status).toBe(400);
    const wrong = await call(`/v1/projects/${id}/session`, { body: { action: 'resume' } });
    expect([wrong.status, wrong.json.error.code]).toEqual([409, 'invalid_transition']);
  });

  it('only forwards events for the project a stream asked for', async () => {
    const a = (await call('/v1/projects', { body: { name: 'A', objective: 'a' } })).json.project.id as string;
    const b = (await call('/v1/projects', { body: { name: 'B', objective: 'b' } })).json.project.id as string;
    const stream = await openEvents(a);
    h.fake.enqueue(textResponse('for b'));
    await call(`/v1/projects/${b}/messages`, { body: { text: 'hi b' } });
    await h.companion.orchestrator.whenIdle(b);
    h.fake.enqueue(textResponse('for a'));
    await call(`/v1/projects/${a}/messages`, { body: { text: 'hi a' } });
    await h.companion.orchestrator.whenIdle(a);
    await waitFor(() => stream.events.some((e) => e.type === 'delta'), 'a delta for project A');
    const scoped = stream.events.filter((e) => 'projectId' in e);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((e) => 'projectId' in e && e.projectId === a)).toBe(true);
    stream.close();
  });
});

describe('settings page hosting', () => {
  it('serves the built page with a strict content security policy', async () => {
    const webDir = join(h.dataDir, 'web');
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, 'settings.html'), '<!doctype html><title>AgentLink</title>');
    writeFileSync(join(webDir, 'settings.js'), 'console.log(1)');
    writeFileSync(join(webDir, 'settings.css'), 'body{}');

    const root = await call('/', { token: null });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/settings');

    const page = await call('/settings', { token: null });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.text).not.toContain(h.companion.token);

    expect((await call('/settings.js', { token: null })).headers.get('content-type')).toContain('javascript');
    expect((await call('/settings.css', { token: null })).headers.get('content-type')).toContain('text/css');
    expect((await call('/../credentials.json', { token: null })).status).toBe(404);
    expect((await call('/credentials.json', { token: null })).status).toBe(404);
  });
});
