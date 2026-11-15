import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type Part,
} from '@google/genai';
import type {
  CompanionSettings,
  GeminiConnectionState,
  GeminiErrorInfo,
  GeminiModelInfo,
  GeminiStatus,
  TokenUsage,
  WireContent,
  WirePart,
} from '../../shared/types.js';
import type { CredentialStore, ResolvedKey } from '../credentials/credentialStore.js';
import type { Logger } from '../logger.js';
import { classifyGeminiError, GeminiError, type AbortContext } from './errors.js';

export interface ToolMode {
  mode: 'AUTO' | 'ANY' | 'NONE';
  allowedFunctionNames?: string[];
}

export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: GeminiErrorInfo;
}

export interface GenerateRequest {
  systemInstruction: string;
  contents: WireContent[];
  tools?: FunctionDeclaration[];
  toolMode?: ToolMode;
  signal?: AbortSignal;
  /** Called for every streamed piece of visible text. */
  onDelta?: (text: string) => void;
  onRetry?: (notice: RetryNotice) => void;
  /** Accept a response with neither text nor function calls (valid after tool results). */
  allowEmpty?: boolean;
}

export interface FunctionCallRequest {
  id: string | undefined;
  name: string;
  args: Record<string, unknown>;
}

export interface GenerateResult {
  model: string;
  /** Model parts exactly as received, ready to be replayed as history. */
  parts: WirePart[];
  text: string;
  functionCalls: FunctionCallRequest[];
  finishReason: string | null;
  usage: TokenUsage | null;
}

export interface GeminiServiceOptions {
  credentials: CredentialStore;
  getSettings: () => CompanionSettings;
  logger: Logger;
  /** Overrides Google's endpoint (proxies, tests). */
  baseUrl?: string | null;
  /** First back-off delay; doubles on every retry. */
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** How long a model listing stays cached. */
  modelCacheMs?: number;
}

const BLOCKING_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'MODEL_ARMOR', 'LANGUAGE']);
const MALFORMED_FINISH_REASONS = new Set(['MALFORMED_FUNCTION_CALL', 'MALFORMED_RESPONSE', 'UNEXPECTED_TOOL_CALL', 'MISSING_THOUGHT_SIGNATURE']);

/** Models that answer `generateContent` but are not text/tool-calling chat models. */
const NON_COORDINATOR_MODEL = /(image|banana|tts|live|audio|embedding|transcribe|translate|omni|robotics|computer-use|veo|lyria|imagen|aqa)/i;

function toWirePart(part: Part): WirePart | null {
  const out: WirePart = {};
  if (typeof part.text === 'string') out.text = part.text;
  if (part.thought === true) out.thought = true;
  if (typeof part.thoughtSignature === 'string') out.thoughtSignature = part.thoughtSignature;
  if (part.functionCall) {
    out.functionCall = {
      ...(part.functionCall.id !== undefined ? { id: part.functionCall.id } : {}),
      ...(part.functionCall.name !== undefined ? { name: part.functionCall.name } : {}),
      args: (part.functionCall.args ?? {}) as Record<string, unknown>,
    };
  }
  return out.text !== undefined || out.functionCall || out.thoughtSignature ? out : null;
}

/**
 * Appends a streamed part to the parts collected so far. Consecutive plain
 * text fragments are joined; a part carrying a thought signature is always
 * kept as its own part, because the API requires signatures to come back in
 * exactly the part they arrived in.
 */
export function appendStreamPart(parts: WirePart[], incoming: WirePart): void {
  const last = parts[parts.length - 1];
  const plainText = (p: WirePart): boolean =>
    p.text !== undefined && !p.functionCall && !p.functionResponse && p.thoughtSignature === undefined;
  if (last && plainText(last) && plainText(incoming) && Boolean(last.thought) === Boolean(incoming.thought)) {
    last.text = (last.text ?? '') + (incoming.text ?? '');
    return;
  }
  parts.push({ ...incoming });
}

/**
 * Prepares stored history for a request: thought signatures are replayed only
 * to the model that issued them (other models cannot validate them), and
 * bookkeeping fields are dropped.
 */
