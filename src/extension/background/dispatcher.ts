import type { ArenaTask } from '../../shared/types.js';
import type {
  ArenaAdapterConfig,
  ArenaConnectionTest,
  ArenaExecutionPhase,
  ArenaExecutionStatus,
  ArenaPageStatus,
  ArenaTabInfo,
  CaptureResult,
  ContentEvent,
  ContentRequest,
  ManualSendResult,
  SubmitPromptResult,
} from '../../shared/messages.js';
import { CompanionError, type CompanionClient } from '../lib/companionClient.js';
import type { ExtensionSettings } from '../lib/settings.js';

/** A browser tab on an Arena page, as far as the browser knows it. */
export interface BrowserTab {
  id: number;
  windowId: number | null;
  title: string;
  url: string;
  active: boolean;
}

/** The slice of the browser the dispatcher needs. Injected so the workflow can be tested without a browser. */
export interface TabsPort {
  /** Every open tab on an Arena address. */
  queryArenaTabs(): Promise<BrowserTab[]>;
  /** Sends a request to the adapter in a tab. Rejects when no adapter is listening there. */
  send(tabId: number, request: ContentRequest): Promise<unknown>;
  /** Loads the adapter into a tab that was opened before the extension. */
  inject(tabId: number): Promise<void>;
  focus(tabId: number): Promise<void>;
}

export type DispatcherClient = Pick<
  CompanionClient,
  'getTask' | 'claimDispatch' | 'confirmDispatch' | 'failDispatch' | 'recordArenaResponse'
>;

export interface DispatcherDeps {
  tabs: TabsPort;
  client: DispatcherClient;
  getSettings: () => Promise<ExtensionSettings>;
  saveSettings: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
  broadcast: (status: ArenaExecutionStatus) => void;
  /** Delay between delivery retries; shortened in tests. */
  retryDelayMs?: number;
}

interface Execution {
  status: ArenaExecutionStatus;
  tabId: number | null;
  prompt: string;
  /** A captured reply that has not reached the companion yet. */
  pendingText: string | null;
}

/** An error whose message is safe and useful to show to the user as-is. */
export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

const key = (projectId: string, taskId: string): string => `${projectId}/${taskId}`;
const WATCHING: readonly ArenaExecutionPhase[] = ['submitted', 'generating', 'settling', 'needs_manual_send'];

/**
 * Carries an approved task to Arena and brings the reply back.
 *
 * The companion is the authority on what may be sent: a task is claimed from
 * it before anything is typed, and the claim succeeds only once. The
 * dispatcher reports back exactly what happened — confirmed, definitely not
 * sent, or unknown — and never re-sends on its own.
 */
