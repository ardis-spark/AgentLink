import type { ContentRequest } from '../../shared/messages.js';
import { createArenaAdapter } from './arenaAdapter.js';

/**
 * Content script entry point for Arena tabs. It only exchanges messages with
 * AgentLink's own background script; it holds no credentials and makes no
 * network requests.
 */
declare global {
  interface Window {
    __agentlinkArenaAdapter?: boolean;
  }
}

if (!window.__agentlinkArenaAdapter) {
  // The script can be injected again into a tab that was open before the extension loaded; run once.
  window.__agentlinkArenaAdapter = true;

  const adapter = createArenaAdapter({
    doc: document,
    win: window,
    emit: (event) => {
      void browser.runtime.sendMessage(event).catch(() => undefined);
    },
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    const request = message as ContentRequest | null;
    if (!request || typeof request.type !== 'string' || !request.type.startsWith('agentlink:arena:')) return undefined;
    return adapter.handle(request);
  });
}

export {};
