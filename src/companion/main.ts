import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';
import type { LogLevel } from './logger.js';

declare const __AGENTLINK_VERSION__: string;

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // `.env` in the working directory is a development convenience; real environment variables win.
  loadEnvFile(resolve(process.cwd(), '.env'));
  const config = loadConfig();
  const logLevel = (['debug', 'info', 'warn', 'error'] as const).includes(process.env.AGENTLINK_LOG_LEVEL as LogLevel)
    ? (process.env.AGENTLINK_LOG_LEVEL as LogLevel)
    : 'info';

  const companion = createCompanion(config, {
    version: typeof __AGENTLINK_VERSION__ === 'string' ? __AGENTLINK_VERSION__ : '0.0.0-dev',
    webDir: join(here, 'web'),
    logLevel,
  });

  try {
    await companion.server.listen();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Is another AgentLink companion running? Set AGENTLINK_PORT to use a different port.`);
    } else {
      console.error('Could not start the AgentLink companion:', error instanceof Error ? error.message : error);
    }
    process.exit(1);
  }

  const address = companion.server.address;
  const status = companion.gemini.status();
  // The pairing token is printed on purpose: it is how the user pairs the extension. It is not the Gemini key.
  const lines = [
    '',
    '  AgentLink companion is running',
    '',
    `  Address         ${address}`,
    `  Data directory  ${config.dataDir}`,
    `  Gemini model    ${status.model}`,
    `  Gemini API key  ${status.keyConfigured ? `configured (${status.keySource === 'saved' ? 'saved locally' : 'from GEMINI_API_KEY'})` : 'NOT CONFIGURED'}`,
    '',
    '  1. Open the settings page to enter or test your Gemini API key:',
    `       ${address}/settings#token=${companion.token}`,
    '  2. Pair the browser extension: AgentLink → Settings → Companion → paste this pairing token:',
    `       ${companion.token}`,
    '',
    '  Press Ctrl+C to stop.',
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');

  if (status.keyConfigured) {
    void companion.gemini.testConnection().then((result) => {
      if (result.state === 'connected') companion.logger.info(`Gemini connection verified (model ${result.model}).`);
      else companion.logger.warn(`Gemini is not ready (${result.state}): ${result.error?.message ?? 'no details'}`);
    });
  }

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void companion.server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
