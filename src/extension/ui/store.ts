import { useEffect, useState } from 'preact/hooks';
import type { CompanionEvent, CreateProjectRequest, SessionAction, UpdateProjectRequest } from '../../shared/api.js';
import type { ArenaAdapterConfig, ArenaConnectionTest, ArenaTabInfo } from '../../shared/messages.js';
import type { ArenaTask, CompanionSettings, ConversationEntry, GeminiModelInfo, GeminiStatus, ProjectSummary, ProjectView, RelayLink, TurnState } from '../../shared/types.js';
import { CompanionClient, CompanionError } from '../lib/companionClient.js';
import { DEFAULT_EXTENSION_SETTINGS, loadSettings, normalizeCompanionUrl, onSettingsChanged, saveSettings, type ExtensionSettings } from '../lib/settings.js';
import { askBackground } from './background.js';

/** How the workspace stands with the local companion. Each value is something that was actually observed. */
export type LinkState = 'loading' | 'offline' | 'foreign' | 'unpaired' | 'unauthorized' | 'online';

export interface Notice {
  id: number;
  tone: 'ok' | 'bad' | 'warn';
  text: string;
}

export interface WorkspaceState {
  ext: ExtensionSettings;
  link: LinkState;
  linkMessage: string;
  version: string | null;
  gemini: GeminiStatus | null;
  settings: CompanionSettings | null;
  models: GeminiModelInfo[] | null;
  modelsError: string | null;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  projectsLoaded: boolean;
  project: ProjectView | null;
  conversation: ConversationEntry[];
  turn: TurnState | null;
  /** Whether the background relay that carries tasks to Arena is in contact with the companion. */
  relay: RelayLink | null;
  arenaTabs: ArenaTabInfo[] | null;
  arenaError: string | null;
  arenaTest: ArenaConnectionTest | null;
  /** Full task records fetched on demand (the project view carries only an excerpt of long Arena replies). */
  fullTasks: Record<string, ArenaTask>;
  busy: Record<string, boolean>;
  notice: Notice | null;
}

