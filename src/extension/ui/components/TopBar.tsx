import type { VNode } from 'preact';
import { describeGemini } from '../../../shared/statusText.js';
import { store, type WorkspaceState } from '../store.js';
import { LINK_TEXT, sessionBadge } from '../view.js';
import { Button, ConfirmButton, Dot } from './common.js';

interface Props {
  state: WorkspaceState;
  onOpenSettings: (section?: 'companion' | 'gemini' | 'arena') => void;
  onNewProject: () => void;
}

function arenaSummary(state: WorkspaceState): { tone: 'ok' | 'warn' | 'bad' | 'off'; label: string; title: string } {
  if (state.arenaError) return { tone: 'bad', label: 'Unavailable', title: state.arenaError };
  const tabs = state.arenaTabs;
  if (!tabs) return { tone: 'off', label: 'Checking…', title: 'Looking for Arena tabs.' };
  if (tabs.length === 0) return { tone: 'off', label: 'No tab open', title: 'Open Arena Agent Mode in a tab.' };
  const target = tabs.find((t) => t.preferred) ?? (tabs.length === 1 ? tabs[0] : undefined);
  if (!target) return { tone: 'warn', label: `${tabs.length} tabs, none chosen`, title: 'Choose which Arena tab AgentLink should use.' };
  if (!target.page) return { tone: 'bad', label: 'Tab not responding', title: target.error ?? 'Reload the Arena tab.' };
  if (!target.page.composerFound) return { tone: 'warn', label: 'No message box', title: 'Open a conversation in the Arena tab.' };
  if (target.page.agentMode === false) return { tone: 'warn', label: 'Not in Agent Mode', title: 'Switch the Arena tab to Agent Mode.' };
  return { tone: 'ok', label: target.page.busy ? 'Busy' : 'Ready', title: target.title || target.url };
}

export function TopBar({ state, onOpenSettings, onNewProject }: Props): VNode {
  const { project, projects, gemini, link, busy } = state;
  const online = link === 'online';
  const geminiText = gemini ? describeGemini(gemini) : null;
  const arena = arenaSummary(state);
  const session = project ? sessionBadge(project.session) : null;
  const status = project?.session.status;

  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true" />
        <span class="brand__name">AgentLink</span>
      </div>

      {online && (
        <div class="project-switch">
          <label class="visually-hidden" for="project-select">
            Project
          </label>
          <select
            id="project-select"
            class="select project-switch__select"
            value={project?.id ?? ''}
            disabled={projects.length === 0}
            onChange={(event) => {
              const id = (event.currentTarget as HTMLSelectElement).value;
              if (id && id !== project?.id) void store.selectProject(id);
            }}
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button small variant="quiet" onClick={onNewProject}>
            New project
          </Button>
        </div>
      )}

      <div class="topbar__spacer" />

      <div class="indicators">
        {online && geminiText && gemini ? (
          <button type="button" class="indicator" onClick={() => onOpenSettings('gemini')} title={geminiText.detail}>
            <Dot tone={geminiText.tone} />
            <span class="indicator__name">Gemini</span>
            <span class="indicator__value">{geminiText.label}</span>
            <span class="indicator__extra mono">{gemini.model}</span>
          </button>
        ) : (
          <button type="button" class="indicator" onClick={() => onOpenSettings('companion')} title={state.linkMessage || LINK_TEXT[link]}>
            <Dot tone={link === 'loading' ? 'busy' : 'bad'} />
            <span class="indicator__name">Companion</span>
            <span class="indicator__value">{LINK_TEXT[link]}</span>
          </button>
        )}
        <button type="button" class="indicator" onClick={() => onOpenSettings('arena')} title={arena.title}>
          <Dot tone={arena.tone} />
          <span class="indicator__name">Arena</span>
          <span class="indicator__value">{arena.label}</span>
        </button>
      </div>

      {online && project && session && (
        <div class="session" role="group" aria-label="Session controls">
          <span class={`session__state session__state--${session.tone}`}>{session.label}</span>
          {status === 'running' && (
            <Button small busy={busy['session:pause']} onClick={() => void store.session('pause')}>
              Pause
            </Button>
          )}
          {status === 'paused' && (
            <Button small variant="primary" busy={busy['session:resume']} onClick={() => void store.session('resume')}>
              Resume
            </Button>
          )}
          {(status === 'running' || status === 'paused') && (
            <ConfirmButton small label="Stop" confirmLabel="Stop session?" busy={busy['session:stop']} onConfirm={() => void store.session('stop')} />
          )}
          {(status === 'stopped' || status === 'completed') && (
            <Button small variant="primary" busy={busy['session:start']} onClick={() => void store.session('start')}>
              New session
            </Button>
          )}
        </div>
      )}

      <Button small variant="quiet" onClick={() => onOpenSettings()} aria-label="Open settings">
        Settings
      </Button>
    </header>
  );
}
