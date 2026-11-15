import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../jsonFile.js';

interface TokenFile {
  version: 1;
  token: string;
  createdAt: string;
}

/**
 * The pairing token authorises a client (the extension, or the companion's own
 * settings page) to use the local API. It is created on first start and kept,
 * so the extension stays paired across restarts. It grants access to this
 * local service only — it is not the Gemini key and cannot be used to read it.
 */
export function loadOrCreatePairingToken(dataDir: string): string {
  const path = join(dataDir, 'pairing-token.json');
  try {
    const existing = readJsonFile<TokenFile>(path);
    if (existing && typeof existing.token === 'string' && existing.token.length >= 32) return existing.token;
  } catch {
    // Fall through and mint a new token.
  }
  const token = randomBytes(32).toString('base64url');
  const file: TokenFile = { version: 1, token, createdAt: new Date().toISOString() };
  writeJsonFile(path, file);
  return token;
}

export function tokensMatch(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

/** Only requests addressed to the loopback name are served, which defeats DNS-rebinding attacks. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export type OriginKind = 'none' | 'self' | 'extension' | 'extra' | 'foreign';

/** Classifies the caller: no Origin (CLI tools), the companion's own page, a browser extension, or a website. */
export function classifyOrigin(origin: string | undefined, port: number, extraAllowed: string[]): OriginKind {
  if (!origin || origin === 'null') return origin === 'null' ? 'foreign' : 'none';
  const value = origin.trim().toLowerCase();
  if (value === `http://127.0.0.1:${port}` || value === `http://localhost:${port}`) return 'self';
  if (value.startsWith('moz-extension://') || value.startsWith('chrome-extension://')) return 'extension';
  if (extraAllowed.some((o) => o.toLowerCase() === value)) return 'extra';
  return 'foreign';
}
