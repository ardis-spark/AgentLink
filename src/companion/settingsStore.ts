import { join } from 'node:path';
import type { CompanionSettings, ThinkingLevelSetting } from '../shared/types.js';
import { readJsonFile, writeJsonFile } from './jsonFile.js';

/**
 * Default coordinator model. `gemini-4-hydrogen` is the model Google's Gemini
 * API documentation recommends for new projects and agentic, tool-using
 * workloads, and it is available on both the free and the paid tier.
 * It is only a default: any model the key can use is selectable at runtime.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

export const DEFAULT_SETTINGS: CompanionSettings = {
  model: DEFAULT_GEMINI_MODEL,
  thinkingLevel: 'default',
  maxRetries: 3,
  firstChunkTimeoutMs: 180_000,
  idleTimeoutMs: 120_000,
  totalTimeoutMs: 20 * 60_000,
  maxToolRounds: 6,
  maxTasksPerSession: 100,
  contextBudgetChars: 400_000,
  arenaResponseContextChars: 150_000,
};

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

const THINKING_LEVELS: readonly ThinkingLevelSetting[] = ['default', 'low', 'medium', 'high'];

/** Model ids are path segments of the API URL, so they are validated strictly. */
export function validateModelId(value: unknown): string {
  if (typeof value !== 'string') throw new SettingsError('The model must be a string.');
  const id = value.trim().replace(/^models\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(id)) {
    throw new SettingsError(`"${value}" is not a valid Gemini model identifier.`);
  }
  return id;
}

function intInRange(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SettingsError(`${name} must be a number.`);
  const n = Math.round(value);
  if (n < min || n > max) throw new SettingsError(`${name} must be between ${min} and ${max}.`);
  return n;
}

export function applySettingsPatch(current: CompanionSettings, patch: Partial<Record<keyof CompanionSettings, unknown>>): CompanionSettings {
  const next: CompanionSettings = { ...current };
  if (patch.model !== undefined) next.model = validateModelId(patch.model);
  if (patch.thinkingLevel !== undefined) {
    if (!THINKING_LEVELS.includes(patch.thinkingLevel as ThinkingLevelSetting)) {
      throw new SettingsError(`thinkingLevel must be one of: ${THINKING_LEVELS.join(', ')}.`);
    }
    next.thinkingLevel = patch.thinkingLevel as ThinkingLevelSetting;
  }
  if (patch.maxRetries !== undefined) next.maxRetries = intInRange('maxRetries', patch.maxRetries, 0, 8);
  if (patch.firstChunkTimeoutMs !== undefined) {
    next.firstChunkTimeoutMs = intInRange('firstChunkTimeoutMs', patch.firstChunkTimeoutMs, 100, 3_600_000);
  }
  if (patch.idleTimeoutMs !== undefined) {
    next.idleTimeoutMs = intInRange('idleTimeoutMs', patch.idleTimeoutMs, 100, 3_600_000);
  }
  if (patch.totalTimeoutMs !== undefined) {
    next.totalTimeoutMs = intInRange('totalTimeoutMs', patch.totalTimeoutMs, 100, 7_200_000);
  }
  if (patch.maxToolRounds !== undefined) next.maxToolRounds = intInRange('maxToolRounds', patch.maxToolRounds, 1, 12);
  if (patch.maxTasksPerSession !== undefined) {
    next.maxTasksPerSession = intInRange('maxTasksPerSession', patch.maxTasksPerSession, 1, 500);
  }
  if (patch.contextBudgetChars !== undefined) {
    next.contextBudgetChars = intInRange('contextBudgetChars', patch.contextBudgetChars, 2_000, 3_000_000);
  }
  if (patch.arenaResponseContextChars !== undefined) {
    next.arenaResponseContextChars = intInRange('arenaResponseContextChars', patch.arenaResponseContextChars, 500, 1_000_000);
  }
  return next;
}

export class SettingsStore {
  private readonly path: string;
  private settings: CompanionSettings;

  constructor(dataDir: string, envModel: string | null) {
    this.path = join(dataDir, 'settings.json');
    let settings: CompanionSettings = { ...DEFAULT_SETTINGS };
    if (envModel) {
      try {
        settings.model = validateModelId(envModel);
      } catch {
        // An invalid GEMINI_MODEL is ignored in favour of the default.
      }
    }
    try {
      const saved = readJsonFile<Partial<CompanionSettings>>(this.path);
      if (saved) settings = applySettingsPatch(settings, saved);
    } catch {
      // A corrupt settings file falls back to defaults rather than blocking start-up.
    }
    this.settings = settings;
  }

  get(): CompanionSettings {
    return { ...this.settings };
  }

  update(patch: Partial<Record<keyof CompanionSettings, unknown>>): CompanionSettings {
    this.settings = applySettingsPatch(this.settings, patch);
    writeJsonFile(this.path, this.settings);
    return this.get();
  }
}
