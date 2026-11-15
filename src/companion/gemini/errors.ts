import { ApiError } from '@google/genai';
import type { GeminiErrorInfo, GeminiErrorKind } from '../../shared/types.js';

export class GeminiError extends Error {
  readonly info: GeminiErrorInfo;
  /** Delay suggested by the server (RetryInfo), when it sent one. */
  readonly retryAfterMs: number | null;

  constructor(kind: GeminiErrorKind, message: string, options: { status?: number | null; retryable?: boolean; retryAfterMs?: number | null; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GeminiError';
    this.info = { kind, message, status: options.status ?? null, retryable: options.retryable ?? false };
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  get kind(): GeminiErrorKind {
    return this.info.kind;
  }
}

export interface AbortContext {
  /** Which of our own timers fired, if any. */
  timedOut: 'first_chunk' | 'idle' | 'total' | null;
  /** True when the caller (pause/stop/cancel) aborted the request. */
  callerAborted: boolean;
}

interface ParsedApiBody {
  message: string;
  status: string;
  reasons: string[];
  retryAfterMs: number | null;
}

function parseApiBody(raw: string): ParsedApiBody {
  const out: ParsedApiBody = { message: raw, status: '', reasons: [], retryAfterMs: null };
  try {
    // Mid-stream errors arrive as "got status: X. {json}", so parse from the first brace.
    const start = raw.indexOf('{');
    const parsed = JSON.parse(start > 0 ? raw.slice(start) : raw) as unknown;
    const err = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: Record<string, unknown> } | undefined;
    const body = err?.error;
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string') out.message = body.message;
      if (typeof body.status === 'string') out.status = body.status;
      const details = Array.isArray(body.details) ? (body.details as Record<string, unknown>[]) : [];
      for (const d of details) {
        if (typeof d?.reason === 'string') out.reasons.push(d.reason);
        if (typeof d?.retryDelay === 'string') {
          const seconds = Number.parseFloat(d.retryDelay);
          if (Number.isFinite(seconds) && seconds >= 0) out.retryAfterMs = Math.round(seconds * 1000);
        }
      }
    }
  } catch {
    // Not JSON: keep the raw text as the message.
  }
  return out;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

function causeCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Turns anything thrown while talking to Gemini into a typed, user-presentable error. */
export function classifyGeminiError(error: unknown, ctx: AbortContext = { timedOut: null, callerAborted: false }): GeminiError {
  if (error instanceof GeminiError) return error;

  if (ctx.callerAborted) {
    return new GeminiError('aborted', 'The request was cancelled.', { cause: error });
  }
  if (ctx.timedOut) {
    const what =
      ctx.timedOut === 'first_chunk'
        ? 'Gemini did not start responding in time.'
        : ctx.timedOut === 'idle'
          ? 'Gemini stopped sending data mid-response.'
          : 'The Gemini request exceeded its total time limit.';
    return new GeminiError('timeout', what, { retryable: true, cause: error });
  }

  if (error instanceof ApiError) {
    const status = error.status;
    const body = parseApiBody(error.message);
    const text = `${body.message} ${body.reasons.join(' ')}`;
    if (status === 401 || (status === 400 && /API_KEY_INVALID|api key not valid|api key expired|invalid api key/i.test(text))) {
      return new GeminiError('invalid_key', 'Gemini rejected the API key. Check that the key is correct and still active.', { status, cause: error });
    }
    if (status === 403) {
      return new GeminiError('permission_denied', `Gemini denied access for this API key: ${body.message}`, { status, cause: error });
    }
    if (status === 404) {
      return new GeminiError('model_not_found', `Gemini does not offer the requested model to this API key: ${body.message}`, { status, cause: error });
    }
    if (status === 429) {
      return new GeminiError('rate_limited', `Gemini rate limit or quota reached: ${body.message}`, {
        status,
        retryable: true,
        retryAfterMs: body.retryAfterMs,
        cause: error,
      });
    }
    if (status === 408 || status >= 500) {
      return new GeminiError('server', `Gemini is temporarily unavailable (HTTP ${status}): ${body.message}`, {
        status,
        retryable: true,
        retryAfterMs: body.retryAfterMs,
        cause: error,
      });
    }
    return new GeminiError('bad_request', `Gemini rejected the request (HTTP ${status}): ${body.message}`, { status, cause: error });
  }

  if (isAbortError(error)) {
    // An abort that neither our timers nor the caller triggered: the SDK's own attempt timeout.
    return new GeminiError('timeout', 'The Gemini request timed out.', { retryable: true, cause: error });
  }

  const code = causeCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if ((code && NETWORK_CODES.has(code)) || /fetch failed|network|socket|terminated/i.test(message)) {
    return new GeminiError('network', `Could not reach the Gemini API${code ? ` (${code})` : ''}. Check the network connection.`, {
      retryable: true,
      cause: error,
    });
  }
  if (/Incomplete JSON segment|parsing stream chunk|Response body is empty/i.test(message)) {
    return new GeminiError('malformed_response', 'Gemini returned an incomplete response.', { retryable: true, cause: error });
  }
  return new GeminiError('unknown', `Unexpected error while calling Gemini: ${message}`, { cause: error });
}
