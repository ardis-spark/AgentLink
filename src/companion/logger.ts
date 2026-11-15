/**
 * Console logger that scrubs secrets before anything is written. Every log
 * line in the companion goes through here, so a key can never reach a log even
 * if it ends up inside an error message or a URL.
 */

const GOOGLE_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;
const KEY_PARAM_PATTERN = /([?&](?:key|api_key|apiKey)=)[^&\s"']+/g;
const HEADER_PATTERN = /(x-goog-api-key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;

export class SecretRedactor {
  private readonly secrets = new Set<string>();

  /** Registers a literal value that must never appear in output. */
  register(secret: string | null | undefined): void {
    if (secret && secret.length >= 6) this.secrets.add(secret);
  }

  unregister(secret: string | null | undefined): void {
    if (secret) this.secrets.delete(secret);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    }
    return out
      .replace(GOOGLE_KEY_PATTERN, '[REDACTED]')
      .replace(KEY_PARAM_PATTERN, '$1[REDACTED]')
      .replace(HEADER_PATTERN, '$1[REDACTED]')
      .replace(BEARER_PATTERN, '$1[REDACTED]');
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  (level: LogLevel, line: string): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class Logger {
  constructor(
    readonly redactor: SecretRedactor,
    private readonly minLevel: LogLevel = 'info',
    private readonly sink: LogSink = defaultSink,
  ) {}

  private write(level: LogLevel, message: string, details: unknown[]): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const suffix = details.length ? ' ' + details.map(describe).join(' ') : '';
    this.sink(level, this.redactor.redact(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`));
  }

  debug(message: string, ...details: unknown[]): void {
    this.write('debug', message, details);
  }
  info(message: string, ...details: unknown[]): void {
    this.write('info', message, details);
  }
  warn(message: string, ...details: unknown[]): void {
    this.write('warn', message, details);
  }
  error(message: string, ...details: unknown[]): void {
    this.write('error', message, details);
  }
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function silentLogger(): Logger {
  return new Logger(new SecretRedactor(), 'error', () => undefined);
}
