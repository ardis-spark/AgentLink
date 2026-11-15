import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanion, type Companion } from '../../src/companion/app.js';
import type { CompanionConfig } from '../../src/companion/config.js';
import type { LogLevel } from '../../src/companion/logger.js';
import type { CompanionSettings } from '../../src/shared/types.js';
import { FakeGemini, VALID_KEY } from './fakeGemini.js';

export interface Harness {
  fake: FakeGemini;
  companion: Companion;
  dataDir: string;
  logs: string[];
  /** Ends the running companion as a killed process would, and builds a new one on the same data directory. */
  restart: () => Companion;
  cleanup: () => Promise<void>;
}

export interface HarnessOptions {
  envApiKey?: string | null;
  saveKey?: string | null;
  settings?: Partial<CompanionSettings>;
  envModel?: string | null;
  /** Waits before a failed coordinator turn is repeated. */
  retryDelaysMs?: readonly number[];
  relayOfflineMs?: number;
}

const FAST: Partial<CompanionSettings> = {
  maxRetries: 2,
  firstChunkTimeoutMs: 2_000,
  idleTimeoutMs: 2_000,
  totalTimeoutMs: 10_000,
};

export function tempDir(prefix = 'agentlink-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const fake = new FakeGemini();
  await fake.start();
  const dataDir = tempDir();
  const logs: string[] = [];
  const config: CompanionConfig = {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    envApiKey: options.envApiKey === undefined ? null : options.envApiKey,
    envModel: options.envModel ?? null,
    geminiBaseUrl: fake.url,
    extraAllowedOrigins: [],
  };
  const build = (): Companion => {
    const companion = createCompanion(config, {
      version: 'test',
      webDir: join(dataDir, 'web'),
      logLevel: 'debug' as LogLevel,
      logSink: (_level, line) => logs.push(line),
      gemini: { retryBaseDelayMs: 5, retryMaxDelayMs: 20, modelCacheMs: 60_000 },
      orchestrator: { retryDelaysMs: options.retryDelaysMs ?? [5, 5], relayOfflineMs: options.relayOfflineMs ?? 45_000 },
    });
    companion.settings.update({ ...FAST, ...options.settings });
    return companion;
  };
  const companion = build();
  const saveKey = options.saveKey === undefined ? VALID_KEY : options.saveKey;
  if (saveKey) companion.credentials.save(saveKey);

  const created: Companion[] = [companion];
  return {
    fake,
    companion,
    dataDir,
    logs,
    restart: () => {
      // The previous process is gone: it must not go on working or writing next to the new one.
      for (const c of created) c.orchestrator.dispose();
      const next = build();
      created.push(next);
      return next;
    },
    cleanup: async () => {
      for (const c of created) {
        c.orchestrator.dispose();
        await c.server.close().catch(() => undefined);
      }
      await fake.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Polls until the predicate holds; fails the test with a clear message otherwise. */
export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
