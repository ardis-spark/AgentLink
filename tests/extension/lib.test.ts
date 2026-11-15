import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanionEvent } from '../../src/shared/api.js';
import { DEFAULT_ARENA_ADAPTER_CONFIG } from '../../src/shared/messages.js';
import { describeGemini } from '../../src/shared/statusText.js';
import type { GeminiStatus } from '../../src/shared/types.js';
import { CompanionClient, CompanionError, type StreamState } from '../../src/extension/lib/companionClient.js';
import { normalizeCompanionUrl, sanitizeAdapterConfig, sanitizeSettings } from '../../src/extension/lib/settings.js';
import { createSseParser } from '../../src/extension/lib/sse.js';
import { textResponse, VALID_KEY } from '../helpers/fakeGemini.js';
import { createHarness, waitFor, type Harness } from '../helpers/harness.js';

describe('extension settings', () => {
  it('only accepts a loopback companion address', () => {
    expect(normalizeCompanionUrl('')).toBe('http://127.0.0.1:47821');
    expect(normalizeCompanionUrl(' http://127.0.0.1:5000/ ')).toBe('http://127.0.0.1:5000');
    expect(normalizeCompanionUrl('localhost:47821')).toBe('http://localhost:47821');
    for (const bad of ['https://127.0.0.1:47821', 'http://example.com:47821', 'http://192.168.1.10:47821', 'http://user:pw@127.0.0.1:47821', 'http://127.0.0.1.evil.example']) {
      expect(() => normalizeCompanionUrl(bad), bad).toThrow();
    }
  });

  it('falls back to safe defaults for missing or damaged stored settings', () => {
    expect(sanitizeSettings(undefined)).toEqual({ companionUrl: 'http://127.0.0.1:47821', pairingToken: '', preferredTab: null, adapter: DEFAULT_ARENA_ADAPTER_CONFIG });
    const cleaned = sanitizeSettings({ companionUrl: 'http://evil.example', pairingToken: '  tok  ', preferredTab: { tabId: 'x' }, adapter: { settleMs: 5, maxWaitMs: 'soon', composerSelector: 42 } });
    expect(cleaned.companionUrl).toBe('http://127.0.0.1:47821');
    expect(cleaned.pairingToken).toBe('tok');
    expect(cleaned.preferredTab).toBeNull();
    expect(cleaned.adapter).toEqual({ ...DEFAULT_ARENA_ADAPTER_CONFIG, settleMs: 2_000 });
    expect(sanitizeAdapterConfig({ responseSelector: '  .reply  ' }).responseSelector).toBe('.reply');
  });

  it('has no field that could hold a Gemini key', () => {
    expect(Object.keys(sanitizeSettings({ geminiApiKey: VALID_KEY, apiKey: VALID_KEY })).sort()).toEqual(['adapter', 'companionUrl', 'pairingToken', 'preferredTab']);
    expect(JSON.stringify(sanitizeSettings({ geminiApiKey: VALID_KEY }))).not.toContain(VALID_KEY);
  });
});

