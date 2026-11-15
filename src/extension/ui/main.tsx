import { render, type VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Conversation } from './components/Conversation.js';
import { Button } from './components/common.js';
import { PlanPanel, TimelinePanel } from './components/PlanPanel.js';
import { ProjectForm } from './components/ProjectForm.js';
import { RelayRail } from './components/RelayRail.js';
import { PairingForm, SettingsDrawer, type SettingsSection } from './components/Settings.js';
import { TaskPanel } from './components/TaskPanel.js';
import { TopBar } from './components/TopBar.js';
import { store, useWorkspace, type WorkspaceState } from './store.js';
import { LINK_TEXT } from './view.js';

type View = 'chat' | 'task' | 'plan' | 'activity';

const WIDE_QUERY = '(min-width: 1080px)';

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const onChange = (): void => setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}

function Setup({ state }: { state: WorkspaceState }): VNode {
  const { link } = state;
  if (link === 'loading') {
    return (
      <main class="setup">
        <p class="setup__wait" role="status">
          <span class="dot dot--busy" aria-hidden="true" />
          {LINK_TEXT.loading}
        </p>
      </main>
    );
  }
  const heading = link === 'unpaired' ? 'Connect AgentLink to its companion' : LINK_TEXT[link];
  return (
    <main class="setup">
      <div class="setup__card">
        <h1 class="setup__title">{heading}</h1>
        {link !== 'unpaired' && state.linkMessage && (
          <p class="note note--bad" role="alert">
            {state.linkMessage}
          </p>
        )}
        <p class="setup__lead">
          The companion is a small program on this computer. It talks to Gemini, keeps your API key out of the browser, and stores your projects.
        </p>
        <ol class="steps">
          <li>
            <span class="steps__n mono">1</span>
            <div>
              <p>Start it in the AgentLink folder:</p>
              <pre class="code">npm start</pre>
            </div>
          </li>
          <li>
            <span class="steps__n mono">2</span>
            <div>
              <p>It prints a settings link ending in <span class="mono">#token=…</span>. Paste that link, or the address and token separately, below.</p>
            </div>
          </li>
        </ol>
        <PairingForm state={state} />
      </div>
    </main>
  );
}

