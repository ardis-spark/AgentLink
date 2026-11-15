import { existsSync, readFileSync, statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadEnvFile } from '../../src/companion/config.js';
import { CredentialError, CredentialStore, keyFingerprint } from '../../src/companion/credentials/credentialStore.js';
import { Logger, SecretRedactor } from '../../src/companion/logger.js';
import { writeFileSync } from 'node:fs';
import { tempDir } from '../helpers/harness.js';
import { KEY_PREFIX, OTHER_VALID_KEY, VALID_KEY } from '../helpers/fakeGemini.js';

const dirs: string[] = [];
function dir(): string {
  const d = tempDir();
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('credential store', () => {
  it('reports no key when nothing is configured', () => {
    const store = new CredentialStore(dir(), null, new SecretRedactor());
    expect(store.resolve()).toBeNull();
  });

  it('uses GEMINI_API_KEY from the environment as the development fallback', () => {
    const store = new CredentialStore(dir(), VALID_KEY, new SecretRedactor());
    expect(store.resolve()).toEqual({ apiKey: VALID_KEY, source: 'environment', fingerprint: keyFingerprint(VALID_KEY) });
  });

  it('saves a key to an owner-only file and prefers it over the environment', () => {
    const d = dir();
    const store = new CredentialStore(d, OTHER_VALID_KEY, new SecretRedactor());
    store.save(`  ${VALID_KEY}\n`);
    expect(store.resolve()?.apiKey).toBe(VALID_KEY);
    expect(store.resolve()?.source).toBe('saved');

    const file = join(d, 'credentials.json');
    expect(existsSync(file)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    expect(JSON.parse(readFileSync(file, 'utf8')).geminiApiKey).toBe(VALID_KEY);
  });

  it('keeps a saved key across restarts and can update it', () => {
    const d = dir();
    new CredentialStore(d, null, new SecretRedactor()).save(VALID_KEY);
    const reopened = new CredentialStore(d, null, new SecretRedactor());
    expect(reopened.resolve()?.apiKey).toBe(VALID_KEY);
    reopened.save(OTHER_VALID_KEY);
    expect(new CredentialStore(d, null, new SecretRedactor()).resolve()?.apiKey).toBe(OTHER_VALID_KEY);
  });

  it('falls back to the environment key when the saved key is removed', () => {
    const d = dir();
    const store = new CredentialStore(d, OTHER_VALID_KEY, new SecretRedactor());
    store.save(VALID_KEY);
    expect(store.clear()?.source).toBe('environment');
    expect(existsSync(join(d, 'credentials.json'))).toBe(false);
    expect(new CredentialStore(d, null, new SecretRedactor()).resolve()).toBeNull();
  });

  it('rejects values that cannot be an API key', () => {
    const store = new CredentialStore(dir(), null, new SecretRedactor());
    expect(() => store.save('')).toThrow(CredentialError);
    expect(() => store.save('short')).toThrow(CredentialError);
    expect(() => store.save('has spaces in the middle of the key value')).toThrow(CredentialError);
    expect(() => store.save(42)).toThrow(CredentialError);
    expect(store.resolve()).toBeNull();
  });

  it('exposes only a non-reversible fingerprint', () => {
    const fp = keyFingerprint(VALID_KEY);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(VALID_KEY).not.toContain(fp);
    expect(keyFingerprint(OTHER_VALID_KEY)).not.toBe(fp);
  });
});

describe('secret redaction', () => {
  it('removes a registered key from log lines wherever it appears', () => {
    const lines: string[] = [];
    const redactor = new SecretRedactor();
    const logger = new Logger(redactor, 'debug', (_l, line) => lines.push(line));
    const store = new CredentialStore(dir(), null, redactor);
    store.save(VALID_KEY);

    logger.info(`calling https://example.test/v1/models?key=${VALID_KEY}`);
    logger.error('failed', new Error(`bad key ${VALID_KEY}`), { headers: { 'x-goog-api-key': VALID_KEY } });
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain(VALID_KEY);
    expect(lines.join('\n')).toContain('[REDACTED]');
  });

  it('redacts key-shaped strings even when they were never registered', () => {
    const redactor = new SecretRedactor();
    const out = redactor.redact(`x-goog-api-key: ${KEY_PREFIX}UNREGISTERED0123456789abcdefghijkl and Bearer abcdefghijklmnop`);
    expect(out).not.toContain(`${KEY_PREFIX}UNREGISTERED`);
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('scrubs the active key out of arbitrary text', () => {
    const store = new CredentialStore(dir(), null, new SecretRedactor());
    store.save(VALID_KEY);
    expect(store.scrub(`please use ${VALID_KEY} in the config`)).toBe('please use [REDACTED] in the config');
  });
});

describe('environment configuration', () => {
  it('reads GEMINI_API_KEY, GEMINI_MODEL and the data directory from the environment', () => {
    const config = loadConfig({ GEMINI_API_KEY: ` ${VALID_KEY} `, GEMINI_MODEL: 'gemini-4-argon', AGENTLINK_HOME: '/tmp/al-home', AGENTLINK_PORT: '5001' });
    expect(config.envApiKey).toBe(VALID_KEY);
    expect(config.envModel).toBe('gemini-4-argon');
    expect(config.dataDir).toBe('/tmp/al-home');
    expect(config.port).toBe(5001);
    expect(config.host).toBe('127.0.0.1');
  });

  it('treats an empty GEMINI_API_KEY as not configured and rejects a bad port', () => {
    expect(loadConfig({ GEMINI_API_KEY: '   ' }).envApiKey).toBeNull();
    expect(() => loadConfig({ AGENTLINK_PORT: 'abc' })).toThrow(/AGENTLINK_PORT/);
  });

  it('loads a .env file without overriding variables that are already set', () => {
    const d = dir();
    const file = join(d, '.env');
    writeFileSync(file, ['# comment', `GEMINI_API_KEY="${VALID_KEY}"`, 'GEMINI_MODEL=gemini-3.8-flash # inline comment', 'export AGENTLINK_PORT=5002', 'not a pair'].join('\n'));
    const env: NodeJS.ProcessEnv = { GEMINI_MODEL: 'gemini-4-hydrogen' };
    const loaded = loadEnvFile(file, env);
    expect(loaded.sort()).toEqual(['AGENTLINK_PORT', 'GEMINI_API_KEY']);
    expect(env.GEMINI_API_KEY).toBe(VALID_KEY);
    expect(env.GEMINI_MODEL).toBe('gemini-4-hydrogen');
    expect(env.AGENTLINK_PORT).toBe('5002');
    expect(loadEnvFile(join(d, 'missing.env'), env)).toEqual([]);
  });
});
