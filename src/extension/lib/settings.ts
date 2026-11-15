import { COMPANION_DEFAULT_URL } from '../../shared/api.js';
import { DEFAULT_ARENA_ADAPTER_CONFIG, type ArenaAdapterConfig, type PreferredArenaTab } from '../../shared/messages.js';

/**
 * What the extension itself remembers. Note what is absent: there is no
 * Gemini key here and no way to obtain one. The pairing token only lets the
 * extension talk to the local companion.
 */
export interface ExtensionSettings {
  companionUrl: string;
  pairingToken: string;
  preferredTab: PreferredArenaTab | null;
  adapter: ArenaAdapterConfig;
}

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  companionUrl: COMPANION_DEFAULT_URL,
  pairingToken: '',
  preferredTab: null,
  adapter: { ...DEFAULT_ARENA_ADAPTER_CONFIG },
};

const STORAGE_KEY = 'agentlink.settings';

/**
 * The companion only ever listens on the loopback interface. Anything else is
 * refused so the pairing token can never be sent to another machine.
 */
export function normalizeCompanionUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return COMPANION_DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error('Enter the companion address as http://127.0.0.1:PORT.');
  }
  if (url.protocol !== 'http:') throw new Error('The companion address must start with http://.');
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('The companion runs on this computer only. Use 127.0.0.1 or localhost.');
  }
  if (url.username || url.password) throw new Error('The companion address must not contain credentials.');
  return `http://${url.hostname}${url.port ? `:${url.port}` : ''}`;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Validates selectors up front so a typo is reported in settings rather than failing silently on the page. */
export function validateSelector(selector: string): string | null {
  if (!selector.trim()) return null;
  try {
    document.createDocumentFragment().querySelector(selector);
    return null;
  } catch {
    return `"${selector}" is not a valid CSS selector.`;
  }
}

export function sanitizeAdapterConfig(input: Partial<ArenaAdapterConfig> | undefined): ArenaAdapterConfig {
  const base = DEFAULT_ARENA_ADAPTER_CONFIG;
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim().slice(0, 500) : '');
  return {
    composerSelector: text(input?.composerSelector),
    sendButtonSelector: text(input?.sendButtonSelector),
    responseSelector: text(input?.responseSelector),
    busySelector: text(input?.busySelector),
    settleMs: clampNumber(input?.settleMs, base.settleMs, 2_000, 10 * 60_000),
    maxWaitMs: clampNumber(input?.maxWaitMs, base.maxWaitMs, 60_000, 6 * 60 * 60_000),
  };
}

export function sanitizeSettings(input: unknown): ExtensionSettings {
  const value = (input && typeof input === 'object' ? input : {}) as Partial<ExtensionSettings>;
  let companionUrl = COMPANION_DEFAULT_URL;
  try {
    companionUrl = normalizeCompanionUrl(typeof value.companionUrl === 'string' ? value.companionUrl : '');
  } catch {
    companionUrl = COMPANION_DEFAULT_URL;
  }
  const tab = value.preferredTab;
  return {
    companionUrl,
    pairingToken: typeof value.pairingToken === 'string' ? value.pairingToken.trim() : '',
    preferredTab:
      tab && typeof tab.tabId === 'number'
        ? { tabId: tab.tabId, url: typeof tab.url === 'string' ? tab.url : '', title: typeof tab.title === 'string' ? tab.title : '' }
        : null,
    adapter: sanitizeAdapterConfig(value.adapter),
  };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return sanitizeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await browser.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export function onSettingsChanged(listener: (settings: ExtensionSettings) => void): () => void {
  const handler = (changes: Record<string, browser.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    listener(sanitizeSettings(changes[STORAGE_KEY].newValue));
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}