function App(): VNode {
  const state = useWorkspace();
  const wide = useWide();
  const [view, setView] = useState<View>('chat');
  const [side, setSide] = useState<'plan' | 'activity'>('plan');
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection | null }>({ open: false, section: null });
  const [projectForm, setProjectForm] = useState<'new' | 'edit' | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);

  const { project, link, gemini } = state;
  const online = link === 'online';

  useEffect(() => {
    setSelectedTask(null);
    setProjectForm(null);
  }, [project?.id]);
  // A newly opened task takes over the task panel.
  useEffect(() => {
    if (project?.currentTaskId) setSelectedTask(null);
  }, [project?.currentTaskId]);

  const openSettings = (section?: SettingsSection): void => setSettings({ open: true, section: section ?? null });
  const showTask = (taskId: string): void => {
    setSelectedTask(taskId);
    setView('task');
  };

  const openTask = project?.tasks.find((t) => t.id === project.currentTaskId);
  const needsYou = openTask?.status === 'proposed' || (openTask?.status === 'awaiting_response' && openTask.dispatch?.unconfirmed === true) || (openTask?.status === 'evaluating' && Boolean(openTask.evaluationError));
  const tabs: { id: View; label: string }[] = [
    { id: 'chat', label: 'Coordinator' },
    { id: 'task', label: 'Task' },
    { id: 'plan', label: 'Memory' },
    { id: 'activity', label: 'Activity' },
  ];

  let body: VNode;
  if (!online) {
    body = <Setup state={state} />;
  } else if (!state.projectsLoaded) {
    body = (
      <main class="setup">
        <p class="setup__wait" role="status">
          <span class="dot dot--busy" aria-hidden="true" />
          Loading projects…
        </p>
      </main>
    );
  } else if (projectForm || state.projects.length === 0) {
    const editing = projectForm === 'edit' ? project : null;
    body = (
      <main class="setup">
        <div class="setup__card">
          <h1 class="setup__title">{editing ? 'Project brief' : state.projects.length === 0 ? 'Start your first project' : 'New project'}</h1>
          {!editing && <p class="setup__lead">Give Gemini the goal. It plans the work, proposes one task at a time for Arena, and checks every reply before moving on.</p>}
          <ProjectForm project={editing} key={editing?.id ?? 'new'} onDone={() => setProjectForm(null)} onCancel={state.projects.length > 0 ? () => setProjectForm(null) : undefined} />
        </div>
      </main>
    );
  } else if (!project) {
    body = (
      <main class="setup">
        <p class="setup__wait" role="status">
          <span class="dot dot--busy" aria-hidden="true" />
          Opening project…
        </p>
      </main>
    );
  } else {
    // Keyed by project so a draft or scroll position never carries over to another project.
    const chat = <Conversation state={state} onShowTask={showTask} key={project.id} />;
    const task = <TaskPanel state={state} selectedTaskId={selectedTask} onSelect={setSelectedTask} />;
    const plan = <PlanPanel project={project} onEdit={() => setProjectForm('edit')} />;
    const activity = <TimelinePanel project={project} onShowTask={showTask} />;
    body = (
      <main class="workspace">
        <RelayRail state={state} onEditProject={() => setProjectForm('edit')} />
        {wide ? (
          <div class="columns">
            {chat}
            {task}
            <div class="column">
              <div class="switch" role="tablist" aria-label="Project record">
                <button type="button" role="tab" class="switch__tab" aria-selected={side === 'plan'} onClick={() => setSide('plan')}>
                  Memory
                </button>
                <button type="button" role="tab" class="switch__tab" aria-selected={side === 'activity'} onClick={() => setSide('activity')}>
                  Activity
                </button>
              </div>
              {side === 'plan' ? plan : activity}
            </div>
          </div>
        ) : (
          <div class="stack">
            <div class="switch" role="tablist" aria-label="Workspace view">
              {tabs.map((tab) => (
                <button type="button" role="tab" class="switch__tab" aria-selected={view === tab.id} key={tab.id} onClick={() => setView(tab.id)}>
                  {tab.label}
                  {tab.id === 'task' && needsYou && view !== 'task' && (
                    <>
                      <span class="switch__flag" aria-hidden="true" />
                      <span class="visually-hidden"> (needs you)</span>
                    </>
                  )}
                </button>
              ))}
            </div>
            {view === 'chat' ? chat : view === 'task' ? task : view === 'plan' ? plan : activity}
          </div>
        )}
      </main>
    );
  }

  return (
    <div class={`app${document.documentElement.dataset.surface === 'sidebar' ? ' app--sidebar' : ''}`}>
      <TopBar state={state} onOpenSettings={openSettings} onNewProject={() => setProjectForm('new')} />
      {online && gemini && !gemini.keyConfigured && (
        <div class="callout" role="status">
          <p>Gemini has no API key yet. The coordinator cannot answer until you add one.</p>
          <Button variant="primary" small onClick={store.openKeySettings}>
            Add API key
          </Button>
        </div>
      )}
      {body}
      {settings.open && <SettingsDrawer state={state} section={settings.section} onClose={() => setSettings({ open: false, section: null })} />}
      {state.notice && (
        <div class={`toast toast--${state.notice.tone}`} role={state.notice.tone === 'ok' ? 'status' : 'alert'} key={state.notice.id}>
          <p class="toast__text">{state.notice.text}</p>
          <button type="button" class="toast__close" onClick={store.dismissNotice} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

const surface = new URLSearchParams(location.search).get('surface');
if (surface === 'sidebar') document.documentElement.dataset.surface = 'sidebar';

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
  void store.start();
}
