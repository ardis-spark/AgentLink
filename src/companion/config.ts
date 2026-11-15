import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { COMPANION_DEFAULT_PORT } from '../shared/api.js';

export interface CompanionConfig {
  host: string;
  port: number;
  /** Directory holding credentials, settings and project memory. */
  dataDir: string;
  /** Gemini API key supplied through the environment (development fallback). */
  envApiKey: string | null;
  /** Model requested through the environment; saved settings take precedence once the user picks one. */
  envModel: string | null;
  /** Override of the Gemini endpoint (proxies, tests). `null` uses Google's public endpoint. */
  geminiBaseUrl: string | null;
  /** Extra web origins allowed to call the API, besides browser-extension origins. */
  extraAllowedOrigins: string[];
}

/**
 * Minimal `.env` reader. Values already present in the real environment win,
 * so a shell export always overrides the file.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] ?? '').trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? '';
    else value = value.replace(/\s+#.*$/, '');
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

function parsePort(value: string | undefined): number {
  if (!value) return COMPANION_DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`AGENTLINK_PORT must be a port number, got "${value}".`);
  }
  return port;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompanionConfig {
  const dataDir = nonEmpty(env.AGENTLINK_HOME) ?? join(homedir(), '.agentlink');
  return {
    // The companion holds an API key, so it only ever listens on loopback.
    host: '127.0.0.1',
    port: parsePort(env.AGENTLINK_PORT),
    dataDir: resolve(dataDir),
    envApiKey: nonEmpty(env.GEMINI_API_KEY),
    envModel: nonEmpty(env.GEMINI_MODEL),
    geminiBaseUrl: nonEmpty(env.GOOGLE_GEMINI_BASE_URL),
    extraAllowedOrigins: (env.AGENTLINK_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
