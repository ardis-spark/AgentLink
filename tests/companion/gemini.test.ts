import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GeminiError } from '../../src/companion/gemini/errors.js';
import { appendStreamPart, toRequestContents } from '../../src/companion/gemini/geminiService.js';
import { COORDINATOR_TOOLS } from '../../src/companion/coordinator/tools.js';
import type { GeminiStatus, WireContent, WirePart } from '../../src/shared/types.js';
import { errorBody, INVALID_KEY, OTHER_VALID_KEY, textResponse, toolResponse, VALID_KEY } from '../helpers/fakeGemini.js';
import { createHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

const hello: WireContent[] = [{ role: 'user', parts: [{ text: 'Hello' }] }];

async function failure(promise: Promise<unknown>): Promise<GeminiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GeminiError);
    return error as GeminiError;
  }
  throw new Error('Expected the request to fail.');
}

describe('Gemini authentication and connection testing', () => {
  it('reports no_key without contacting the API when no key is configured', async () => {
    const bare = await createHarness({ saveKey: null });
    try {
      expect(bare.companion.gemini.status().state).toBe('no_key');
      expect((await bare.companion.gemini.testConnection()).state).toBe('no_key');
      const error = await failure(bare.companion.gemini.generate({ systemInstruction: 's', contents: hello }));
      expect(error.kind).toBe('no_key');
      expect(bare.fake.requests).toHaveLength(0);
    } finally {
      await bare.cleanup();
    }
  });

  it('is "unverified" until a real call succeeds, then "connected"', async () => {
    const { gemini } = h.companion;
    expect(gemini.status()).toMatchObject({ state: 'unverified', keyConfigured: true, keySource: 'saved', model: 'gemini-4-hydrogen' });

    const status = await gemini.testConnection();
    expect(status.state).toBe('connected');
    expect(status.error).toBeNull();
    expect(status.lastOkAt).not.toBeNull();
    // The key travels in the x-goog-api-key header of a real request.
    expect(h.fake.requests[0]).toMatchObject({ method: 'GET', apiKey: VALID_KEY });
    expect(h.fake.requests[0]?.path).toMatch(/\/models$/);
  });

  it('detects an invalid API key', async () => {
    h.companion.credentials.save(INVALID_KEY);
    const status = await h.companion.gemini.testConnection();
    expect(status.state).toBe('invalid_key');
    expect(status.error).toMatchObject({ kind: 'invalid_key', status: 400, retryable: false });
    expect(status.lastOkAt).toBeNull();
  });

  it('fails a generation with an invalid key without retrying, and flips the state', async () => {
    h.companion.credentials.save(INVALID_KEY);
    const error = await failure(h.companion.gemini.generate({ systemInstruction: 's', contents: hello }));
    expect(error.kind).toBe('invalid_key');
    expect(h.fake.generateRequests).toHaveLength(1);
    expect(h.companion.gemini.status().state).toBe('invalid_key');
  });

  it('returns to "unverified" when the key changes, and verifies the new key', async () => {
    const { gemini, credentials } = h.companion;
    await gemini.testConnection();
    const first = gemini.status();
    credentials.save(OTHER_VALID_KEY);
    const changed = gemini.refresh();
    expect(changed.state).toBe('unverified');
    expect(changed.keyFingerprint).not.toBe(first.keyFingerprint);
    expect((await gemini.testConnection()).state).toBe('connected');
    expect(h.fake.requests.at(-1)?.apiKey).toBe(OTHER_VALID_KEY);
  });

  it('reports a model the key cannot use as model_unavailable', async () => {
    h.companion.settings.update({ model: 'gemini-9-imaginary' });
    const status = await h.companion.gemini.testConnection();
    expect(status.state).toBe('model_unavailable');
    expect(status.error?.kind).toBe('model_not_found');
  });

  it('reports a network failure as unreachable', async () => {
    await h.fake.stop();
    const status = await h.companion.gemini.testConnection();
    expect(status.state).toBe('unreachable');
    expect(status.error).toMatchObject({ kind: 'network', retryable: true });
  });

  it('reports permission problems and rate limits distinctly', async () => {
    h.fake.listFailure = { kind: 'error', status: 403, body: errorBody(403, 'PERMISSION_DENIED', 'Generative Language API has not been used in this project.') };
    expect((await h.companion.gemini.testConnection()).state).toBe('permission_denied');
    h.fake.listFailure = { kind: 'error', status: 429, body: errorBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.') };
    expect((await h.companion.gemini.testConnection()).state).toBe('rate_limited');
    h.fake.listFailure = null;
    expect((await h.companion.gemini.testConnection()).state).toBe('connected');
  });

  it('notifies listeners about every state change', async () => {
    const seen: GeminiStatus['state'][] = [];
    h.companion.gemini.onStatusChange((s) => seen.push(s.state));
    await h.companion.gemini.testConnection();
    h.companion.credentials.save(INVALID_KEY);
    h.companion.gemini.refresh();
    await h.companion.gemini.testConnection();
    expect(seen).toEqual(['checking', 'connected', 'unverified', 'checking', 'invalid_key']);
  });

  it('lists only chat-capable Gemini models and caches the listing', async () => {
    const models = await h.companion.gemini.listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash']);
    expect(models[0]).toMatchObject({ displayName: 'Gemini 4 Hydrogen', inputTokenLimit: 1_048_576 });
    await h.companion.gemini.listModels();
    expect(h.fake.requests.filter((r) => r.path.endsWith('/models'))).toHaveLength(1);
    await h.companion.gemini.listModels({ force: true });
    expect(h.fake.requests.filter((r) => r.path.endsWith('/models'))).toHaveLength(2);
  });
});

describe('Gemini streaming', () => {
  it('streams text in order and returns the assembled result', async () => {
    h.fake.enqueue(textResponse('The quick brown fox jumps over the lazy dog.', { pieces: 5, chunkDelayMs: 5 }));
    const deltas: string[] = [];
    const result = await h.companion.gemini.generate({ systemInstruction: 'Be brief.', contents: hello, onDelta: (t) => deltas.push(t) });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('The quick brown fox jumps over the lazy dog.');
    expect(result.text).toBe('The quick brown fox jumps over the lazy dog.');
    expect(result.finishReason).toBe('STOP');
    expect(result.usage).toEqual({ promptTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(result.model).toBe('gemini-4-hydrogen');
    expect(h.companion.gemini.status().state).toBe('connected');
  });

  it('sends the system instruction, history and tools to the configured model, without sampling parameters', async () => {
    h.fake.enqueue(textResponse('ok'));
    await h.companion.gemini.generate({
      systemInstruction: 'You coordinate.',
      contents: [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'reply' }], model: 'gemini-4-hydrogen' },
        { role: 'user', parts: [{ text: 'second' }] },
      ],
      tools: COORDINATOR_TOOLS,
      toolMode: { mode: 'ANY', allowedFunctionNames: ['evaluate_arena_result'] },
    });
    const request = h.fake.lastGenerate();
    expect(request.path).toMatch(/\/models\/gemini-4-hydrogen:streamGenerateContent$/);
    expect(request.body.systemInstruction.parts[0].text).toBe('You coordinate.');
    expect(request.body.contents.map((c: any) => [c.role, c.parts[0].text])).toEqual([
      ['user', 'first'],
      ['model', 'reply'],
      ['user', 'second'],
    ]);
    expect(request.body.tools[0].functionDeclarations.map((f: any) => f.name)).toContain('propose_arena_task');
    expect(request.body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['evaluate_arena_result'] });
    // Sampling parameters are deprecated for current Gemini models and must not be sent.
    expect(JSON.stringify(request.body)).not.toMatch(/temperature|topP|topK/);
    expect(request.body.generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('switches model and thinking level through settings alone', async () => {
    h.companion.settings.update({ model: 'gemini-3.8-flash', thinkingLevel: 'low' });
    h.fake.enqueue(textResponse('ok'));
    const result = await h.companion.gemini.generate({ systemInstruction: 's', contents: hello });
    expect(result.model).toBe('gemini-3.8-flash');
    const request = h.fake.lastGenerate();
    expect(request.path).toContain('/models/gemini-3.8-flash:');
    expect(request.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  it('returns function calls with their ids and keeps thought signatures in place', async () => {
    h.fake.enqueue(toolResponse([{ name: 'record_decision', args: { summary: 'Use Vite' }, id: 'abc' }], { text: 'Noted.', signature: 'SIG-1' }));
    const result = await h.companion.gemini.generate({ systemInstruction: 's', contents: hello, tools: COORDINATOR_TOOLS });
    expect(result.functionCalls).toEqual([{ id: 'abc', name: 'record_decision', args: { summary: 'Use Vite' } }]);
    expect(result.text).toBe('Noted.');
    expect(result.parts).toEqual([
      { text: 'Noted.' },
      { functionCall: { id: 'abc', name: 'record_decision', args: { summary: 'Use Vite' } }, thoughtSignature: 'SIG-1' },
    ]);
  });

  it('retries rate limits and server errors with back-off, then succeeds', async () => {
    h.fake.enqueue(
      { kind: 'error', status: 429, body: errorBody(429, 'RESOURCE_EXHAUSTED', 'Slow down.') },
      { kind: 'error', status: 503, body: errorBody(503, 'UNAVAILABLE', 'Overloaded.') },
      textResponse('Recovered.'),
    );
    const retries: number[] = [];
    const result = await h.companion.gemini.generate({ systemInstruction: 's', contents: hello, onRetry: (n) => retries.push(n.attempt) });
    expect(result.text).toBe('Recovered.');
    expect(retries).toEqual([1, 2]);
    expect(h.fake.generateRequests).toHaveLength(3);
  });

  it('gives up after the configured number of retries and reports the reason', async () => {
    for (let i = 0; i < 5; i++) h.fake.enqueue({ kind: 'error', status: 503, body: errorBody(503, 'UNAVAILABLE', 'Overloaded.') });
    const error = await failure(h.companion.gemini.generate({ systemInstruction: 's', contents: hello }));
    expect(error.kind).toBe('server');
    expect(h.fake.generateRequests).toHaveLength(3); // 1 attempt + maxRetries (2)
    expect(h.companion.gemini.status().state).toBe('error');
  });

  it('does not retry requests the API rejects as invalid', async () => {
    h.fake.enqueue({ kind: 'error', status: 400, body: errorBody(400, 'INVALID_ARGUMENT', 'Bad schema.') });
    const error = await failure(h.companion.gemini.generate({ systemInstruction: 's', contents: hello }));
    expect(error.kind).toBe('bad_request');
    expect(error.info.retryable).toBe(false);
    expect(h.fake.generateRequests).toHaveLength(1);
  });

  it('retries a dropped connection and a network failure is classified as such', async () => {
    h.fake.enqueue({ kind: 'drop' }, textResponse('Back.'));
    expect((await h.companion.gemini.generate({ systemInstruction: 's', contents: hello })).text).toBe('Back.');

    await h.fake.stop();
    h.companion.settings.update({ maxRetries: 1 });
    const error = await failure(h.companion.gemini.generate({ systemInstruction: 's', contents: hello }));
    expect(error.kind).toBe('network');
    expect(h.companion.gemini.status().state).toBe('unreachable');
  });

  it('times out when the first chunk never arrives', async () => {
    h.companion.settings.update({ firstChunkTimeoutMs: 120, maxRetries: 0 });
    h.fake.enqueue({ kind: 'hang' });
    const started = Date.now();
    const error = await failure(h.companion.gemini.generate({ systemInstruction: 's', contents: hello }));
    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/did not start responding/);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('times out when the stream stalls, and never restarts a reply that already produced output', async () => {
    h.companion.settings.update({ idleTimeoutMs: 120, maxRetries: 3 });
    const stalled = textResponse('Partial answer that stops', { pieces: 2 });
    if (stalled.kind === 'stream') stalled.hangAfterChunks = 1;
    h.fake.enqueue(stalled, textResponse('must not be used'));
    const deltas: string[] = [];
    const error = await failure(h.companion.gemini.generate({ systemInstruction: 's', contents: hello, onDelta: (t) => deltas.push(t) }));
    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/stopped sending data/);
    expect(deltas).toHaveLength(1);
    expect('Partial answer that stops'.startsWith(deltas.join(''))).toBe(true);
    expect(h.fake.generateRequests).toHaveLength(1);
  });

  it('can be cancelled by the caller, which is not treated as a connection problem', async () => {
    await h.companion.gemini.testConnection();
    h.fake.enqueue(textResponse('A long answer that will be cut short by the user.', { pieces: 8, chunkDelayMs: 40 }));
    const controller = new AbortController();
    const deltas: string[] = [];
    const promise = h.companion.gemini.generate({
      systemInstruction: 's',
      contents: hello,
      signal: controller.signal,
      onDelta: (t) => {
        deltas.push(t);
        if (deltas.length === 2) controller.abort();
      },
    });
    const error = await failure(promise);
    expect(error.kind).toBe('aborted');
    expect(h.companion.gemini.status().state).toBe('connected');
    expect(h.fake.generateRequests).toHaveLength(1);
  });

  it('reports blocked prompts and empty responses', async () => {
    h.fake.enqueue({ kind: 'stream', chunks: [{ promptFeedback: { blockReason: 'SAFETY' } }] });
    expect((await failure(h.companion.gemini.generate({ systemInstruction: 's', contents: hello }))).kind).toBe('blocked');

    h.companion.settings.update({ maxRetries: 0 });
    h.fake.enqueue({ kind: 'stream', chunks: [{ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] }] });
    expect((await failure(h.companion.gemini.generate({ systemInstruction: 's', contents: hello }))).kind).toBe('malformed_response');
  });
});

describe('history preparation', () => {
  it('joins plain text fragments but never merges a part that carries a thought signature', () => {
    const parts: WirePart[] = [];
    appendStreamPart(parts, { text: 'Hel' });
    appendStreamPart(parts, { text: 'lo' });
    appendStreamPart(parts, { text: '', thoughtSignature: 'S' });
    appendStreamPart(parts, { text: ' again' });
    expect(parts).toEqual([{ text: 'Hello' }, { text: '', thoughtSignature: 'S' }, { text: ' again' }]);
  });

  it('replays thought signatures only to the model that produced them', () => {
    const history: WireContent[] = [
      { role: 'user', parts: [{ text: 'q' }], turnStart: true },
      { role: 'model', model: 'gemini-4-hydrogen', parts: [{ functionCall: { id: '1', name: 'f', args: {} }, thoughtSignature: 'SIG' }] },
      { role: 'user', parts: [{ functionResponse: { id: '1', name: 'f', response: { ok: true } } }] },
    ];
    const same = toRequestContents(history, 'gemini-4-hydrogen');
    expect(same[1]?.parts?.[0]).toEqual({ functionCall: { id: '1', name: 'f', args: {} }, thoughtSignature: 'SIG' });
    expect(same[0]).toEqual({ role: 'user', parts: [{ text: 'q' }] });

    const other = toRequestContents(history, 'gemini-3.8-flash');
    expect(other[1]?.parts?.[0]).toEqual({ functionCall: { id: '1', name: 'f', args: {} } });
    expect(other[2]?.parts?.[0]).toEqual({ functionResponse: { id: '1', name: 'f', response: { ok: true } } });
  });
});
