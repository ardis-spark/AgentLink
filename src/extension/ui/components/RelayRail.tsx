import type { VNode } from 'preact';
import { store, type WorkspaceState } from '../store.js';
import { attentionOf, milestoneProgress, relayStages } from '../view.js';
import { Button } from './common.js';

/**
 * The loop at a glance: Gemini plans, AgentLink sends, Arena executes,
 * Gemini reviews, and round again without anyone pressing anything. Every lit
 * stage reflects recorded state. When the loop cannot move by itself, the one
 * thing it needs is shown here with the way to supply it.
 */
export function RelayRail({ state, onEditProject, onOpenSettings }: { state: WorkspaceState; onEditProject: () => void; onOpenSettings: (section: 'gemini' | 'arena') => void }): VNode | null {
  const { project, turn, busy } = state;
  if (!project) return null;
  const { stages, caption } = relayStages(project, turn);
  const progress = milestoneProgress(project);
  const current = project.milestones.find((m) => m.id === project.currentMilestoneId);
  const attention = attentionOf(project, state.relay);
  const settings = attention?.settings ?? null;

  return (
    <>
      <section class="relay" aria-label="Project and task progress">
        <div class="relay__brief">
          <div class="relay__objective-row">
            <span class="label">Objective</span>
            <button type="button" class="link-button" onClick={onEditProject}>
              Change
            </button>
          </div>
          <p class="relay__objective" title={project.objective}>
            {project.objective}
          </p>
          <p class="relay__milestone">
            {progress.total > 0 ? (
              <>
                <span class="mono">
                  {progress.done}/{progress.total}
                </span>{' '}
                milestones{current ? ` · now: ${current.title}` : ''}
              </>
            ) : project.session.status === 'idle' ? (
              'Not started yet.'
            ) : (
              'Gemini is drawing up the plan.'
            )}
          </p>
        </div>

        <div class="relay__track">
          <ol class="relay__stages">
            {stages.map((stage) => (
              <li class={`stage stage--${stage.state}`} key={stage.key} aria-current={stage.state === 'active' || stage.state === 'waiting' || stage.state === 'problem' ? 'step' : undefined}>
                <span class="stage__node" aria-hidden="true" />
                <span class="stage__label">{stage.label}</span>
                <span class="stage__owner">{stage.owner}</span>
              </li>
            ))}
          </ol>
          <p class="relay__caption" role="status" aria-live="polite">
            {caption}
          </p>
        </div>
      </section>

      {attention && (
        <section class={`attention attention--${attention.tone}`} role="alert">
          <div class="attention__text">
            <p class="attention__title">{attention.title}</p>
            {attention.detail && <p class="attention__detail">{attention.detail}</p>}
          </div>
          <div class="button-row">
            {attention.options.map((option) => (
              <Button small key={option} busy={busy.message} onClick={() => void store.send(option)}>
                {option}
              </Button>
            ))}
            {attention.canContinue && (
              <Button small variant="primary" busy={busy['session:resume']} onClick={() => void store.session('resume')}>
                Continue
              </Button>
            )}
            {settings && (
              <Button small variant="quiet" onClick={() => onOpenSettings(settings)}>
                {settings === 'gemini' ? 'Gemini settings' : 'Arena settings'}
              </Button>
            )}
            {settings === 'arena' && (
              <Button small variant="quiet" onClick={() => void store.focusArena()}>
                Go to Arena tab
              </Button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