export function toRequestContents(contents: WireContent[], model: string, stripAllSignatures = false): Content[] {
  return contents.map((content) => {
    const keepSignatures = !stripAllSignatures && (content.role !== 'model' || content.model === undefined || content.model === model);
    const parts: Part[] = content.parts.map((part) => {
      const out: Part = {};
      if (part.text !== undefined) out.text = part.text;
      if (part.thought) out.thought = true;
      if (part.functionCall) out.functionCall = { ...part.functionCall };
      if (part.functionResponse) out.functionResponse = { ...part.functionResponse };
      if (part.thoughtSignature !== undefined && keepSignatures) out.thoughtSignature = part.thoughtSignature;
      return out;
    });
    return { role: content.role, parts };
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GeminiError('aborted', 'The request was cancelled.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new GeminiError('aborted', 'The request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const THINKING_LEVELS = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH } as const;

interface ConnectionRecord {
  keyFingerprint: string;
  model: string;
  state: GeminiConnectionState;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  error: GeminiErrorInfo | null;
}

/**
 * The only component that talks to Google. It owns the API key in memory,
 * streams responses, applies time-outs and retries, and keeps an honest
 * connection state: "connected" is only ever reported after a real, successful
 * API call with the current key and model.
 */
export class GeminiService {
  private readonly credentials: CredentialStore;
  private readonly getSettings: () => CompanionSettings;
  private readonly logger: Logger;
  private readonly baseUrl: string | null;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly modelCacheMs: number;

  private client: { fingerprint: string; ai: GoogleGenAI } | null = null;
  private connection: ConnectionRecord | null = null;
  private modelCache: { fingerprint: string; at: number; models: GeminiModelInfo[] } | null = null;
  private readonly listeners = new Set<(status: GeminiStatus) => void>();
  private lastEmitted = '';

  constructor(options: GeminiServiceOptions) {
    this.credentials = options.credentials;
    this.getSettings = options.getSettings;
    this.logger = options.logger;
    this.baseUrl = options.baseUrl ?? null;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
    this.modelCacheMs = options.modelCacheMs ?? 10 * 60_000;
  }

  onStatusChange(listener: (status: GeminiStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Call after the key or the model changed so listeners learn about the new state. */
  refresh(): GeminiStatus {
    const status = this.status();
    this.emit(status);
    return status;
  }

  private emit(status: GeminiStatus): void {
    const serialised = JSON.stringify(status);
    if (serialised === this.lastEmitted) return;
    this.lastEmitted = serialised;
    for (const listener of this.listeners) listener(status);
  }

  status(): GeminiStatus {
    const key = this.credentials.resolve();
    const model = this.getSettings().model;
    if (!key) {
      return {
        state: 'no_key',
        model,
        keyConfigured: false,
        keySource: null,
        keyFingerprint: null,
        lastCheckedAt: null,
        lastOkAt: null,
        error: null,
      };
    }
    const record = this.connection;
    const current = record && record.keyFingerprint === key.fingerprint && record.model === model ? record : null;
    return {
      state: current?.state ?? 'unverified',
      model,
      keyConfigured: true,
      keySource: key.source,
      keyFingerprint: key.fingerprint,
      lastCheckedAt: current?.lastCheckedAt ?? null,
      lastOkAt: current?.lastOkAt ?? null,
      error: current?.error ?? null,
    };
  }

  private record(key: ResolvedKey, model: string, state: GeminiConnectionState, error: GeminiErrorInfo | null): void {
    const now = new Date().toISOString();
    const previous = this.connection && this.connection.keyFingerprint === key.fingerprint && this.connection.model === model ? this.connection : null;
    this.connection = {
      keyFingerprint: key.fingerprint,
      model,
      state,
      lastCheckedAt: state === 'checking' ? (previous?.lastCheckedAt ?? null) : now,
      lastOkAt: state === 'connected' ? now : (previous?.lastOkAt ?? null),
      error,
    };
    this.emit(this.status());
  }

  private recordFailure(key: ResolvedKey, model: string, error: GeminiError): void {
    const state = stateForError(error);
    if (state) this.record(key, model, state, error.info);
  }

  private requireKey(): ResolvedKey {
    const key = this.credentials.resolve();
    if (!key) {
      throw new GeminiError('no_key', 'No Gemini API key is configured. Add one in the AgentLink companion settings.');
    }
    return key;
  }

  private clientFor(key: ResolvedKey): GoogleGenAI {
    if (this.client && this.client.fingerprint === key.fingerprint) return this.client.ai;
    const ai = new GoogleGenAI({
      apiKey: key.apiKey,
      vertexai: false,
      ...(this.baseUrl ? { httpOptions: { baseUrl: this.baseUrl } } : {}),
    });
    this.client = { fingerprint: key.fingerprint, ai };
    return ai;
  }

  private backoffDelay(attempt: number, error: GeminiError): number {
    const exponential = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.round(exponential * (0.75 + Math.random() * 0.5));
    if (error.retryAfterMs !== null) return Math.min(Math.max(jittered, error.retryAfterMs), Math.max(this.retryMaxDelayMs, 60_000));
    return jittered;
  }

  /** Lists the chat-capable Gemini models this key can use. */
  async listModels(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<GeminiModelInfo[]> {
    const key = this.requireKey();
    const cached = this.modelCache;
    if (!options.force && cached && cached.fingerprint === key.fingerprint && Date.now() - cached.at < this.modelCacheMs) {
      return cached.models;
    }
    const settings = this.getSettings();
    const ai = this.clientFor(key);
    const models: GeminiModelInfo[] = [];
    try {
      const pager = await ai.models.list({
        config: {
          pageSize: 200,
          httpOptions: { timeout: Math.min(settings.totalTimeoutMs, 30_000) },
          ...(options.signal ? { abortSignal: options.signal } : {}),
        },
      });
      for await (const model of pager) {
        const id = (model.name ?? '').replace(/^models\//, '');
        if (!id.startsWith('gemini-')) continue;
        if (model.supportedActions && !model.supportedActions.includes('generateContent')) continue;
        if (NON_COORDINATOR_MODEL.test(id)) continue;
        models.push({
          id,
          displayName: model.displayName ?? id,
          description: model.description ?? '',
          inputTokenLimit: model.inputTokenLimit ?? null,
          outputTokenLimit: model.outputTokenLimit ?? null,
        });
      }
    } catch (error) {
      throw classifyGeminiError(error, { timedOut: null, callerAborted: Boolean(options.signal?.aborted) });
    }
    models.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
    this.modelCache = { fingerprint: key.fingerprint, at: Date.now(), models };
    return models;
  }

  /**
   * Verifies the key and the configured model with real API calls: the model
   * listing proves the key is accepted, then the configured model is looked up.
   */
  async testConnection(): Promise<GeminiStatus> {
    const key = this.credentials.resolve();
    const model = this.getSettings().model;
    if (!key) return this.refresh();
    this.record(key, model, 'checking', null);
    try {
      const models = await this.listModels({ force: true });
      let available = models.some((m) => m.id === model);
      if (!available) {
        // The listing is filtered to chat models; ask for the model directly before giving up on it.
        try {
          const info = await this.clientFor(key).models.get({ model, config: { httpOptions: { timeout: 30_000 } } });
          available = !info.supportedActions || info.supportedActions.includes('generateContent');
        } catch (error) {
          const classified = classifyGeminiError(error);
          if (classified.kind !== 'model_not_found' && classified.kind !== 'bad_request') throw classified;
        }
      }
      if (available) {
        this.record(key, model, 'connected', null);
      } else {
        this.record(key, model, 'model_unavailable', {
          kind: 'model_not_found',
          message: `The API key works, but the model "${model}" is not available to it. Choose another model.`,
          status: 404,
          retryable: false,
        });
      }
    } catch (error) {
      const classified = classifyGeminiError(error);
      this.logger.warn('Gemini connection test failed:', classified.info.kind, classified.message);
      const state = stateForError(classified) ?? 'error';
      this.record(key, model, state, classified.info);
    }
    return this.status();
  }

  /**
   * Runs one streamed model call. Retryable failures (rate limits, 5xx,
   * network errors, time-outs) are retried with exponential back-off, but only
   * while nothing has been streamed to the caller yet — a response is never
   * silently restarted half-way through.
   */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const key = this.requireKey();
    const settings = this.getSettings();
    const model = settings.model;
    const maxAttempts = settings.maxRetries + 1;
    let stripSignatures = false;

    for (let attempt = 1; ; attempt++) {
      let emitted = false;
      try {
        const result = await this.streamOnce(key, model, settings, request, stripSignatures, () => {
          emitted = true;
        });
        this.record(key, model, 'connected', null);
        return result;
      } catch (raw) {
        const error = raw instanceof GeminiError ? raw : classifyGeminiError(raw);
        if (error.kind === 'aborted') throw error;

        // History recorded with another model may carry signatures this model rejects: retry once without them.
        if (!emitted && !stripSignatures && error.kind === 'bad_request' && /thought[_ ]?signature/i.test(error.message)) {
          this.logger.warn('Gemini rejected replayed thought signatures; retrying with signatures from earlier turns removed.');
          stripSignatures = true;
          attempt -= 1;
          continue;
        }

        const canRetry = error.info.retryable && !emitted && attempt < maxAttempts;
        if (!canRetry) {
          this.recordFailure(key, model, error);
          this.logger.warn(`Gemini request failed (${error.kind}, attempt ${attempt}/${maxAttempts}):`, error.message);
          throw error;
        }
        const delayMs = this.backoffDelay(attempt, error);
        this.logger.info(`Gemini request failed (${error.kind}); retry ${attempt}/${maxAttempts - 1} in ${delayMs} ms.`);
        request.onRetry?.({ attempt, maxAttempts, delayMs, error: error.info });
        await sleep(delayMs, request.signal);
      }
    }
  }

  private async streamOnce(
    key: ResolvedKey,
    model: string,
    settings: CompanionSettings,
    request: GenerateRequest,
    stripSignatures: boolean,
    onFirstOutput: () => void,
  ): Promise<GenerateResult> {
    const controller = new AbortController();
    const ctx: AbortContext = { timedOut: null, callerAborted: false };
    const onCallerAbort = (): void => {
      ctx.callerAborted = true;
      controller.abort();
    };
    if (request.signal?.aborted) throw new GeminiError('aborted', 'The request was cancelled.');
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const fire = (kind: NonNullable<AbortContext['timedOut']>) => (): void => {
      if (!ctx.timedOut && !ctx.callerAborted) ctx.timedOut = kind;
      controller.abort();
    };
    const totalTimer = setTimeout(fire('total'), settings.totalTimeoutMs);
    let chunkTimer: ReturnType<typeof setTimeout> = setTimeout(fire('first_chunk'), settings.firstChunkTimeoutMs);

    const config: GenerateContentConfig = {
      systemInstruction: request.systemInstruction,
      abortSignal: controller.signal,
      // Our own timers govern the request; this only stops the SDK from holding a socket forever.
      httpOptions: { timeout: settings.totalTimeoutMs + 5_000 },
    };
    if (request.tools && request.tools.length > 0) {
      config.tools = [{ functionDeclarations: request.tools }];
      const mode = request.toolMode ?? { mode: 'AUTO' };
      config.toolConfig = {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode[mode.mode],
          ...(mode.allowedFunctionNames && mode.mode === 'ANY' ? { allowedFunctionNames: mode.allowedFunctionNames } : {}),
        },
      };
    }
    if (settings.thinkingLevel !== 'default') {
      config.thinkingConfig = { thinkingLevel: THINKING_LEVELS[settings.thinkingLevel] };
    }

    const parts: WirePart[] = [];
    const functionCalls: FunctionCallRequest[] = [];
    let text = '';
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    let blockReason: string | null = null;
    let outputStarted = false;

    try {
      const stream = await this.clientFor(key).models.generateContentStream({
        model,
        contents: toRequestContents(request.contents, model, stripSignatures),
        config,
      });
      for await (const chunk of stream) {
        clearTimeout(chunkTimer);
        chunkTimer = setTimeout(fire('idle'), settings.idleTimeoutMs);

        if (chunk.promptFeedback?.blockReason) blockReason = String(chunk.promptFeedback.blockReason);
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finishReason = String(candidate.finishReason);
        if (chunk.usageMetadata) {
          usage = {
            promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
            totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
          };
        }
        for (const rawPart of candidate?.content?.parts ?? []) {
          const part = toWirePart(rawPart);
          if (!part) continue;
          appendStreamPart(parts, part);
          if (part.functionCall?.name) {
            functionCalls.push({ id: part.functionCall.id, name: part.functionCall.name, args: part.functionCall.args ?? {} });
          }
          if (part.text && !part.thought) {
            if (!outputStarted) {
              outputStarted = true;
              onFirstOutput();
            }
            text += part.text;
            request.onDelta?.(part.text);
          }
        }
      }
    } catch (error) {
      throw classifyGeminiError(error, ctx);
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(chunkTimer);
      request.signal?.removeEventListener('abort', onCallerAbort);
    }

    if (blockReason) {
      throw new GeminiError('blocked', `Gemini blocked the request (${blockReason}).`);
    }
    if (finishReason && BLOCKING_FINISH_REASONS.has(finishReason) && !text && functionCalls.length === 0) {
      throw new GeminiError('blocked', `Gemini withheld the response (${finishReason}).`);
    }
    if (finishReason && MALFORMED_FINISH_REASONS.has(finishReason) && functionCalls.length === 0) {
      throw new GeminiError('malformed_response', `Gemini produced an unusable response (${finishReason}).`, { retryable: !outputStarted });
    }
    if (!text && functionCalls.length === 0 && !request.allowEmpty) {
      throw new GeminiError('malformed_response', 'Gemini returned an empty response.', { retryable: true });
    }
    return { model, parts, text, functionCalls, finishReason, usage };
  }
}

function stateForError(error: GeminiError): GeminiConnectionState | null {
  switch (error.kind) {
    case 'no_key':
      return 'no_key';
    case 'invalid_key':
      return 'invalid_key';
    case 'permission_denied':
      return 'permission_denied';
    case 'model_not_found':
      return 'model_unavailable';
    case 'rate_limited':
      return 'rate_limited';
    case 'network':
    case 'timeout':
      return 'unreachable';
    case 'server':
    case 'unknown':
      return 'error';
    // A cancelled, blocked or malformed exchange says nothing about connectivity.
    case 'aborted':
    case 'blocked':
    case 'bad_request':
    case 'malformed_response':
      return null;
  }
}
