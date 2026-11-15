import type { RelayWorkItem } from '../../shared/api.js';
import { digestOf } from '../../shared/text.js';
import type { ArenaCompletion, ArenaTask, RelayPhase } from '../../shared/types.js';
import type {
  ArenaAdapterConfig,
  ArenaConnectionTest,
  ArenaPageStatus,
  ArenaTabInfo,
  CaptureResult,
  ContentRequest,
  ProbeResult,
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
  'getTask' | 'claimDispatch' | 'confirmDispatch' | 'failDispatch' | 'resetDispatch' | 'recordArenaResponse' | 'recordNoResponse' | 'relayWork' | 'reportRelay'
>;

/** How patient the relay is. All of it can be shortened in tests. */
export interface RelayTiming {
  /** Quiet time required when the reply already ends with the completion line. */
  markerSettleMs: number;
  /** How long a task whose delivery is in doubt is looked for before it is sent again. */
  verifyMs: number;
  /** Arena has the task, is not working, and has written nothing: after this long the task is closed as "no reply". */
  noReplyMs: number;
  /** A delivery nobody finished (the browser restarted mid-way) is taken over after this long. */
  staleClaimMs: number;
  /** A gap between two looks at the page longer than this means time passed unobserved (sleep, suspended browser). */
  observationGapMs: number;
  /** Waits between attempts to type a task that Arena did not accept. */
  retryBackoffMs: readonly number[];
  /** Progress is reported to the companion no more often than this. */
  reportMs: number;
  /** How long a sent task may be missing from every Arena tab before the user is asked to open its conversation. */
  missingAttentionMs: number;
}

export const DEFAULT_RELAY_TIMING: RelayTiming = {
  markerSettleMs: 3_000,
  verifyMs: 30_000,
  noReplyMs: 5 * 60_000,
  staleClaimMs: 45_000,
  observationGapMs: 30_000,
  retryBackoffMs: [3_000, 10_000, 30_000, 60_000],
  reportMs: 5_000,
  missingAttentionMs: 20_000,
};

export interface DispatcherDeps {
  tabs: TabsPort;
  client: DispatcherClient;
  getSettings: () => Promise<ExtensionSettings>;
  saveSettings: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
  timing?: Partial<RelayTiming>;
  now?: () => number;
}

/** What the relay remembers about the task it is carrying. All of it can be rebuilt from the companion and the page. */
interface Tracking {
  dispatchId: string | null;
  tabId: number | null;
  /** When the task's message was first seen in the page. */
  foundAt: number | null;
  lastSeenAt: number;
  lastDigest: string;
  /** When the reply text last changed (as far as it was observed). */
  lastChangeAt: number;
  sawBusy: boolean;
  missingSince: number | null;
  /** A reply that was read in full and has not been accepted by the companion yet. It is retried until it is. */
  pending: { text: string; completion: ArenaCompletion } | null;
  failures: number;
  nextAttemptAt: number;
  lastReportKey: string;
  lastReportAt: number;
  lastReportChars: number;
}

/** An error whose message is safe and useful to show to the user as-is. */
export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

export type RelayLinkState = 'starting' | 'online' | 'offline' | 'unpaired' | 'unauthorized' | 'error';

const key = (projectId: string, taskId: string): string => `${projectId}/${taskId}`;
/** Refusals that mean the companion has moved on; repeating the request cannot succeed. */
const FINAL_REFUSALS: readonly string[] = ['response_already_recorded', 'invalid_state', 'stale_dispatch', 'task_not_found', 'project_not_found', 'invalid_request'];

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  return `${value} minute${value === 1 ? '' : 's'}`;
}

