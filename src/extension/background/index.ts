import { ARENA_URL_PATTERNS, type ContentRequest, type UiRequest, type UiResult } from '../../shared/messages.js';
import { CompanionClient } from '../lib/companionClient.js';
import { DEFAULT_EXTENSION_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type ExtensionSettings } from '../lib/settings.js';
import { ArenaDispatcher, type BrowserTab, type TabsPort } from './dispatcher.js';

/**
 * Background script: the only part of the extension that touches Arena tabs.
 *
 * It runs the relay between the companion and Arena on its own, whether or
 * not an AgentLink page is open: every few seconds it asks the companion what
 * is outstanding, types queued tasks into Arena, follows them until Arena has
 * finished, and brings the replies back. Nothing here waits for a click.
 */

/** How often the relay looks for work. Each look is one request to the local companion. */
const RELAY_INTERVAL_MS = 3_000;

let settings: ExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded;
});

const client = new CompanionClient(() => ({ url: settings.companionUrl, token: settings.pairingToken }));

const tabsPort: TabsPort = {
  async queryArenaTabs(): Promise<BrowserTab[]> {
    const tabs = await browser.tabs.query({ url: [...ARENA_URL_PATTERNS] });
    return tabs
      .filter((tab): tab is browser.tabs.Tab & { id: number } => typeof tab.id === 'number')
      .map((tab) => ({ id: tab.id, windowId: tab.windowId ?? null, title: tab.title ?? '', url: tab.url ?? '', active: tab.active }));
  },
  send(tabId: number, request: ContentRequest): Promise<unknown> {
    // Frame 0 only: the adapter works on the top-level Arena page.
    return browser.tabs.sendMessage(tabId, request, { frameId: 0 });
  },
  async inject(tabId: number): Promise<void> {
    await browser.tabs.executeScript(tabId, { file: '/content/arena.js', runAt: 'document_idle' });
  },
  async focus(tabId: number): Promise<void> {
    const tab = await browser.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === 'number') await browser.windows.update(tab.windowId, { focused: true });
  },
};

const dispatcher = new ArenaDispatcher({
  tabs: tabsPort,
  client,
  getSettings: async () => {
    await settingsReady;
    return settings;
  },
  saveSettings: async (patch) => {
    settings = await saveSettings(patch);
    return settings;
  },
});

// ------------------------------------------------------------ the relay ---

function runRelay(): void {
  void settingsReady.then(() => dispatcher.tick()).catch(() => undefined);
}

setInterval(runRelay, RELAY_INTERVAL_MS);
runRelay();

onSettingsChanged((next) => {
  settings = next;
  // A new pairing token or companion address may be what the relay was waiting for.
  runRelay();
});

async function handleUi(request: UiRequest): Promise<unknown> {
  switch (request.type) {
    case 'agentlink:ui:listArenaTabs':
      return dispatcher.listTabs();
    case 'agentlink:ui:setPreferredTab': {
      const tabs = await dispatcher.setPreferredTab(request.tabId);
      runRelay();
      return tabs;
    }
    case 'agentlink:ui:testArena':
      return dispatcher.test(request.tabId);
    case 'agentlink:ui:focusArenaTab':
      await dispatcher.focusTarget();
      return true;
    case 'agentlink:ui:wake':
      runRelay();
      return dispatcher.link();
    case 'agentlink:ui:captureResponse':
      return dispatcher.capture(request.projectId, request.taskId);
    default:
      throw new Error('Unknown request.');
  }
}

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const type = (message as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !type.startsWith('agentlink:ui:')) return undefined;
  // Only AgentLink's own pages may drive Arena; a content script cannot.
  if (sender.tab && !sender.url?.startsWith(browser.runtime.getURL(''))) return undefined;
  return handleUi(message as UiRequest).then(
    (value): UiResult<unknown> => ({ ok: true, value }),
    (error: unknown): UiResult<unknown> => ({ ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }),
  );
});

// A tab that opened, closed or finished loading may be exactly what a waiting task needs: look at once.
browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === workspaceTabId) workspaceTabId = null;
  runRelay();
});

browser.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.status === 'complete') runRelay();
});

// ------------------------------------------------------- toolbar button ---

let workspaceTabId: number | null = null;

browser.browserAction.onClicked.addListener(() => {
  void (async () => {
    if (workspaceTabId !== null) {
      try {
        const tab = await browser.tabs.update(workspaceTabId, { active: true });
        if (typeof tab.windowId === 'number') await browser.windows.update(tab.windowId, { focused: true });
        return;
      } catch {
        workspaceTabId = null;
      }
    }
    const tab = await browser.tabs.create({ url: browser.runtime.getURL('ui/index.html') });
    workspaceTabId = tab.id ?? null;
  })();
});