export class ArenaDispatcher {
  private readonly executions = new Map<string, Execution>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: DispatcherDeps) {}

  // ------------------------------------------------------------------ tabs ---

  private async ping(tabId: number, config: ArenaAdapterConfig): Promise<ArenaPageStatus> {
    const request: ContentRequest = { type: 'agentlink:arena:ping', config };
    const ask = async (): Promise<ArenaPageStatus | null> => {
      const answer = (await this.deps.tabs.send(tabId, request)) as ArenaPageStatus | undefined;
      return answer && answer.ok === true ? answer : null;
    };
    try {
      const first = await ask();
      if (first) return first;
    } catch {
      // No adapter in the tab yet; try loading it.
    }
    try {
      await this.deps.tabs.inject(tabId);
      const second = await ask();
      if (second) return second;
    } catch {
      // Reported below.
    }
    throw new DispatchError('AgentLink could not reach the Arena tab. Reload that tab and try again.');
  }

  async listTabs(): Promise<ArenaTabInfo[]> {
    const settings = await this.deps.getSettings();
    const tabs = await this.deps.tabs.queryArenaTabs();
    return Promise.all(
      tabs.map(async (tab): Promise<ArenaTabInfo> => {
        const base = { tabId: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active, preferred: settings.preferredTab?.tabId === tab.id };
        try {
          return { ...base, page: await this.ping(tab.id, settings.adapter), error: null };
        } catch (error) {
          return { ...base, page: null, error: error instanceof Error ? error.message : 'The tab did not respond.' };
        }
      }),
    );
  }

  async setPreferredTab(tabId: number | null): Promise<ArenaTabInfo[]> {
    if (tabId === null) {
      await this.deps.saveSettings({ preferredTab: null });
    } else {
      const tab = (await this.deps.tabs.queryArenaTabs()).find((t) => t.id === tabId);
      if (!tab) throw new DispatchError('That tab is no longer open on Arena.');
      await this.deps.saveSettings({ preferredTab: { tabId: tab.id, url: tab.url, title: tab.title } });
    }
    return this.listTabs();
  }

  /**
   * Chooses the tab a task goes to. It never guesses between several tabs:
   * the user's preferred tab is used, or the only Arena tab that is open.
   */
  async resolveTarget(settings: ExtensionSettings): Promise<BrowserTab> {
    const tabs = await this.deps.tabs.queryArenaTabs();
    const preferred = settings.preferredTab;
    if (preferred) {
      const same = tabs.find((t) => t.id === preferred.tabId);
      if (same) return same;
      // Tab ids change when the browser restarts; the same conversation address identifies the tab again.
      const byUrl = tabs.filter((t) => t.url === preferred.url);
      if (byUrl.length === 1 && byUrl[0]) {
        await this.deps.saveSettings({ preferredTab: { tabId: byUrl[0].id, url: byUrl[0].url, title: byUrl[0].title } });
        return byUrl[0];
      }
      if (tabs.length === 0) throw new DispatchError('Your preferred Arena tab is closed and no other Arena tab is open. Open Arena Agent Mode in a tab.');
      throw new DispatchError('Your preferred Arena tab is no longer open. Choose which Arena tab AgentLink should use.');
    }
    if (tabs.length === 0) throw new DispatchError('No Arena tab is open. Open Arena Agent Mode in a tab, then send the task.');
    if (tabs.length > 1) throw new DispatchError(`${tabs.length} Arena tabs are open. Choose which one AgentLink should use.`);
    return tabs[0] as BrowserTab;
  }

  async focusTarget(): Promise<void> {
    const tab = await this.resolveTarget(await this.deps.getSettings());
    await this.deps.tabs.focus(tab.id);
  }

  async test(tabId?: number | null): Promise<ArenaConnectionTest> {
    const settings = await this.deps.getSettings();
    const checks: ArenaConnectionTest['checks'] = [];
    let tab: BrowserTab;
    try {
      if (typeof tabId === 'number') {
        const found = (await this.deps.tabs.queryArenaTabs()).find((t) => t.id === tabId);
        if (!found) throw new DispatchError('That tab is no longer open on Arena.');
        tab = found;
      } else {
        tab = await this.resolveTarget(settings);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No Arena tab could be selected.';
      return { ok: false, tab: null, checks: [{ label: 'Arena tab', ok: false, detail: message }], message };
    }
    checks.push({ label: 'Arena tab', ok: true, detail: tab.title || tab.url });
    const info: ArenaTabInfo = { tabId: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active, preferred: settings.preferredTab?.tabId === tab.id, page: null, error: null };

    let page: ArenaPageStatus;
    try {
      page = await this.ping(tab.id, settings.adapter);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The tab did not respond.';
      checks.push({ label: 'AgentLink adapter', ok: false, detail: message });
      return { ok: false, tab: { ...info, error: message }, checks, message };
    }
    info.page = page;
    checks.push({ label: 'AgentLink adapter', ok: true, detail: 'Responding in the tab.' });
    checks.push({
      label: 'Message box',
      ok: page.composerFound,
      detail: page.composerFound ? 'Found.' : 'Not found. Open a conversation in Arena, or set the composer selector in settings.',
    });
    checks.push({
      label: 'Send control',
      ok: true,
      detail: page.sendButtonFound ? 'Found.' : 'No send button recognised; the Enter key will be used instead.',
    });
    checks.push({
      label: 'Agent Mode',
      ok: page.agentMode !== false,
      detail:
        page.agentMode === true
          ? 'Agent Mode appears to be selected.'
          : page.agentMode === false
            ? 'Another mode appears to be selected. Switch the Arena tab to Agent Mode.'
            : 'The page does not say which mode is active. Make sure Agent Mode is selected in the tab.',
    });
    checks.push({ label: 'Ready', ok: !page.busy, detail: page.busy ? 'Arena is currently working on a request.' : 'Arena is idle.' });

    const ok = page.composerFound && page.agentMode !== false;
    const failed = checks.find((c) => !c.ok);
    // Nothing is typed or sent by this test; it only inspects the page.
    return { ok, tab: info, checks, message: ok ? (page.busy ? 'Arena is reachable, but busy right now.' : 'Arena is reachable and ready.') : (failed?.detail ?? 'Arena is not ready.') };
  }

  // --------------------------------------------------------------- statuses ---

  statuses(): ArenaExecutionStatus[] {
    return Array.from(this.executions.values(), (e) => e.status);
  }

  private setStatus(projectId: string, taskId: string, patch: Partial<ArenaExecutionStatus> & { phase: ArenaExecutionPhase; message: string }, extra: Partial<Omit<Execution, 'status'>> = {}): Execution {
    const id = key(projectId, taskId);
    const previous = this.executions.get(id);
    const status: ArenaExecutionStatus = {
      projectId,
      taskId,
      dispatchId: previous?.status.dispatchId ?? null,
      chars: previous?.status.chars ?? 0,
      ...patch,
      updatedAt: Date.now(),
    };
    const execution: Execution = {
      tabId: previous?.tabId ?? null,
      prompt: previous?.prompt ?? '',
      pendingText: previous?.pendingText ?? null,
      ...extra,
      status,
    };
    this.executions.set(id, execution);
    this.deps.broadcast(status);
    return execution;
  }

  private async retry<T>(work: () => Promise<T>, attempts = 4): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        lastError = error;
        // Only an unreachable companion is worth retrying; a refusal is final.
        if (!(error instanceof CompanionError) || error.code !== 'offline') throw error;
        await new Promise((resolve) => setTimeout(resolve, (this.deps.retryDelayMs ?? 1_500) * (attempt + 1)));
      }
    }
    throw lastError;
  }

  // --------------------------------------------------------------- dispatch ---

  /** Sends an approved task to Arena. Resolves once Arena has accepted it; rejects with a user-facing reason otherwise. */
  async dispatch(projectId: string, taskId: string): Promise<ArenaExecutionStatus> {
    const id = key(projectId, taskId);
    if (this.inFlight.has(id)) throw new DispatchError('This task is already being sent.');
    this.inFlight.add(id);
    try {
      const settings = await this.deps.getSettings();
      // Everything that can be checked is checked before the task is claimed, so a failed check costs nothing.
      const tab = await this.resolveTarget(settings);
      const page = await this.ping(tab.id, settings.adapter);
      if (!page.composerFound) throw new DispatchError("Arena's message box was not found in the selected tab. Open an Arena Agent Mode conversation there.");
      if (page.agentMode === false) throw new DispatchError('The selected Arena tab is not in Agent Mode. Switch it to Agent Mode, then send the task.');
      if (page.busy) throw new DispatchError('Arena is still working on a previous request in the selected tab. Wait for it to finish.');

      const claim = await this.deps.client.claimDispatch(projectId, taskId, { tabId: tab.id, tabUrl: tab.url });
      this.setStatus(projectId, taskId, { phase: 'sending', message: 'Typing the task into Arena…', dispatchId: claim.dispatchId, chars: 0 }, { tabId: tab.id, prompt: claim.prompt, pendingText: null });

      let result: SubmitPromptResult;
      try {
        const answer = (await this.deps.tabs.send(tab.id, {
          type: 'agentlink:arena:submit',
          projectId,
          taskId,
          dispatchId: claim.dispatchId,
          prompt: claim.prompt,
          config: settings.adapter,
        })) as SubmitPromptResult | undefined;
        result = answer && typeof answer.ok === 'boolean' ? answer : { ok: false, submitted: 'unknown', error: 'The Arena tab gave no answer while the task was being sent. Check the tab before sending anything again.' };
      } catch {
        result = { ok: false, submitted: 'unknown', error: 'The Arena tab was closed or reloaded while the task was being sent. Check the tab before sending anything again.' };
      }

      if (!result.ok) {
        const failure = result;
        await this.retry(() => this.deps.client.failDispatch(projectId, taskId, { dispatchId: claim.dispatchId, error: failure.error, submitted: failure.submitted }));
        this.setStatus(projectId, taskId, { phase: 'error', message: failure.error });
        throw new DispatchError(failure.error);
      }

      await this.retry(() => this.deps.client.confirmDispatch(projectId, taskId, claim.dispatchId));
      const execution = this.setStatus(projectId, taskId, { phase: 'submitted', message: 'Arena accepted the task. Waiting for its reply…' });
      await this.startWatch(execution, settings.adapter);
      return this.executions.get(id)?.status ?? execution.status;
    } catch (error) {
      if (error instanceof DispatchError) throw error;
      throw new DispatchError(error instanceof Error ? error.message : 'The task could not be sent.');
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * The manual route: the task is recorded as sent and its exact text is handed back for the user to paste into
   * Arena. Used when the adapter cannot operate Arena's message box.
   */
  async manualSend(projectId: string, taskId: string): Promise<ManualSendResult> {
    const id = key(projectId, taskId);
    if (this.inFlight.has(id)) throw new DispatchError('This task is already being sent.');
    this.inFlight.add(id);
    try {
      const settings = await this.deps.getSettings();
      let tab: BrowserTab | null = null;
      try {
        tab = await this.resolveTarget(settings);
      } catch {
        tab = null; // Without a tab the reply simply has to be pasted back by hand.
      }
      const claim = await this.deps.client.claimDispatch(projectId, taskId, { tabId: tab?.id ?? null, tabUrl: tab?.url ?? null });
      await this.retry(() => this.deps.client.confirmDispatch(projectId, taskId, claim.dispatchId));
      const execution = this.setStatus(
        projectId,
        taskId,
        { phase: 'needs_manual_send', message: 'Paste the copied task into Arena and send it. AgentLink is watching for the reply.', dispatchId: claim.dispatchId, chars: 0 },
        { tabId: tab?.id ?? null, prompt: claim.prompt, pendingText: null },
      );
      let watching = false;
      if (tab) {
        try {
          await this.ping(tab.id, settings.adapter);
          await this.startWatch(execution, settings.adapter, true);
          watching = true;
        } catch {
          watching = false;
        }
      }
      if (!watching) {
        this.setStatus(projectId, taskId, { phase: 'needs_manual_send', message: 'Paste the copied task into Arena and send it. When Arena has answered, paste its reply here.' });
      }
      return { prompt: claim.prompt, watching };
    } catch (error) {
      if (error instanceof DispatchError) throw error;
      throw new DispatchError(error instanceof Error ? error.message : 'The task could not be marked as sent.');
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async startWatch(execution: Execution, config: ArenaAdapterConfig, keepPhase = false): Promise<void> {
    const { projectId, taskId, dispatchId } = execution.status;
    if (execution.tabId === null || !dispatchId) return;
    try {
      await this.deps.tabs.send(execution.tabId, { type: 'agentlink:arena:watch', projectId, taskId, dispatchId, prompt: execution.prompt, config });
    } catch {
      if (!keepPhase) {
        this.setStatus(projectId, taskId, { phase: 'timeout', message: 'The task was sent, but AgentLink lost contact with the Arena tab. Capture the reply when Arena has finished.' });
      }
      throw new DispatchError('AgentLink lost contact with the Arena tab.');
    }
  }

  // ----------------------------------------------------------------- replies ---

  private async taskAwaitingReply(projectId: string, taskId: string): Promise<ArenaTask & { dispatch: NonNullable<ArenaTask['dispatch']> }> {
    const { task } = await this.deps.client.getTask(projectId, taskId);
    if (task.status !== 'awaiting_response' || !task.dispatch) {
      throw new DispatchError(`Task ${taskId} is not waiting for a reply from Arena.`);
    }
    return task as ArenaTask & { dispatch: NonNullable<ArenaTask['dispatch']> };
  }

  /** The tab a sent task lives in: the one it was sent to if that is still open, otherwise the selected tab. */
  private async tabForTask(projectId: string, taskId: string, task: ArenaTask, settings: ExtensionSettings): Promise<BrowserTab> {
    const tabs = await this.deps.tabs.queryArenaTabs();
    const known = this.executions.get(key(projectId, taskId))?.tabId ?? task.dispatch?.tabId ?? null;
    const sameTab = tabs.find((t) => t.id === known);
    if (sameTab) return sameTab;
    const sameUrl = tabs.filter((t) => t.url === task.dispatch?.tabUrl);
    if (sameUrl.length === 1 && sameUrl[0]) return sameUrl[0];
    return this.resolveTarget(settings);
  }

  /** Reads Arena's reply to a sent task right now, at the user's request. */
  async capture(projectId: string, taskId: string): Promise<ArenaExecutionStatus> {
    const settings = await this.deps.getSettings();
    const task = await this.taskAwaitingReply(projectId, taskId);
    const tab = await this.tabForTask(projectId, taskId, task, settings);
    await this.ping(tab.id, settings.adapter);
    let result: CaptureResult | undefined;
    try {
      result = (await this.deps.tabs.send(tab.id, { type: 'agentlink:arena:capture', prompt: task.dispatch.prompt, config: settings.adapter })) as CaptureResult | undefined;
    } catch {
      throw new DispatchError('AgentLink lost contact with the Arena tab. Reload it and try again.');
    }
    if (!result || !result.ok) throw new DispatchError(result?.error ?? 'The Arena tab gave no answer.');

    await this.deps.tabs.send(tab.id, { type: 'agentlink:arena:cancel', dispatchId: task.dispatch.dispatchId }).catch(() => undefined);
    const text = result.text;
    try {
      await this.deps.client.recordArenaResponse(projectId, taskId, { dispatchId: task.dispatch.dispatchId, text, source: 'manual_capture' });
    } catch (error) {
      throw new DispatchError(error instanceof Error ? error.message : 'The reply could not be handed to the companion.');
    }
    return this.setStatus(projectId, taskId, { phase: 'captured', message: 'Reply captured and handed to Gemini for evaluation.', dispatchId: task.dispatch.dispatchId, chars: text.length }, { tabId: tab.id, prompt: task.dispatch.prompt, pendingText: null }).status;
  }

  /** Starts watching again for a task that is already waiting (after a browser restart or a reloaded tab). */
  async resumeWatch(projectId: string, taskId: string): Promise<ArenaExecutionStatus | null> {
    const existing = this.executions.get(key(projectId, taskId));
    if (existing && WATCHING.includes(existing.status.phase) && existing.tabId !== null) return existing.status;
    const settings = await this.deps.getSettings();
    const task = await this.taskAwaitingReply(projectId, taskId);
    const tab = await this.tabForTask(projectId, taskId, task, settings);
    await this.ping(tab.id, settings.adapter);
    const execution = this.setStatus(
      projectId,
      taskId,
      { phase: 'submitted', message: 'Watching the Arena tab for the reply…', dispatchId: task.dispatch.dispatchId, chars: 0 },
      { tabId: tab.id, prompt: task.dispatch.prompt, pendingText: null },
    );
    await this.startWatch(execution, settings.adapter);
    return this.executions.get(key(projectId, taskId))?.status ?? null;
  }

  async cancel(projectId: string, taskId: string): Promise<void> {
    const id = key(projectId, taskId);
    const execution = this.executions.get(id);
    if (!execution) return;
    this.executions.delete(id);
    if (execution.tabId !== null) {
      await this.deps.tabs.send(execution.tabId, { type: 'agentlink:arena:cancel', dispatchId: execution.status.dispatchId }).catch(() => undefined);
    }
    this.deps.broadcast({ ...execution.status, phase: 'idle', message: '', updatedAt: Date.now() });
  }

  /** A watched tab finished loading again: its adapter is new and has to be told what to watch for. */
  async tabReloaded(tabId: number): Promise<void> {
    for (const execution of this.executions.values()) {
      if (execution.tabId !== tabId || !WATCHING.includes(execution.status.phase)) continue;
      const settings = await this.deps.getSettings();
      try {
        await this.ping(tabId, settings.adapter);
        await this.startWatch(execution, settings.adapter, true);
      } catch {
        // startWatch has already recorded the lost contact where appropriate.
      }
    }
  }

  tabClosed(tabId: number): void {
    for (const execution of this.executions.values()) {
      if (execution.tabId !== tabId || !WATCHING.includes(execution.status.phase)) continue;
      const { projectId, taskId } = execution.status;
      this.setStatus(projectId, taskId, { phase: 'error', message: 'The Arena tab was closed before a reply was captured. Reopen the conversation and capture the reply, or paste it here.' }, { tabId: null });
    }
  }

  /** Notifications from the adapter in an Arena tab. */
  async onContentEvent(event: ContentEvent, senderTabId: number | null): Promise<void> {
    const execution = this.executions.get(key(event.projectId, event.taskId));
    // Only the tab and the dispatch this task was actually sent with are listened to.
    if (!execution || execution.status.dispatchId !== event.dispatchId) return;
    if (senderTabId !== null && execution.tabId !== null && senderTabId !== execution.tabId) return;
    const { projectId, taskId } = event;

    if (event.type === 'agentlink:arena:progress') {
      this.setStatus(projectId, taskId, {
        phase: event.generating ? 'generating' : 'settling',
        message: event.generating ? 'Arena is working…' : 'Arena has stopped writing. Making sure the reply is complete…',
        chars: event.chars,
      });
      return;
    }
    if (event.type === 'agentlink:arena:timeout') {
      this.setStatus(projectId, taskId, {
        phase: 'timeout',
        message:
          event.chars > 0
            ? 'Arena was still working when AgentLink stopped waiting. Capture the reply when it has finished.'
            : 'AgentLink could not find this task in the Arena tab. If you sent it in another conversation, open that one and capture the reply, or paste it here.',
        chars: event.chars,
      });
      return;
    }
    await this.deliver(projectId, taskId, event.dispatchId, event.text);
  }

  private async deliver(projectId: string, taskId: string, dispatchId: string, text: string): Promise<void> {
    this.setStatus(projectId, taskId, { phase: 'captured', message: 'Reply captured. Handing it to Gemini…', chars: text.length }, { pendingText: text });
    try {
      await this.retry(() => this.deps.client.recordArenaResponse(projectId, taskId, { dispatchId, text, source: 'auto' }), 6);
      this.setStatus(projectId, taskId, { phase: 'captured', message: 'Reply captured and handed to Gemini for evaluation.', chars: text.length }, { pendingText: null });
    } catch (error) {
      if (error instanceof CompanionError && error.code === 'offline') {
        this.setStatus(projectId, taskId, { phase: 'error', message: 'The reply was captured, but the companion is not running. Start it, then use "Capture reply".', chars: text.length });
        return;
      }
      // The companion refused it (the task was cancelled, or a reply is already recorded): nothing more to do.
      this.setStatus(projectId, taskId, { phase: 'idle', message: error instanceof Error ? error.message : '', chars: text.length }, { pendingText: null });
    }
  }
}
