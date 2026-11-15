import type { VNode } from 'preact';
import type { WorkspaceState } from '../store.js';
import { milestoneProgress, relayStages } from '../view.js';

/**
 * The relay: one task's path from Gemini's plan, through your approval, to
 * Arena and back to Gemini for review. Every lit stage reflects recorded state.
 */
export function RelayRail({ state, onEditProject }: { state: WorkspaceState; onEditProject: () => void }): VNode | null {
  const { project, turn } = state;
  if (!project) return null;
  const open = project.currentTaskId ? (state.executions[project.currentTaskId] ?? null) : null;
  const { stages, caption } = relayStages(project, turn, open);
  const progress = milestoneProgress(project);
  const current = project.milestones.find((m) => m.id === project.currentMilestoneId);

  return (
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
          ) : (
            'No plan yet. Describe your goal to the coordinator.'
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
  );
}