const initialState: WorkspaceState = {
  ext: { ...DEFAULT_EXTENSION_SETTINGS },
  link: 'loading',
  linkMessage: '',
  version: null,
  gemini: null,
  settings: null,
  models: null,
  modelsError: null,
  projects: [],
  activeProjectId: null,
  projectsLoaded: false,
  project: null,
  conversation: [],
  turn: null,
  relay: null,
  arenaTabs: null,
  arenaError: null,
  arenaTest: null,
  fullTasks: {},
  busy: {},
  notice: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

class WorkspaceStore {
  state: WorkspaceState = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly client = new CompanionClient(() => ({ url: this.state.ext.companionUrl, token: this.state.ext.pairingToken }));
  private closeStream: (() => void) | null = null;
  private noticeSeq = 0;
  private noticeTimer: number | null = null;
  private started = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  notify(tone: Notice['tone'], text: string): void {
    this.noticeSeq += 1;
    this.set({ notice: { id: this.noticeSeq, tone, text } });
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.set({ notice: null }), tone === 'ok' ? 4_000 : 9_000);
  }

  dismissNotice = (): void => this.set({ notice: null });

  /** Runs a user action, tracks that it is in progress, and reports a failure in plain words. */
  private async run<T>(name: string, work: () => Promise<T>): Promise<T | undefined> {
    if (this.state.busy[name]) return undefined;
    this.set({ busy: { ...this.state.busy, [name]: true } });
    try {
      return await work();
    } catch (error) {
      if (error instanceof CompanionError && (error.code === 'offline' || error.code === 'unauthorized')) void this.connect();
      this.notify('bad', message(error));
      return undefined;
    } finally {
      const { [name]: _done, ...rest } = this.state.busy;
      this.set({ busy: rest });
    }
  }

  // ------------------------------------------------------------ connection ---

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.set({ ext: await loadSettings() });
    onSettingsChanged((ext) => {
      const changed = ext.companionUrl !== this.state.ext.companionUrl || ext.pairingToken !== this.state.ext.pairingToken;
      this.set({ ext });
      if (changed) void this.connect();
    });
    await this.connect();
    void this.refreshArena();
  }

  async connect(): Promise<void> {
    this.closeStream?.();
    this.closeStream = null;
    try {
      const health = await this.client.health();
      this.set({ version: health.version });
    } catch (error) {
      const code = error instanceof CompanionError ? error.code : 'offline';
      this.set({ link: code === 'not_agentlink' ? 'foreign' : 'offline', linkMessage: message(error), gemini: null });
      this.watchForCompanion();
      return;
    }
    if (!this.state.ext.pairingToken) {
      this.set({ link: 'unpaired', linkMessage: 'Paste the pairing token to connect.', gemini: null });
      return;
    }
    try {
      await this.loadEverything();
    } catch (error) {
      const unauthorized = error instanceof CompanionError && error.code === 'unauthorized';
      this.set({ link: unauthorized ? 'unauthorized' : 'offline', linkMessage: message(error), gemini: null });
      if (!unauthorized) this.watchForCompanion();
      return;
    }
    this.set({ link: 'online', linkMessage: '' });
    this.closeStream = this.client.openEvents({
      onEvent: (event) => this.onEvent(event),
      onState: (state, error) => {
        if (state === 'reconnecting' && error) {
          this.set({ link: error.code === 'unauthorized' ? 'unauthorized' : 'offline', linkMessage: error.message });
        }
      },
    });
  }

  /** While the companion is down, look for it quietly so the workspace comes back by itself. */
  private retryTimer: number | null = null;
  private watchForCompanion(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.state.link === 'offline' || this.state.link === 'foreign') void this.connect();
    }, 4_000);
  }

  private async loadEverything(): Promise<void> {
    const [status, list] = await Promise.all([this.client.status(), this.client.listProjects()]);
    this.set({
      version: status.version,
      gemini: status.gemini,
      settings: status.settings,
      relay: status.relay ?? null,
      projects: list.projects,
      activeProjectId: list.activeProjectId,
      projectsLoaded: true,
    });
    const wanted = this.state.project?.id ?? list.activeProjectId ?? list.projects[0]?.id ?? null;
    const target = wanted && list.projects.some((p) => p.id === wanted) ? wanted : (list.projects[0]?.id ?? null);
    if (target) await this.loadProject(target);
    else this.set({ project: null, conversation: [], turn: null });
    // The relay runs by itself in the background; this only spares the wait until its next look.
    void askBackground({ type: 'agentlink:ui:wake' }).catch(() => undefined);
  }

  private async loadProject(id: string): Promise<void> {
    const view = await this.client.getProject(id);
    const switched = this.state.project?.id !== id;
    this.set({
      project: view.project,
      conversation: view.conversation,
      turn: view.turn,
      fullTasks: switched ? {} : this.state.fullTasks,
    });
  }

  private onEvent(event: CompanionEvent): void {
    const current = this.state.project?.id ?? null;
    switch (event.type) {
      case 'hello':
        // A fresh stream: anything may have changed while it was down.
        if (this.state.link !== 'online') this.set({ link: 'online', linkMessage: '' });
        void this.loadEverything().catch(() => undefined);
        break;
      case 'gemini':
        this.set({ gemini: event.status });
        break;
      case 'settings':
        this.set({ settings: event.settings });
        break;
      case 'projects':
        this.set({ projects: event.projects, activeProjectId: event.activeProjectId, projectsLoaded: true });
        if (current && !event.projects.some((p) => p.id === current)) {
          const next = event.projects[0]?.id ?? null;
          if (next) void this.loadProject(next).catch(() => undefined);
          else this.set({ project: null, conversation: [], turn: null });
        }
        break;
      case 'project':
        if (event.projectId === current) this.set({ project: event.project });
        break;
      case 'relay':
        this.set({ relay: event.relay });
        break;
      case 'entry': {
        if (event.projectId !== current) break;
        const index = this.state.conversation.findIndex((e) => e.id === event.entry.id);
        const conversation = index >= 0 ? this.state.conversation.map((e, i) => (i === index ? event.entry : e)) : [...this.state.conversation, event.entry];
        this.set({ conversation });
        break;
      }
      case 'delta': {
        if (event.projectId !== current) break;
        this.set({ conversation: this.state.conversation.map((e) => (e.id === event.entryId ? { ...e, text: e.text + event.text } : e)) });
        break;
      }
      case 'turn':
        if (event.projectId === current) this.set({ turn: event.turn });
        break;
    }
  }

  // -------------------------------------------------------------- pairing ---

  /** Saves the companion address and pairing token, then connects. Returns an error message for the form, if any. */
  async pair(companionUrl: string, pairingToken: string): Promise<string | null> {
    let url: string;
    try {
      url = normalizeCompanionUrl(companionUrl);
    } catch (error) {
      return message(error);
    }
    this.set({ ext: await saveSettings({ companionUrl: url, pairingToken: pairingToken.trim() }) });
    await this.connect();
    return this.state.link === 'online' ? null : this.state.linkMessage;
  }

  async saveAdapter(adapter: ArenaAdapterConfig): Promise<void> {
    this.set({ ext: await saveSettings({ adapter }) });
    this.notify('ok', 'Arena adapter settings saved.');
    void this.refreshArena();
  }

  /** Opens the companion's own page, which is the only place the Gemini key is entered. */
  openKeySettings = (): void => {
    const { companionUrl, pairingToken } = this.state.ext;
    void browser.tabs.create({ url: `${companionUrl}/settings${pairingToken ? `#token=${encodeURIComponent(pairingToken)}` : ''}` });
  };

  // ---------------------------------------------------------------- gemini ---

  testGemini = (): Promise<void> =>
    this.run('gemini:test', async () => {
      const result = await this.client.testGemini();
      this.set({ gemini: result.gemini });
    }).then(() => undefined);

  loadModels = (refresh = false): Promise<void> =>
    this.run('gemini:models', async () => {
      try {
        const result = await this.client.models(refresh);
        this.set({ models: result.models, modelsError: null });
      } catch (error) {
        this.set({ models: null, modelsError: message(error) });
      }
    }).then(() => undefined);

  setModel = (model: string): Promise<void> =>
    this.run('gemini:model', async () => {
      const saved = await this.client.updateSettings({ model });
      this.set({ settings: saved.settings, gemini: saved.gemini });
      const tested = await this.client.testGemini();
      this.set({ gemini: tested.gemini });
      if (tested.gemini.state === 'connected') this.notify('ok', `Now using ${saved.settings.model}.`);
    }).then(() => undefined);

  // -------------------------------------------------------------- projects ---

  selectProject = (id: string): Promise<void> =>
    this.run('project:select', async () => {
      const view = await this.client.activateProject(id);
      this.set({ project: view.project, conversation: view.conversation, turn: view.turn, fullTasks: {}, activeProjectId: id });
    }).then(() => undefined);

  async createProject(input: CreateProjectRequest): Promise<boolean> {
    const created = await this.run('project:create', async () => {
      const view = await this.client.createProject(input);
      this.set({ project: view.project, conversation: view.conversation, turn: view.turn, fullTasks: {}, activeProjectId: view.project.id });
      void askBackground({ type: 'agentlink:ui:wake' }).catch(() => undefined);
      return true;
    });
    return created === true;
  }

  async updateProject(patch: UpdateProjectRequest): Promise<boolean> {
    const project = this.state.project;
    if (!project) return false;
    const saved = await this.run('project:update', async () => {
      const view = await this.client.updateProject(project.id, patch);
      this.set({ project: view.project, conversation: view.conversation });
      return true;
    });
    return saved === true;
  }

  deleteProject = (): Promise<void> =>
    this.run('project:delete', async () => {
      const project = this.state.project;
      if (!project) return;
      await this.client.deleteProject(project.id);
      this.set({ project: null, conversation: [], turn: null });
      await this.loadEverything();
    }).then(() => undefined);

  // ---------------------------------------------------------- conversation ---

  async send(text: string): Promise<boolean> {
    const project = this.state.project;
    if (!project) return false;
    const sent = await this.run('message', async () => {
      await this.client.sendMessage(project.id, text);
      return true;
    });
    return sent === true;
  }

  cancelTurn = (): Promise<void> =>
    this.run('turn:cancel', async () => {
      if (this.state.project) await this.client.cancelTurn(this.state.project.id);
    }).then(() => undefined);

  session = (action: SessionAction): Promise<void> =>
    this.run(`session:${action}`, async () => {
      const project = this.state.project;
      if (!project) return;
      const view = await this.client.controlSession(project.id, action);
      this.set({ project: view.project, conversation: view.conversation, turn: view.turn });
      void askBackground({ type: 'agentlink:ui:wake' }).catch(() => undefined);
    }).then(() => undefined);

  // ----------------------------------------------------------------- tasks ---

  private async taskAction(name: string, taskId: string, work: (projectId: string) => Promise<unknown>): Promise<boolean> {
    const project = this.state.project;
    if (!project) return false;
    const done = await this.run(`${name}:${taskId}`, async () => {
      await work(project.id);
      return true;
    });
    return done === true;
  }

  /** The user abandons the open task. The coordinator is told and chooses another next step. */
  cancelTask = (taskId: string): Promise<boolean> => this.taskAction('cancel', taskId, (projectId) => this.client.cancelTask(projectId, taskId));

  // Recovery tools. The relay collects Arena's replies by itself; these exist for the case where the Arena
  // page cannot be read at all, and are never needed in normal operation.

  /** Hands over what Arena has written for the task right now, without waiting for it to settle. */
  captureReply = (taskId: string): Promise<boolean> => this.taskAction('capture', taskId, (projectId) => askBackground({ type: 'agentlink:ui:captureResponse', projectId, taskId }));

  /** Supplies Arena's reply by hand. */
  pasteReply = (taskId: string, text: string): Promise<boolean> =>
    this.taskAction('paste', taskId, async (projectId) => {
      const task = this.state.project?.tasks.find((t) => t.id === taskId);
      await this.client.recordArenaResponse(projectId, taskId, { dispatchId: task?.dispatch?.dispatchId ?? null, text, source: 'pasted', completion: 'manual' });
    });

  loadFullTask = (taskId: string): Promise<void> =>
    this.run(`task:${taskId}`, async () => {
      const project = this.state.project;
      if (!project) return;
      const { task } = await this.client.getTask(project.id, taskId);
      this.set({ fullTasks: { ...this.state.fullTasks, [taskId]: task } });
    }).then(() => undefined);

  // ----------------------------------------------------------------- arena ---

  refreshArena = (): Promise<void> =>
    this.run('arena:tabs', async () => {
      try {
        const tabs = await askBackground<ArenaTabInfo[]>({ type: 'agentlink:ui:listArenaTabs' });
        this.set({ arenaTabs: tabs, arenaError: null });
      } catch (error) {
        this.set({ arenaTabs: null, arenaError: message(error) });
      }
    }).then(() => undefined);

  setPreferredTab = (tabId: number | null): Promise<void> =>
    this.run('arena:prefer', async () => {
      const tabs = await askBackground<ArenaTabInfo[]>({ type: 'agentlink:ui:setPreferredTab', tabId });
      this.set({ arenaTabs: tabs, arenaError: null, arenaTest: null, ext: await loadSettings() });
    }).then(() => undefined);

  testArena = (tabId?: number): Promise<void> =>
    this.run('arena:test', async () => {
      const result = await askBackground<ArenaConnectionTest>({ type: 'agentlink:ui:testArena', tabId });
      this.set({ arenaTest: result });
      void this.refreshArena();
    }).then(() => undefined);

  focusArena = (): Promise<void> => this.run('arena:focus', () => askBackground({ type: 'agentlink:ui:focusArenaTab' })).then(() => undefined);
}

export const store = new WorkspaceStore();

export function useWorkspace(): WorkspaceState {
  const [state, setState] = useState(store.state);
  useEffect(() => {
    // Catch up on anything that changed between the first render and this subscription.
    setState(store.state);
    return store.subscribe(() => setState(store.state));
  }, []);
  return state;
}
