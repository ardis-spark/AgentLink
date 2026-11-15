import type { CompanionConfig } from './config.js';
import { Coordinator } from './coordinator/coordinator.js';
import { CredentialStore } from './credentials/credentialStore.js';
import { GeminiService, type GeminiServiceOptions } from './gemini/geminiService.js';
import { ensurePrivateDir } from './jsonFile.js';
import { Logger, SecretRedactor, type LogLevel, type LogSink } from './logger.js';
import { ProjectStore } from './memory/projectStore.js';
import { EventBus } from './orchestration/eventBus.js';
import { Orchestrator } from './orchestration/orchestrator.js';
import { CompanionServer } from './server/httpServer.js';
import { loadOrCreatePairingToken } from './server/security.js';
import { SettingsStore } from './settingsStore.js';

export interface CompanionOptions {
  version: string;
  webDir: string;
  logLevel?: LogLevel;
  logSink?: LogSink;
  gemini?: Pick<GeminiServiceOptions, 'retryBaseDelayMs' | 'retryMaxDelayMs' | 'modelCacheMs'>;
  /** Timing of the autonomous loop; shortened in tests. */
  orchestrator?: { retryDelaysMs?: readonly number[]; relayOfflineMs?: number };
}

export interface Companion {
  config: CompanionConfig;
  token: string;
  logger: Logger;
  redactor: SecretRedactor;
  credentials: CredentialStore;
  settings: SettingsStore;
  gemini: GeminiService;
  store: ProjectStore;
  bus: EventBus;
  orchestrator: Orchestrator;
  server: CompanionServer;
}

/** Wires the companion's services together. Used by the entry point and by the tests. */
export function createCompanion(config: CompanionConfig, options: CompanionOptions): Companion {
  ensurePrivateDir(config.dataDir);
  const redactor = new SecretRedactor();
  const logger = new Logger(redactor, options.logLevel ?? 'info', options.logSink);
  const credentials = new CredentialStore(config.dataDir, config.envApiKey, redactor);
  const settings = new SettingsStore(config.dataDir, config.envModel);
  const token = loadOrCreatePairingToken(config.dataDir);
  redactor.register(token);

  const gemini = new GeminiService({
    credentials,
    getSettings: () => settings.get(),
    logger,
    baseUrl: config.geminiBaseUrl,
    ...options.gemini,
  });
  const store = new ProjectStore(config.dataDir, logger);
  const bus = new EventBus();
  gemini.onStatusChange((status) => bus.emit({ type: 'gemini', status }));

  const scrub = (text: string): string => credentials.scrub(text);
  const coordinator = new Coordinator(gemini, () => settings.get(), scrub, logger);
  const orchestrator = new Orchestrator({ store, gemini, coordinator, getSettings: () => settings.get(), scrub, bus, logger, ...options.orchestrator });
  // Sessions that were running when the companion stopped carry on by themselves.
  orchestrator.recoverAfterRestart();

  const server = new CompanionServer({
    config,
    version: options.version,
    token,
    credentials,
    settings,
    gemini,
    orchestrator,
    bus,
    logger,
    webDir: options.webDir,
  });
  return { config, token, logger, redactor, credentials, settings, gemini, store, bus, orchestrator, server };
}
