import { ARENA_URL_PATTERNS, type ContentEvent, type ContentRequest, type ExecutionStatusBroadcast, type UiRequest, type UiResult } from '../../shared/messages.js';
import { CompanionClient } from '../lib/companionClient.js';
import { DEFAULT_EXTENSION_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type ExtensionSettings } from '../lib/settings.js';
import { ArenaDispatcher, type BrowserTab, type TabsPort } from './dispatcher.js';

/**
 * Background script: the only part of the extension that touches Arena tabs.
 * It relays between the workspace UI, the Arena adapter and the companion.
 */

let settings: ExtensionSettings = { ...DEFAULT_EXTENSION_SETTINGS };
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded;
});
onSettingsChanged((next) => {
  settings = next;
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
  broadcast: (status) => {
    const message: ExecutionStatusBroadcast = { type: 'agentlink:bg:execution', status };
    // Rejects when no workspace page is open, which is fine.
    void browser.runtime.sendMessage(message).catch(() => undefined);
  },
});

async function handleUi(request: UiRequest): Promise<unknown> {
  switch (request.type) {
    case 'agentlink:ui:listArenaTabs':
      return dispatcher.listTabs();
    case 'agentlink:ui:setPreferredTab':
      return dispatcher.setPreferredTab(request.tabId);
    case 'agentlink:ui:testArena':
      return dispatcher.test(request.tabId);
    case 'agentlink:ui:focusArenaTab':
      await dispatcher.focusTarget();
      return true;
    case 'agentlink:ui:dispatchTask':
      return dispatcher.dispatch(request.projectId, request.taskId);
    case 'agentlink:ui:manualSend':
      return dispatcher.manualSend(request.projectId, request.taskId);
    case 'agentlink:ui:captureResponse':
      return dispatcher.capture(request.projectId, request.taskId);
    case 'agentlink:ui:resumeWatch':
      return dispatcher.resumeWatch(request.projectId, request.taskId);
    case 'agentlink:ui:cancelExecution':
      await dispatcher.cancel(request.projectId, request.taskId);
      return true;
    case 'agentlink:ui:getExecutionStatus':
      return dispatcher.statuses();
    default:
      throw new Error('Unknown request.');
  }
}

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const type = (message as { type?: unknown } | null)?.type;
  if (typeof type !== 'string') return undefined;

  if (type.startsWith('agentlink:ui:')) {
    // Only AgentLink's own pages may drive Arena; a content script cannot.
    if (sender.tab && !sender.url?.startsWith(browser.runtime.getURL(''))) return undefined;
    return handleUi(message as UiRequest).then(
      (value): UiResult<unknown> => ({ ok: true, value }),
      (error: unknown): UiResult<unknown> => ({ ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }),
    );
  }

  if (type === 'agentlink:arena:progress' || type === 'agentlink:arena:response' || type === 'agentlink:arena:timeout') {
    void dispatcher.onContentEvent(message as ContentEvent, sender.tab?.id ?? null);
  }
  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => {
  dispatcher.tabClosed(tabId);
  if (tabId === workspaceTabId) workspaceTabId = null;
});

browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete') void dispatcher.tabReloaded(tabId);
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
