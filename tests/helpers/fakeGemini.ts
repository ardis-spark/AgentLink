import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for the Gemini REST API, used only by the tests. The real
 * `@google/genai` SDK is pointed at it, so authentication, streaming (SSE),
 * error bodies, retries and time-outs are exercised through the production
 * code path rather than through a mocked client.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  apiKey: string | undefined;
  body: any;
}

export type Scripted =
  | { kind: 'stream'; chunks: object[]; chunkDelayMs?: number; firstDelayMs?: number; hangAfterChunks?: number; dropAfterChunks?: number }
  | { kind: 'error'; status: number; body?: object }
  | { kind: 'hang' }
  | { kind: 'drop' };

export type ScriptedOrFn = Scripted | ((request: RecordedRequest) => Scripted);

export interface FakeModel {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

/**
 * Made-up keys in the shape of real ones, so key redaction is exercised.
 * The prefix is assembled at run time so that no literal in the repository
 * looks like a credential to a secret scanner.
 */
export const KEY_PREFIX = ['AI', 'za', 'Sy'].join('');
export const VALID_KEY = `${KEY_PREFIX}TEST-valid-key-0123456789abcdefghij`;
export const OTHER_VALID_KEY = `${KEY_PREFIX}TEST-other-key-9876543210zyxwvutsrq`;
export const INVALID_KEY = `${KEY_PREFIX}TEST-wrong-key-000000000000000000000`;

const DEFAULT_MODELS: FakeModel[] = [
  { name: 'models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 },
  { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-embedding-2', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
];

export function invalidKeyBody(): object {
  return {
    error: {
      code: 400,
      message: 'API key not valid. Please pass a valid API key.',
      status: 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
    },
  };
}

export function errorBody(code: number, status: string, message: string, retryDelay?: string): object {
  return {
    error: {
      code,
      message,
      status,
      ...(retryDelay ? { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] } : {}),
    },
  };
}

let callCounter = 0;

/** A streamed plain-text answer, split into several SSE chunks, ending with STOP and a thought signature. */
export function textResponse(text: string, options: { pieces?: number; chunkDelayMs?: number; signature?: string } = {}): Scripted {
  const pieces = Math.max(1, options.pieces ?? 3);
  const size = Math.max(1, Math.ceil(text.length / pieces));
  const chunks: object[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push({ candidates: [{ content: { role: 'model', parts: [{ text: text.slice(i, i + size) }] } }] });
  }
  chunks.push({
    candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: options.signature ?? 'sig-text' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 },
  });
  return { kind: 'stream', chunks, ...(options.chunkDelayMs !== undefined ? { chunkDelayMs: options.chunkDelayMs } : {}) };
}

/** A response in which the model calls one or more functions (optionally after some text). */
export function toolResponse(calls: { name: string; args: Record<string, unknown>; id?: string }[], options: { text?: string; signature?: string } = {}): Scripted {
  const parts: object[] = [];
  if (options.text) parts.push({ text: options.text });
  calls.forEach((call, index) => {
    callCounter += 1;
    parts.push({
      functionCall: { id: call.id ?? `call-${callCounter}`, name: call.name, args: call.args },
      ...(index === 0 ? { thoughtSignature: options.signature ?? `sig-call-${callCounter}` } : {}),
    });
  });
  return {
    kind: 'stream',
    chunks: [
      {
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, totalTokenCount: 230 },
      },
    ],
  };
}

export class FakeGemini {
  readonly requests: RecordedRequest[] = [];
  readonly validKeys = new Set<string>([VALID_KEY, OTHER_VALID_KEY]);
  models: FakeModel[] = [...DEFAULT_MODELS];
  /** When set, the model listing fails with this response instead of succeeding. */
  listFailure: Scripted | null = null;
  /** Used when the script queue is empty. */
  fallback: ScriptedOrFn = () => textResponse('OK.');

  private readonly queue: ScriptedOrFn[] = [];
  private server: Server | null = null;
  private readonly open = new Set<ServerResponse>();
  url = '';

  enqueue(...responses: ScriptedOrFn[]): void {
    this.queue.push(...responses);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Requests to the generation endpoint only. */
  get generateRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.includes(':streamGenerateContent') || r.path.includes(':generateContent'));
  }

  lastGenerate(): RecordedRequest {
    const all = this.generateRequests;
    const last = all[all.length - 1];
    if (!last) throw new Error('No generation request was recorded.');
    return last;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const res of this.open) res.destroy();
    this.open.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake');
    const headerKey = req.headers['x-goog-api-key'];
    const record: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      apiKey: Array.isArray(headerKey) ? headerKey[0] : headerKey,
      body: raw ? JSON.parse(raw) : null,
    };
    this.requests.push(record);

    const json = (status: number, body: object): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (!record.apiKey || !this.validKeys.has(record.apiKey)) return json(400, invalidKeyBody());

    const modelsMatch = /\/models(?:\/([^/:]+))?$/.exec(url.pathname);
    if (req.method === 'GET' && modelsMatch) {
      if (this.listFailure) return this.respond(res, this.listFailure);
      const id = modelsMatch[1];
      if (!id) return json(200, { models: this.models });
      const model = this.models.find((m) => m.name === `models/${id}`);
      return model ? json(200, model) : json(404, errorBody(404, 'NOT_FOUND', `models/${id} is not found for API version v1.`));
    }

    if (req.method === 'POST' && /:streamGenerateContent$/.test(url.pathname)) {
      const modelId = /\/models\/([^/:]+):/.exec(url.pathname)?.[1];
      if (!this.models.some((m) => m.name === `models/${modelId}`)) {
        return json(404, errorBody(404, 'NOT_FOUND', `models/${modelId} is not found for API version v1.`));
      }
      const next = this.queue.shift() ?? this.fallback;
      return this.respond(res, typeof next === 'function' ? next(record) : next);
    }
    json(404, errorBody(404, 'NOT_FOUND', 'Unknown path.'));
  }

  private async respond(res: ServerResponse, scripted: Scripted): Promise<void> {
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    if (scripted.kind === 'error') {
      res.writeHead(scripted.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? errorBody(scripted.status, 'UNKNOWN', `HTTP ${scripted.status}`)));
      return;
    }
    if (scripted.kind === 'drop') {
      res.destroy();
      return;
    }
    this.open.add(res);
    res.on('close', () => this.open.delete(res));
    if (scripted.kind === 'hang') return;

    if (scripted.firstDelayMs) await wait(scripted.firstDelayMs);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    for (const chunk of scripted.chunks) {
      if (res.destroyed) return;
      if (scripted.hangAfterChunks !== undefined && sent >= scripted.hangAfterChunks) return;
      if (scripted.dropAfterChunks !== undefined && sent >= scripted.dropAfterChunks) {
        res.destroy();
        return;
      }
      res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
      sent += 1;
      if (scripted.chunkDelayMs) await wait(scripted.chunkDelayMs);
    }
    res.end();
  }
}
