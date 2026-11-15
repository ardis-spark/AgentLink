import type { ArenaTask } from './types.js';

export interface ArenaPromptInput {
  task: Pick<ArenaTask, 'id' | 'title' | 'instructions' | 'context' | 'acceptanceCriteria'>;
  projectName: string;
  constraints: string[];
  /**
   * Reference code of this delivery attempt. When present, the prompt carries
   * it near the top (so the sent message can be found in the Arena page) and
   * asks Arena to close its report with a completion line built from it.
   */
  ref?: string;
}

const COMPLETION_WORD = 'AGENTLINK-DONE';

/** Reference code for one delivery attempt, e.g. "AL-T-3-9f2c41ab". */
export function arenaRef(taskId: string, dispatchId: string): string {
  const tail = dispatchId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
  return `AL-${taskId}-${tail}`;
}

/** The reference line as it appears in the prompt. */
export function referenceLine(ref: string): string {
  return `Reference: ${ref}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when a reply ends its report with the completion line Arena was asked
 * for. The prompt itself never contains the full line (it names the word and
 * the reference separately), so prompt text can not be mistaken for it. Any
 * delivery attempt of the same task counts: a task that was typed twice is
 * still the same task.
 */
export function hasCompletionMarker(text: string, ref: string): boolean {
  const cut = ref.lastIndexOf('-');
  if (!ref || cut <= 0) return false;
  const task = escapeRegExp(ref.slice(0, cut));
  return new RegExp(`${COMPLETION_WORD}[\\s:*_\`~-]{0,6}${task}-[a-z0-9]{4,12}`, 'i').test(text);
}

/**
 * Renders the exact text that is typed into Arena for a task. The workspace
 * shows this same rendering, so what is displayed is what is sent.
 */
export function renderArenaPrompt({ task, projectName, constraints, ref }: ArenaPromptInput): string {
  const lines: string[] = [];
  lines.push(`# Task ${task.id}: ${task.title.trim()}`);
  lines.push('');
  if (ref) lines.push(referenceLine(ref));
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
    'This task was sent by an automated coordinator and nobody is watching this conversation, so work through it ' +
      'without waiting for confirmation. When you finish, reply with a final report that states: what you changed and in which files, ' +
      'the commands you ran with their actual results, the status of each acceptance criterion, ' +
      'and anything you could not complete or verify. Do not describe work you did not do. ' +
      'If you cannot continue without a decision or information, say exactly what you need in the report instead of waiting.',
  );
  if (ref) {
    lines.push('');
    lines.push(
      `End the report with one final line made of the word ${COMPLETION_WORD}, a space, and the reference code given at the top of this task. ` +
        'Write that line only once, as the very last thing, when you have completely finished.',
    );
  }
  return lines.join('\n').trim();
}
