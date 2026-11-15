import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonFile, removeFile, writeJsonFile } from '../jsonFile.js';
import type { SecretRedactor } from '../logger.js';

export type KeySource = 'saved' | 'environment';

export interface ResolvedKey {
  apiKey: string;
  source: KeySource;
  fingerprint: string;
}

interface CredentialFile {
  version: 1;
  geminiApiKey: string;
  savedAt: string;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/** Non-reversible label for a key: lets the UI tell two keys apart without revealing either. */
export function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
}

export function validateKeyShape(input: unknown): string {
  if (typeof input !== 'string') throw new CredentialError('The API key must be a string.');
  const key = input.trim();
  if (!key) throw new CredentialError('The API key is empty.');
  if (/\s/.test(key)) throw new CredentialError('The API key must not contain spaces or line breaks.');
  if (key.length < 20 || key.length > 512) {
    throw new CredentialError('That does not look like a Gemini API key (unexpected length).');
  }
  return key;
}

/**
 * Holds the Gemini API key on the local machine.
 *
 * A key saved through the settings page is stored in `credentials.json` inside
 * the private data directory (directory 0700, file 0600 — the same protection
 * model as `~/.aws/credentials` or the GitHub CLI). `GEMINI_API_KEY` from the
 * environment is used when no key has been saved.
 *
 * The key is only ever handed to the Gemini client. No method here returns it
 * to an HTTP caller, and it is registered with the log redactor on load.
 */
export class CredentialStore {
  private readonly path: string;
  private cached: CredentialFile | null | undefined;

  constructor(
    dataDir: string,
    private readonly envApiKey: string | null,
    private readonly redactor: SecretRedactor,
  ) {
    this.path = join(dataDir, 'credentials.json');
    this.redactor.register(envApiKey);
  }

  private read(): CredentialFile | null {
    if (this.cached !== undefined) return this.cached;
    let file: CredentialFile | null = null;
    try {
      const parsed = readJsonFile<CredentialFile>(this.path);
      if (parsed && typeof parsed.geminiApiKey === 'string' && parsed.geminiApiKey) file = parsed;
    } catch {
      file = null;
    }
    this.cached = file;
    this.redactor.register(file?.geminiApiKey);
    return file;
  }

  /** The key to use right now: a saved key wins, the environment is the fallback. */
  resolve(): ResolvedKey | null {
    const saved = this.read();
    if (saved) return { apiKey: saved.geminiApiKey, source: 'saved', fingerprint: keyFingerprint(saved.geminiApiKey) };
    if (this.envApiKey) {
      return { apiKey: this.envApiKey, source: 'environment', fingerprint: keyFingerprint(this.envApiKey) };
    }
    return null;
  }

  save(input: unknown): ResolvedKey {
    const apiKey = validateKeyShape(input);
    this.redactor.register(apiKey);
    const file: CredentialFile = { version: 1, geminiApiKey: apiKey, savedAt: new Date().toISOString() };
    writeJsonFile(this.path, file);
    this.cached = file;
    return { apiKey, source: 'saved', fingerprint: keyFingerprint(apiKey) };
  }

  /** Removes the saved key. Returns whatever key is still in effect (the environment one, if any). */
  clear(): ResolvedKey | null {
    removeFile(this.path);
    this.cached = null;
    return this.resolve();
  }

  /** Scrubs the active key out of arbitrary text (used before anything is stored or sent to Arena). */
  scrub(text: string): string {
    return this.redactor.redact(text);
  }
}
