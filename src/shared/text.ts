/** Small, dependency-free text helpers usable in Node and in the browser. */

/** Lower-cases and collapses all whitespace so comparisons ignore formatting. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Stable 64-bit FNV-1a style fingerprint (as hex) of normalised text. Not cryptographic. */
export function fingerprint(value: string): string {
  const text = normalizeText(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 5) | (c >>> 3)), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Keeps the head and the tail of a long text and states how much was removed. */
export function truncateMiddle(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  const head = Math.ceil(maxChars * 0.6);
  const tail = Math.max(0, maxChars - head);
  const omitted = value.length - head - tail;
  const text =
    value.slice(0, head) +
    `\n\n[… ${omitted.toLocaleString('en-US')} characters omitted by AgentLink …]\n\n` +
    (tail > 0 ? value.slice(value.length - tail) : '');
  return { text, truncated: true };
}

export function excerpt(value: string, maxChars: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length <= maxChars ? single : single.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

/** True when `quote` literally occurs in `source`, ignoring case and whitespace differences. */
export function containsQuote(source: string, quote: string): boolean {
  const q = normalizeText(quote);
  if (!q) return false;
  return normalizeText(source).includes(q);
}

export function cleanList(values: unknown, maxItems = 50, maxChars = 2000): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out.push(t.slice(0, maxChars));
    if (out.length >= maxItems) break;
  }
  return out;
}

/** A short fingerprint of a text; it changes whenever the text does. Used to tell whether a reply is still moving. */
export function digestOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}
