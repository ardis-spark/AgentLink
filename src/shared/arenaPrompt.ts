import type { ArenaTask } from './types.js';

export interface ArenaPromptInput {
  task: Pick<ArenaTask, 'id' | 'title' | 'instructions' | 'context' | 'acceptanceCriteria'>;
  projectName: string;
  constraints: string[];
}

/**
 * Renders the exact text that is typed into Arena for a task. The UI shows
 * this same rendering before approval, so what the user approves is what is
 * sent.
 */
export function renderArenaPrompt({ task, projectName, constraints }: ArenaPromptInput): string {
  const lines: string[] = [];
  lines.push(`# Task ${task.id}: ${task.title.trim()}`);
  lines.push('');
  lines.push(`Project: ${projectName.trim()}`);
  lines.push('');
  if (task.context.trim()) {
    lines.push('## Context');
    lines.push(task.context.trim());
    lines.push('');
  }
  lines.push('## What to do');
  lines.push(task.instructions.trim());
  lines.push('');
  if (task.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria');
    for (const c of task.acceptanceCriteria) lines.push(`- ${c.trim()}`);
    lines.push('');
  }
  if (constraints.length > 0) {
    lines.push('## Constraints');
    for (const c of constraints) lines.push(`- ${c.trim()}`);
    lines.push('');
  }
  lines.push('## Report back');
  lines.push(
    'When you finish, reply with a final report that states: what you changed and in which files, ' +
      'the commands you ran with their actual results, the status of each acceptance criterion, ' +
      'and anything you could not complete or verify. Do not describe work you did not do.',
  );
  return lines.join('\n').trim();
}