/**
 * The relay between the companion and Arena. It needs no one to press
 * anything: every few seconds it asks the companion what is outstanding and
 * moves each task one step along.
 *
 *  - A queued task is typed into Arena. The companion hands a task out once
 *    per attempt, and the page is checked first, so it is never typed twice.
 *  - A task whose delivery is in doubt is looked for in the page. Found: the
 *    delivery is confirmed. Not there: it goes back to the queue.
 *  - A sent task is watched by asking the page for a snapshot each time. No
 *    state lives in the page, so reloads, navigation, throttled background
 *    tabs and a restarted browser cannot lose the reply; any Arena tab that
 *    shows the task is used.
 *  - A finished reply is read in full, checked against the snapshot that
 *    was judged finished, and handed to the companion — again and again
 *    until the companion has it.
 *  - Nothing is ever reported as done without a reply: a task Arena never
 *    answered is closed as "no reply", and every wait that depends on the
 *    user is reported with the reason.
 */
export class ArenaDispatcher {
  private readonly trackings = new Map<string, Tracking>();
  private readonly timing: RelayTiming;
  private ticking: Promise<void> | null = null;
  private linkState: RelayLinkState = 'starting';

  constructor(private readonly deps: DispatcherDeps) {
    this.timing = { ...DEFAULT_RELAY_TIMING, ...deps.timing };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Whether the relay can reach the companion. */
  link(): RelayLinkState {
    return this.linkState;
  }

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
    throw new DispatchError('AgentLink could not reach the Arena tab. Reload that tab; AgentLink continues by itself.');
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
      if (same) return this.rememberTab(settings, same);
      // Tab ids change when the browser restarts; the same conversation address identifies the tab again.
      const byUrl = tabs.filter((t) => t.url === preferred.url);
      if (byUrl.length === 1 && byUrl[0]) return this.rememberTab(settings, byUrl[0]);
      // Arena also changes a conversation's address as it goes. With one Arena tab open there is nothing to confuse.
      if (tabs.length === 1 && tabs[0]) return this.rememberTab(settings, tabs[0]);
      if (tabs.length === 0) throw new DispatchError('The Arena tab AgentLink was using is closed and no other Arena tab is open. Open Arena Agent Mode in a tab; AgentLink continues by itself.');
      throw new DispatchError('The Arena tab AgentLink was using is no longer open, and several others are. Choose which one to use in Settings → Arena (or close the others).');
    }
    if (tabs.length === 0) throw new DispatchError('No Arena tab is open. Open Arena Agent Mode in a tab; AgentLink sends the task as soon as it is there.');
    if (tabs.length > 1) throw new DispatchError(`${tabs.length} Arena tabs are open. Choose which one AgentLink should use in Settings → Arena (or close the others).`);
    return tabs[0] as BrowserTab;
  }

  /** Keeps the remembered tab current, so it is found again after a browser restart or a changed address. */
  private async rememberTab(settings: ExtensionSettings, tab: BrowserTab): Promise<BrowserTab> {
    const known = settings.preferredTab;
    if (!known || known.tabId !== tab.id || known.url !== tab.url) {
      await this.deps.saveSettings({ preferredTab: { tabId: tab.id, url: tab.url, title: tab.title } }).catch(() => undefined);
    }
    return tab;
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

  // ------------------------------------------------------------- the loop ---

  /**
   * One pass over everything outstanding. Safe to call as often as wanted:
   * passes never overlap, and each one starts from what the companion and
   * the page say now, not from what an earlier pass assumed.
   */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.pass().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async pass(): Promise<void> {
    let items: RelayWorkItem[];
    try {
      items = (await this.deps.client.relayWork()).items;
      this.linkState = 'online';
    } catch (error) {
      const code = error instanceof CompanionError ? error.code : 'error';
      this.linkState = code === 'offline' || code === 'unpaired' || code === 'unauthorized' ? code : 'error';
      // Nothing is forgotten: replies that were already read stay in memory and go out when the companion is back.
      return;
    }
    const live = new Set<string>();
    for (const item of items) {
      live.add(key(item.projectId, item.task.id));
      try {
        await this.step(item);
      } catch (error) {
        // One task failing a step must not stop the others. A refusal from the companion means the task moved
        // on meanwhile; the next pass starts from the new state either way.
        if (!(error instanceof CompanionError)) {
          await this.report(item, 'waiting_for_arena', error instanceof Error ? error.message : 'The relay hit an unexpected problem and is trying again.', false, 0);
        }
      }
    }
    for (const id of Array.from(this.trackings.keys())) {
      if (!live.has(id)) this.trackings.delete(id);
    }
  }

  private step(item: RelayWorkItem): Promise<void> {
    switch (item.task.status) {
      case 'queued':
        return this.deliver(item);
      case 'dispatching':
        return this.adopt(item);
      case 'awaiting_response':
        return this.watch(item);
      default:
        return Promise.resolve();
    }
  }

  private tracking(item: RelayWorkItem, dispatchId: string | null): Tracking {
    const id = key(item.projectId, item.task.id);
    let tracking = this.trackings.get(id);
    if (!tracking || (dispatchId !== null && tracking.dispatchId !== null && tracking.dispatchId !== dispatchId)) {
      const at = this.now();
      tracking = {
        dispatchId,
        tabId: tracking?.tabId ?? null,
        foundAt: null,
        lastSeenAt: at,
        lastDigest: '',
        lastChangeAt: at,
        sawBusy: false,
        missingSince: null,
        pending: null,
        failures: tracking?.failures ?? 0,
        nextAttemptAt: tracking?.nextAttemptAt ?? 0,
        lastReportKey: '',
        lastReportAt: 0,
        lastReportChars: -1,
      };
      this.trackings.set(id, tracking);
    }
    if (dispatchId !== null) tracking.dispatchId = dispatchId;
    return tracking;
  }

  /** Tells the companion (and through it the user) where the task is. Repeats of the same news are dropped. */
  private async report(item: RelayWorkItem, phase: RelayPhase, message: string, attention: boolean, chars: number): Promise<void> {
    const tracking = this.tracking(item, null);
    const at = this.now();
    const reportKey = `${phase}|${attention ? 1 : 0}|${message}`;
    if (reportKey === tracking.lastReportKey && (chars === tracking.lastReportChars || at - tracking.lastReportAt < this.timing.reportMs)) return;
    tracking.lastReportKey = reportKey;
    tracking.lastReportAt = at;
    tracking.lastReportChars = chars;
    try {
      await this.deps.client.reportRelay(item.projectId, item.task.id, { dispatchId: tracking.dispatchId, phase, message, attention, chars });
    } catch {
      // Status is best effort; force the next one through.
      tracking.lastReportKey = '';
    }
  }

  // -------------------------------------------------------------- delivery ---

  /** Types a queued task into Arena. */
  private async deliver(item: RelayWorkItem): Promise<void> {
    const { projectId, task } = item;
    const tracking = this.tracking(item, null);
    if (this.now() < tracking.nextAttemptAt) return;
    const settings = await this.deps.getSettings();

    // Everything that can be checked is checked before the task is claimed, so a failed check costs no attempt.
    let tab: BrowserTab;
    let page: ArenaPageStatus;
    try {
      tab = await this.resolveTarget(settings);
      page = await this.ping(tab.id, settings.adapter);
    } catch (error) {
      await this.report(item, 'waiting_for_arena', error instanceof Error ? error.message : 'No Arena tab could be used.', true, 0);
      return;
    }
    if (!page.composerFound) {
      await this.report(item, 'waiting_for_arena', "Arena's message box was not found in the selected tab. Open an Arena Agent Mode conversation there; AgentLink sends the task as soon as it can.", true, 0);
      return;
    }
    if (page.agentMode === false) {
      await this.report(item, 'waiting_for_arena', 'The selected Arena tab is not in Agent Mode. Switch it to Agent Mode; AgentLink sends the task as soon as it is.', true, 0);
      return;
    }
    if (page.busy) {
      await this.report(item, 'waiting_for_arena', 'Arena is still working on a previous request. The task is sent as soon as Arena is free.', false, 0);
      return;
    }
    if (page.composerDraft && !page.composerDraft.includes(`Task ${task.id}:`)) {
      await this.report(item, 'waiting_for_arena', "Arena's message box contains a draft. Send or clear it; AgentLink does not overwrite it and sends the task as soon as the box is empty.", true, 0);
      return;
    }

    let claim: Awaited<ReturnType<DispatcherClient['claimDispatch']>>;
    try {
      claim = await this.deps.client.claimDispatch(projectId, task.id, { tabId: tab.id, tabUrl: tab.url });
    } catch (error) {
      if (error instanceof CompanionError && error.code === 'offline') throw error;
      // The companion refused: the task was cancelled, the session stopped, or it explains the block itself.
      return;
    }
    tracking.dispatchId = claim.dispatchId;
    tracking.tabId = tab.id;
    const ref = claim.task.dispatch?.ref ?? '';
    await this.report(item, 'sending', 'Typing the task into Arena…', false, 0);

    let result: SubmitPromptResult;
    try {
      const answer = (await this.deps.tabs.send(tab.id, { type: 'agentlink:arena:submit', prompt: claim.prompt, ref, config: settings.adapter })) as SubmitPromptResult | undefined;
      result = answer && typeof answer.ok === 'boolean' ? answer : { ok: false, submitted: 'unknown', error: 'The Arena tab gave no answer while the task was being sent.' };
    } catch {
      result = { ok: false, submitted: 'unknown', error: 'The Arena tab was closed or reloaded while the task was being sent.' };
    }

    if (result.ok) {
      // If this confirmation is lost, the task stays "being sent" at the companion and is taken over by `adopt`,
      // which finds it in the page and confirms it then.
      await this.deps.client.confirmDispatch(projectId, task.id, claim.dispatchId);
      // From now on this is the tab the project works in, even if other Arena tabs are opened later.
      await this.rememberTab(settings, tab);
      tracking.failures = 0;
      tracking.nextAttemptAt = 0;
      tracking.foundAt = this.now();
      tracking.lastChangeAt = this.now();
      tracking.lastSeenAt = this.now();
      await this.report(item, 'submitted', 'Arena accepted the task. Waiting for it to start…', false, 0);
      return;
    }

    await this.deps.client.failDispatch(projectId, task.id, { dispatchId: claim.dispatchId, error: result.error, submitted: result.submitted });
    if (result.submitted === false) {
      const waits = this.timing.retryBackoffMs;
      const wait = waits[Math.min(tracking.failures, waits.length - 1)] ?? 0;
      tracking.failures += 1;
      tracking.nextAttemptAt = this.now() + wait;
      await this.report(item, 'waiting_for_arena', `${result.error} Trying again shortly.`, tracking.failures >= 2, 0);
    } else {
      await this.report(item, 'verifying', `${result.error} Checking whether Arena received the task before anything is sent again.`, false, 0);
    }
  }

  /**
   * A task is marked "being sent", but this relay is not sending it: whoever
   * was (an earlier run of the browser or the extension) is gone. Its
   * delivery is treated as in doubt, which makes `watch` look for it in the
   * page before anything is typed again.
   */
  private async adopt(item: RelayWorkItem): Promise<void> {
    const dispatch = item.task.dispatch;
    if (!dispatch) return;
    const age = this.now() - Date.parse(dispatch.claimedAt);
    if (Number.isFinite(age) && age < this.timing.staleClaimMs) return;
    await this.deps.client.failDispatch(item.projectId, item.task.id, {
      dispatchId: dispatch.dispatchId,
      error: 'The browser or the extension restarted while this task was being sent. Checking the Arena tab for it.',
      submitted: 'unknown',
    });
  }

  // --------------------------------------------------------------- watching ---

  private async probeTab(tabId: number, task: ArenaTask, config: ArenaAdapterConfig): Promise<ProbeResult | null> {
    const dispatch = task.dispatch;
    if (!dispatch) return null;
    const request: ContentRequest = { type: 'agentlink:arena:probe', prompt: dispatch.prompt, ref: dispatch.ref ?? '', config };
    const ask = async (): Promise<ProbeResult | null> => {
      const answer = (await this.deps.tabs.send(tabId, request)) as ProbeResult | undefined;
      return answer && answer.ok === true ? answer : null;
    };
    try {
      const first = await ask();
      if (first) return first;
    } catch {
      // No adapter in the tab (it was reloaded, or opened before the extension): load it and ask again.
    }
    try {
      await this.deps.tabs.inject(tabId);
      return await ask();
    } catch {
      return null;
    }
  }

  /**
   * Finds the Arena tab that shows this task. The tab it was sent to is asked
   * first, then the preferred tab, then every other Arena tab: tab ids change
   * when the browser restarts and Arena changes a conversation's address
   * after the first message, so neither can be relied on alone.
   */
  private async locate(item: RelayWorkItem, tracking: Tracking, settings: ExtensionSettings): Promise<{ tabs: number; reachable: number; tabId: number | null; probe: ProbeResult | null; unsentIn: number | null }> {
    const tabs = await this.deps.tabs.queryArenaTabs();
    const dispatch = item.task.dispatch;
    const rank = (tab: BrowserTab): number => {
      if (tab.id === tracking.tabId) return 0;
      if (tab.id === dispatch?.tabId) return 1;
      if (dispatch?.tabUrl && tab.url === dispatch.tabUrl) return 2;
      if (tab.id === settings.preferredTab?.tabId) return 3;
      return 4;
    };
    const ordered = [...tabs].sort((a, b) => rank(a) - rank(b));
    let reachable = 0;
    let unsentIn: number | null = null;
    for (const tab of ordered) {
      const probe = await this.probeTab(tab.id, item.task, settings.adapter);
      if (!probe) continue;
      reachable += 1;
      if (probe.found) return { tabs: tabs.length, reachable, tabId: tab.id, probe, unsentIn };
      if (probe.composerHoldsPrompt) unsentIn = tab.id;
    }
    return { tabs: tabs.length, reachable, tabId: null, probe: null, unsentIn };
  }

  /** Follows a sent task until its reply is complete, then brings the reply back. */
  private async watch(item: RelayWorkItem): Promise<void> {
    const { projectId, task } = item;
    const dispatch = task.dispatch;
    if (!dispatch) return;
    const tracking = this.tracking(item, dispatch.dispatchId);
    if (tracking.pending) {
      await this.handOver(item, tracking);
      return;
    }
    const settings = await this.deps.getSettings();
    const config = settings.adapter;
    const now = this.now();
    const located = await this.locate(item, tracking, settings);

    if (!located.probe || located.tabId === null) {
      tracking.tabId = null;
      tracking.missingSince ??= now;
      const missingFor = now - tracking.missingSince;
      if (dispatch.unconfirmed && located.reachable > 0) {
        // The page was looked at and the task is not in it. Once that is certain, it is safe to send it again.
        if (located.unsentIn !== null || missingFor >= this.timing.verifyMs) {
          const reason =
            located.unsentIn !== null
              ? "The task is still sitting in Arena's message box and is not in the conversation, so it was not sent."
              : `The task did not appear in any open Arena tab within ${Math.round(this.timing.verifyMs / 1000)} seconds, so it was not sent.`;
          await this.deps.client.resetDispatch(projectId, task.id, { dispatchId: dispatch.dispatchId, reason });
          this.trackings.delete(key(projectId, task.id));
          return;
        }
        await this.report(item, 'verifying', 'Checking whether Arena received the task before anything is sent again…', false, 0);
        return;
      }
      const where =
        located.tabs === 0
          ? `No Arena tab is open. Reopen the Arena conversation that ${task.id} was sent to; AgentLink picks up the reply by itself.`
          : located.reachable === 0
            ? 'AgentLink cannot reach the open Arena tab. Reload it; AgentLink picks up the reply by itself.'
            : `${task.id} was sent, but its conversation is not open in any Arena tab. Open that conversation; AgentLink picks up the reply by itself.`;
      await this.report(item, 'searching', where, missingFor >= this.timing.missingAttentionMs, 0);
      return;
    }

    const probe = located.probe;
    if (settings.preferredTab?.tabId === tracking.tabId && tracking.tabId !== located.tabId) {
      // The conversation is open in a different tab now (the browser restarted); follow it there.
      const moved = (await this.deps.tabs.queryArenaTabs()).find((t) => t.id === located.tabId);
      if (moved) await this.rememberTab(settings, moved);
    }
    tracking.tabId = located.tabId;
    tracking.missingSince = null;
    if (dispatch.unconfirmed) {
      // Found in the page: the delivery is no longer in doubt.
      await this.deps.client.confirmDispatch(projectId, task.id, dispatch.dispatchId);
    }

    // Time that passed while nobody looked (a sleeping computer) proves nothing about the reply being finished.
    const unobserved = now - tracking.lastSeenAt > this.timing.observationGapMs;
    if (tracking.foundAt === null || unobserved || probe.digest !== tracking.lastDigest) {
      tracking.foundAt ??= now;
      tracking.lastDigest = probe.digest;
      tracking.lastChangeAt = now;
    }
    tracking.lastSeenAt = now;
    if (probe.busy) tracking.sawBusy = true;
    const quiet = now - tracking.lastChangeAt;

    let completion: ArenaCompletion | null = null;
    if (probe.chars > 0) {
      if (probe.marker && quiet >= (probe.busy ? config.settleMs : this.timing.markerSettleMs)) completion = 'marker';
      // Without the completion line, and on a page that never showed a "working" signal, silence is weaker
      // evidence that Arena has finished, so a longer quiet period is required.
      else if (!probe.busy && quiet >= (tracking.sawBusy ? config.settleMs : config.settleMs * 3)) completion = 'quiet';
      else if (quiet >= config.maxWaitMs) completion = 'stalled';
    }

    if (completion) {
      const captured = await this.captureFrom(located.tabId, task, config);
      if (!captured || !captured.ok || !captured.text) {
        tracking.lastChangeAt = now;
        return;
      }
      // The text handed over must be the text that was judged finished, not something still moving.
      if (digestOf(captured.text) !== probe.digest) {
        tracking.lastDigest = '';
        tracking.lastChangeAt = now;
        return;
      }
      tracking.pending = { text: captured.text, completion };
      await this.handOver(item, tracking);
      return;
    }

    if (probe.chars === 0) {
      const waited = now - Math.max(tracking.foundAt ?? now, tracking.lastChangeAt);
      const limit = probe.busy ? config.maxWaitMs : Math.min(this.timing.noReplyMs, config.maxWaitMs);
      if (waited >= limit) {
        const reason = probe.busy
          ? `Arena showed that it was working for ${minutes(waited)} without writing anything.`
          : `Arena received the task but had written nothing after ${minutes(waited)} and was not working on it.`;
        await this.deps.client.recordNoResponse(projectId, task.id, { dispatchId: dispatch.dispatchId, reason });
        this.trackings.delete(key(projectId, task.id));
        return;
      }
      await this.report(item, probe.busy ? 'generating' : 'submitted', probe.busy ? 'Arena is working…' : 'Arena has the task. Waiting for it to start…', false, 0);
      return;
    }

    if (probe.busy && quiet >= Math.min(5 * 60_000, config.maxWaitMs / 2)) {
      await this.report(
        item,
        'stalled',
        `Arena still shows that it is working, but nothing has changed for ${minutes(quiet)}. If that continues until ${minutes(config.maxWaitMs)} have passed, AgentLink hands over what Arena has written so far, marked as possibly incomplete.`,
        false,
        probe.chars,
      );
      return;
    }
    await this.report(
      item,
      probe.busy || quiet < this.timing.markerSettleMs ? 'generating' : 'settling',
      probe.busy ? 'Arena is working…' : 'Arena has stopped writing. Making sure the reply is complete…',
      false,
      probe.chars,
    );
  }

  private async captureFrom(tabId: number, task: ArenaTask, config: ArenaAdapterConfig): Promise<CaptureResult | null> {
    const dispatch = task.dispatch;
    if (!dispatch) return null;
    try {
      const answer = (await this.deps.tabs.send(tabId, { type: 'agentlink:arena:capture', prompt: dispatch.prompt, ref: dispatch.ref ?? '', config })) as CaptureResult | undefined;
      return answer && typeof answer.ok === 'boolean' ? answer : null;
    } catch {
      return null;
    }
  }

  /**
   * Gives a reply that was read in full to the companion. It stays in memory
   * until the companion has accepted it or has said that it no longer wants
   * it; an unreachable companion only delays it.
   */
  private async handOver(item: RelayWorkItem, tracking: Tracking): Promise<void> {
    const pending = tracking.pending;
    if (!pending || !tracking.dispatchId) return;
    await this.report(item, 'delivering', "Arena's reply was read in full. Handing it to Gemini…", false, pending.text.length);
    try {
      await this.deps.client.recordArenaResponse(item.projectId, item.task.id, {
        dispatchId: tracking.dispatchId,
        text: pending.text,
        source: 'auto',
        completion: pending.completion,
      });
      tracking.pending = null;
    } catch (error) {
      if (error instanceof CompanionError && FINAL_REFUSALS.includes(error.code)) {
        // The companion already has a reply for this task, or the task was closed meanwhile.
        tracking.pending = null;
        return;
      }
      // Anything else (companion stopped, token changed, a server error) is temporary: the next pass tries again.
      await this.report(item, 'delivering', "Arena's reply was read in full, but the companion did not accept it yet. Trying again…", true, pending.text.length);
    }
  }

  // --------------------------------------------------------------- recovery ---

  /**
   * Recovery tool for a person, never part of the normal flow: hands over
   * what Arena has written for a task right now, without waiting for it to
   * settle. The reply is marked as supplied by hand.
   */
  async capture(projectId: string, taskId: string): Promise<{ chars: number }> {
    const settings = await this.deps.getSettings();
    const { task } = await this.deps.client.getTask(projectId, taskId);
    if (task.status !== 'awaiting_response' || !task.dispatch) throw new DispatchError(`Task ${taskId} is not waiting for a reply from Arena.`);
    const item: RelayWorkItem = { projectId, projectName: '', task };
    const located = await this.locate(item, this.tracking(item, task.dispatch.dispatchId), settings);
    if (located.tabId === null) throw new DispatchError(`${taskId} was not found in any open Arena tab. Open the conversation it was sent in.`);
    const captured = await this.captureFrom(located.tabId, task, settings.adapter);
    if (!captured) throw new DispatchError('AgentLink lost contact with the Arena tab. Reload it and try again.');
    if (!captured.ok) throw new DispatchError(captured.error);
    try {
      await this.deps.client.recordArenaResponse(projectId, taskId, { dispatchId: task.dispatch.dispatchId, text: captured.text, source: 'manual_capture', completion: captured.marker ? 'marker' : 'manual' });
    } catch (error) {
      throw new DispatchError(error instanceof Error ? error.message : 'The reply could not be handed to the companion.');
    }
    this.trackings.delete(key(projectId, taskId));
    return { chars: captured.text.length };
  }
}
