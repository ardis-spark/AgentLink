import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import type { ProjectView } from '../../../shared/types.js';
import { store } from '../store.js';
import { AutoTextarea, Button, ConfirmButton } from './common.js';

function toLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

/** Create a project, or change the brief of an existing one (including its objective). */
export function ProjectForm({ project, onDone, onCancel }: { project: ProjectView | null; onDone: () => void; onCancel?: () => void }): VNode {
  const [name, setName] = useState(project?.name ?? '');
  const [objective, setObjective] = useState(project?.objective ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [constraints, setConstraints] = useState((project?.constraints ?? []).join('\n'));
  const busy = store.state.busy[project ? 'project:update' : 'project:create'];
  const valid = name.trim().length > 0 && objective.trim().length > 0;

  const submit = async (): Promise<void> => {
    if (!valid) return;
    const body = { name: name.trim(), objective: objective.trim(), instructions: instructions.trim(), constraints: toLines(constraints) };
    // A new project starts working at once: giving the objective is the only step.
    const ok = project ? await store.updateProject(body) : await store.createProject({ ...body, start: true });
    if (ok) onDone();
  };

  return (
    <form
      class="form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div class="field">
        <label class="label" for="project-name">
          Project name
        </label>
        <input id="project-name" class="input" value={name} maxLength={120} placeholder="For example: Billing service" onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <label class="label" for="project-objective">
          Objective
        </label>
        <AutoTextarea id="project-objective" class="textarea" maxRows={8} value={objective} placeholder="What should be true when this project is done?" onInput={(e) => setObjective((e.currentTarget as HTMLTextAreaElement).value)} />
        <p class="field__hint">{project ? 'A changed objective is passed to Gemini with its next step.' : 'This is all AgentLink needs. It starts as soon as you press Start and keeps going by itself.'}</p>
      </div>
      <div class="field">
        <label class="label" for="project-instructions">
          Standing instructions <span class="faint">· optional</span>
        </label>
        <AutoTextarea id="project-instructions" class="textarea" maxRows={8} value={instructions} placeholder="How Gemini should run this project: priorities, style, things to avoid" onInput={(e) => setInstructions((e.currentTarget as HTMLTextAreaElement).value)} />
      </div>
      <div class="field">
        <label class="label" for="project-constraints">
          Constraints <span class="faint">· optional, one per line</span>
        </label>
        <AutoTextarea id="project-constraints" class="textarea" maxRows={8} value={constraints} placeholder="Rules Arena must follow in every task" onInput={(e) => setConstraints((e.currentTarget as HTMLTextAreaElement).value)} />
        <p class="field__hint">These are added to every task sent to Arena.</p>
      </div>
      <div class="button-row button-row--spread">
        <div class="button-row">
          <Button variant="primary" type="submit" busy={busy} disabled={!valid}>
            {project ? 'Save project' : 'Start'}
          </Button>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        </div>
        {project && (
          <ConfirmButton
            label="Delete project"
            confirmLabel="Delete it and its history?"
            busy={store.state.busy['project:delete']}
            onConfirm={() => {
              void store.deleteProject().then(onDone);
            }}
          />
        )}
      </div>
    </form>
  );
}
