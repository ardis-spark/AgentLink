import type { GeminiStatus } from './types.js';

export type Tone = 'ok' | 'warn' | 'bad' | 'busy' | 'off';

export interface StatusText {
  tone: Tone;
  /** One or two words for an indicator. */
  label: string;
  /** A full sentence saying what is wrong and what to do about it. */
  detail: string;
}

/** Turns the companion's Gemini status into wording for the UI. It reports only what was actually observed. */
export function describeGemini(status: GeminiStatus): StatusText {
  const reason = status.error?.message ?? '';
  switch (status.state) {
    case 'connected':
      return { tone: 'ok', label: 'Connected', detail: `Gemini answered with ${status.model}.` };
    case 'checking':
      return { tone: 'busy', label: 'Checking', detail: 'Testing the connection to Gemini…' };
    case 'unverified':
      return { tone: 'warn', label: 'Not tested', detail: 'A key is configured but has not been tested yet. Run a connection test.' };
    case 'no_key':
      return { tone: 'off', label: 'No API key', detail: 'No Gemini API key is configured. Add one in the companion settings.' };
    case 'invalid_key':
      return { tone: 'bad', label: 'Invalid key', detail: reason || 'Gemini rejected the API key. Check it and save it again.' };
    case 'permission_denied':
      return { tone: 'bad', label: 'Access denied', detail: reason || 'This key is not allowed to use the Gemini API or this model.' };
    case 'model_unavailable':
      return { tone: 'bad', label: 'Model unavailable', detail: reason || `The model ${status.model} is not available to this key. Choose another model.` };
    case 'rate_limited':
      return { tone: 'warn', label: 'Rate limited', detail: reason || 'Gemini is rate limiting this key. Wait a moment and try again.' };
    case 'unreachable':
      return { tone: 'bad', label: 'Unreachable', detail: reason || 'The Gemini API could not be reached. Check the network connection.' };
    case 'error':
    default:
      return { tone: 'bad', label: 'Error', detail: reason || 'The last Gemini request failed.' };
  }
}

export function formatTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'unknown';
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const date = new Date(at);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