describe('event stream parser', () => {
  it('reassembles frames split across chunks and ignores comments', () => {
    const seen: string[] = [];
    const parser = createSseParser((data) => seen.push(data));
    parser.feed('data: {"a":');
    parser.feed('1}\n\n: keep-alive\n\ndata: {"b":2}\r\n\r\nda');
    parser.feed('ta:{"c":3}\n\n');
    expect(seen).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe('Gemini status wording', () => {
  const base: GeminiStatus = { state: 'connected', model: 'gemini-4-hydrogen', keyConfigured: true, keySource: 'saved', keyFingerprint: 'abc123', lastCheckedAt: null, lastOkAt: null, error: null };
  it('only says "Connected" for the connected state', () => {
    const states: GeminiStatus['state'][] = ['no_key', 'unverified', 'checking', 'connected', 'invalid_key', 'permission_denied', 'model_unavailable', 'rate_limited', 'unreachable', 'error'];
    const labels = states.map((state) => describeGemini({ ...base, state }));
    expect(labels.filter((l) => l.tone === 'ok').map((l) => l.label)).toEqual(['Connected']);
    expect(labels.every((l) => l.label.length > 0 && l.detail.length > 0)).toBe(true);
    expect(describeGemini({ ...base, state: 'invalid_key', error: { kind: 'invalid_key', message: 'API key not valid.', status: 400, retryable: false } }).detail).toBe('API key not valid.');
  });
});

describe('companion client', () => {
  let h: Harness;
  let endpoint: { url: string; token: string };
  let client: CompanionClient;

  beforeEach(async () => {
    h = await createHarness();
    await h.companion.server.listen();
    endpoint = { url: h.companion.server.address, token: h.companion.token };
    client = new CompanionClient(() => endpoint);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function failure(work: Promise<unknown>): Promise<CompanionError> {
    try {
      await work;
    } catch (error) {
      expect(error).toBeInstanceOf(CompanionError);
      return error as CompanionError;
    }
    throw new Error('Expected a CompanionError.');
  }

  it('distinguishes not paired, wrong token, offline and a foreign service', async () => {
    expect((await client.health()).name).toBe('agentlink-companion');
    expect((await client.status()).gemini.keyConfigured).toBe(true);

    endpoint.token = '';
    expect((await failure(client.status())).code).toBe('unpaired');
    endpoint.token = 'wrong-token';
    const unauthorized = await failure(client.status());
    expect([unauthorized.status, unauthorized.code]).toEqual([401, 'unauthorized']);

    endpoint = { url: h.fake.url, token: h.companion.token };
    expect((await failure(client.health())).code).toBe('not_agentlink');

    endpoint = { url: 'http://127.0.0.1:9', token: h.companion.token };
    const offline = await failure(client.status());
    expect(offline.code).toBe('offline');
    expect(offline.message).toContain('npm start');
  });

  it('passes the companion’s own explanation through on a refusal', async () => {
    const { project } = await client.createProject({ name: 'P', objective: 'O' });
    const error = await failure(client.approveTask(project.id, 'T-9'));
    expect([error.status, error.code]).toEqual([404, 'task_not_found']);
    expect(error.message).toContain('T-9');
  });

  it('never receives the API key in anything it reads', async () => {
    const original = globalThis.fetch;
    const bodies: string[] = [];
    const spying = new CompanionClient(() => endpoint, async (input, init) => {
      const response = await original(input, init);
      bodies.push(await response.clone().text());
      return response;
    });
    await spying.status();
    await spying.testGemini();
    await spying.models(true);
    const { project } = await spying.createProject({ name: 'P', objective: 'O' });
    h.fake.enqueue(textResponse('Hello.'));
    await spying.sendMessage(project.id, 'hi');
    await h.companion.orchestrator.whenIdle(project.id);
    await spying.getProject(project.id);
    expect(bodies.length).toBeGreaterThanOrEqual(6);
    expect(bodies.join('\n')).not.toContain(VALID_KEY);
  });

  it('streams live events and reconnects after the companion restarts', async () => {
    const { project } = await client.createProject({ name: 'Stream', objective: 'See events' });
    const events: CompanionEvent[] = [];
    const states: StreamState[] = [];
    const close = client.openEvents({ projectId: project.id, onEvent: (e) => events.push(e), onState: (s) => states.push(s) });
    await waitFor(() => states.includes('open') && events.some((e) => e.type === 'hello'), 'the stream to open');

    h.fake.enqueue(textResponse('Streaming reply.', { pieces: 3 }));
    await client.sendMessage(project.id, 'hello');
    await waitFor(() => events.some((e) => e.type === 'turn' && !e.turn.active && e.turn.phase === 'idle'), 'the turn to finish');
    expect(events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : '')).join('')).toBe('Streaming reply.');

    // The companion goes away and comes back on the same address.
    const port = Number(new URL(endpoint.url).port);
    await h.companion.server.close();
    await waitFor(() => states.includes('reconnecting'), 'the stream to notice the outage');
    const next = h.restart();
    next.config.port = port;
    await next.server.listen();
    const reopened = states.length;
    await waitFor(() => states.slice(reopened).includes('open') || states.filter((s) => s === 'open').length >= 2, 'the stream to reconnect', 8_000);
    expect(events.filter((e) => e.type === 'hello').length).toBeGreaterThanOrEqual(2);

    close();
    expect(states.at(-1)).toBe('closed');
  });
});
