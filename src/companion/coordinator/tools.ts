import { Type, type FunctionDeclaration } from '@google/genai';
import { cleanList, containsQuote, excerpt } from '../../shared/text.js';
import type {
  ArenaTask,
  CompanionSettings,
  EvaluationVerdict,
  IssueSeverity,
  Milestone,
  MilestoneStatus,
  Project,
  TaskStatus,
  ToolAction,
} from '../../shared/types.js';
import { addEvent, findTask, isOpenTask, nowIso, openTask, syncCurrentTask, taskFingerprint, touch } from '../memory/projectModel.js';

/** Tools Gemini uses to act as coordinator. Each one changes project memory under rules enforced in `executeTool`. */
export const COORDINATOR_TOOLS: FunctionDeclaration[] = [
  {
    name: 'set_plan',
    description:
      'Define or replace the milestone plan for the objective. Milestones that keep their exact title keep their status. Use when the objective becomes clear or the plan must change.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        milestones: {
          type: Type.ARRAY,
          description: 'Ordered milestones, first to last.',
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: 'Short milestone name.' },
              description: { type: Type.STRING, description: 'What is true when this milestone is done.' },
            },
            required: ['title'],
          },
        },
        current_milestone: {
          type: Type.INTEGER,
          description: 'Position (1 = first) of the milestone being worked on now. Defaults to the first unfinished one.',
        },
      },
      required: ['milestones'],
    },
  },
  {
    name: 'update_milestone',
    description: 'Change the status of one milestone. Mark it done only when evaluated Arena replies show it is done.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        milestone_id: { type: Type.STRING, description: 'Milestone id, e.g. "M-2".' },
        status: { type: Type.STRING, enum: ['pending', 'in_progress', 'done', 'blocked'] },
        notes: { type: Type.STRING, description: 'Optional short note explaining the change.' },
      },
      required: ['milestone_id', 'status'],
    },
  },
  {
    name: 'propose_arena_task',
    description:
      'Propose the next task for Arena. The task is shown to the user, who must approve, edit or reject it; nothing is sent until they approve. Fails if another task is still open or if the same task was already sent.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Short imperative title.' },
        instructions: { type: Type.STRING, description: 'Exactly what Arena must do. Self-contained and specific.' },
        context: { type: Type.STRING, description: 'Background Arena needs: project state, file paths, decisions to respect.' },
        acceptance_criteria: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Concrete checks that Arena\'s report must demonstrate.',
        },
        rationale: { type: Type.STRING, description: 'One or two sentences for the user: why this task, and why now.' },
        milestone_id: { type: Type.STRING, description: 'Milestone this task serves, e.g. "M-1".' },
      },
      required: ['title', 'instructions', 'acceptance_criteria', 'rationale'],
    },
  },
  {
    name: 'evaluate_arena_result',
    description:
      'Record your verdict on Arena\'s reply to a task. Every evidence entry must be an exact quote from the reply; the verdict "complete" requires at least one. Entries that are not found in the reply are refused.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        task_id: { type: Type.STRING, description: 'Task id, e.g. "T-3".' },
        verdict: {
          type: Type.STRING,
          enum: ['complete', 'partial', 'failed', 'unclear'],
          description:
            'complete: the reply demonstrates every acceptance criterion. partial: some demonstrated. failed: the work did not succeed. unclear: the reply does not show the outcome.',
        },
        summary: { type: Type.STRING, description: 'What the reply does and does not establish.' },
        evidence: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Exact quotes copied from Arena\'s reply.' },
        missing: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Criteria or work the reply does not demonstrate.' },
      },
      required: ['task_id', 'verdict', 'summary', 'evidence'],
    },
  },
  {
    name: 'record_decision',
    description: 'Record a decision that later tasks depend on (architecture, tooling, scope).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        rationale: { type: Type.STRING },
      },
      required: ['summary'],
    },
  },
  {
    name: 'record_issue',
    description: 'Record a known defect, risk or blocker so it is not forgotten.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        details: { type: Type.STRING },
        severity: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
        task_id: { type: Type.STRING, description: 'Task that revealed the issue, if any.' },
      },
      required: ['title', 'details', 'severity'],
    },
  },
  {
    name: 'resolve_issue',
    description: 'Mark a known issue as resolved, stating what resolved it.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        issue_id: { type: Type.STRING, description: 'Issue id, e.g. "I-2".' },
        resolution: { type: Type.STRING },
      },
      required: ['issue_id', 'resolution'],
    },
  },
  {
    name: 'update_project_brief',
    description: 'Change the project objective, standing instructions or constraints. Only when the user explicitly asked for the change.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        objective: { type: Type.STRING },
        instructions: { type: Type.STRING },
        constraints: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Replaces the full list of constraints.' },
      },
    },
  },
  {
    name: 'mark_objective_complete',
    description:
      'Declare the whole objective complete. Refused while a task is open, while any milestone is unfinished, or when no task has been verified as completed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING, description: 'What was delivered, referring to the tasks that prove it.' },
      },
      required: ['summary'],
    },
  },
];

export const EVALUATION_TOOL = 'evaluate_arena_result';

export interface ToolContext {
  settings: CompanionSettings;
  model: string;
  /** Removes secrets from text before it is stored (and later sent to Arena). */
  scrub: (text: string) => string;
}

export interface ToolOutcome {
  action: ToolAction;
  /** Sent back to Gemini as the function response. */
  response: Record<string, unknown>;
}

class ToolRefusal extends Error {}

function refuse(message: string): never {
  throw new ToolRefusal(message);
}

function str(args: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (opts.required) refuse(`"${key}" is required.`);
    return '';
  }
  if (typeof value !== 'string') refuse(`"${key}" must be a string.`);
  const trimmed = (value as string).trim();
  if (!trimmed && opts.required) refuse(`"${key}" must not be empty.`);
  return trimmed.slice(0, opts.max ?? 20_000);
}

function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = args[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    refuse(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

const VERDICT_STATUS: Record<EvaluationVerdict, TaskStatus> = {
  complete: 'completed',
  partial: 'partial',
  failed: 'failed',
  unclear: 'inconclusive',
};

const SENT_STATUSES: readonly TaskStatus[] = ['dispatching', 'awaiting_response', 'evaluating', 'completed', 'partial', 'failed', 'inconclusive'];

function setPlan(project: Project, args: Record<string, unknown>): ToolOutcome['response'] & { summary: string } {
  const raw = args.milestones;
  if (!Array.isArray(raw) || raw.length === 0) refuse('"milestones" must be a non-empty list.');
  const list = raw as unknown[];
  if (list.length > 20) refuse('A plan may have at most 20 milestones.');
  const previous = new Map(project.milestones.map((m) => [m.title.trim().toLowerCase(), m]));
  const next: Milestone[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') refuse('Each milestone must be an object with a title.');
    const m = item as Record<string, unknown>;
    const title = str(m, 'title', { required: true, max: 200 });
    const key = title.toLowerCase();
    if (seen.has(key)) refuse(`Milestone "${title}" is listed twice.`);
    seen.add(key);
    const description = str(m, 'description', { max: 2000 });
    const existing = previous.get(key);
    if (existing) {
      next.push({ ...existing, title, description: description || existing.description });
    } else {
      project.counters.milestone += 1;
      next.push({ id: `M-${project.counters.milestone}`, title, description, status: 'pending', notes: '', updatedAt: nowIso() });
    }
  }
  let current: Milestone | undefined;
  const position = args.current_milestone;
  if (typeof position === 'number' && Number.isInteger(position)) {
    if (position < 1 || position > next.length) refuse(`"current_milestone" must be between 1 and ${next.length}.`);
    current = next[position - 1];
  } else {
    current = next.find((m) => m.status === 'in_progress') ?? next.find((m) => m.status !== 'done');
  }
  if (current && current.status === 'pending') {
    current.status = 'in_progress';
    current.updatedAt = nowIso();
  }
  project.milestones = next;
  project.currentMilestoneId = current && current.status !== 'done' ? current.id : null;
  addEvent(project, 'plan', 'info', `Plan set: ${next.length} milestone${next.length === 1 ? '' : 's'}`, next.map((m) => `${m.id} ${m.title}`).join('\n'));
  return {
    summary: `Plan set with ${next.length} milestone${next.length === 1 ? '' : 's'}`,
    milestones: next.map((m) => ({ id: m.id, title: m.title, status: m.status })),
    current_milestone_id: project.currentMilestoneId,
  };
}

function updateMilestone(project: Project, args: Record<string, unknown>): ToolOutcome['response'] & { summary: string } {
  const id = str(args, 'milestone_id', { required: true, max: 20 });
  const milestone = project.milestones.find((m) => m.id === id);
  if (!milestone) refuse(`No milestone "${id}". Known: ${project.milestones.map((m) => m.id).join(', ') || 'none'}.`);
  const status = oneOf<MilestoneStatus>(args, 'status', ['pending', 'in_progress', 'done', 'blocked']);
  const notes = str(args, 'notes', { max: 2000 });
  milestone.status = status;
  if (notes) milestone.notes = notes;
  milestone.updatedAt = nowIso();
  if (status === 'in_progress') {
    project.currentMilestoneId = milestone.id;
  } else if (project.currentMilestoneId === milestone.id && status === 'done') {
    // Work moves on to the next unfinished milestone; a blocked one stays blocked until the coordinator says otherwise.
    const next = project.milestones.find((m) => m.status !== 'done');
    if (next && next.status === 'pending') {
      next.status = 'in_progress';
      next.updatedAt = nowIso();
    }
    project.currentMilestoneId = next?.id ?? null;
  }
  addEvent(project, 'plan', status === 'done' ? 'success' : status === 'blocked' ? 'warning' : 'info', `Milestone ${milestone.id} → ${status.replace('_', ' ')}`, [milestone.title, notes].filter(Boolean).join('\n'));
  return { summary: `${milestone.id} "${milestone.title}" → ${status.replace('_', ' ')}`, milestone_id: milestone.id, status, current_milestone_id: project.currentMilestoneId };
}

function proposeTask(project: Project, args: Record<string, unknown>, ctx: ToolContext): ToolOutcome['response'] & { summary: string } {
  if (project.status === 'complete') refuse('The objective is marked complete. The user must reopen the session before new tasks are proposed.');
  const open = openTask(project);
  if (open) {
    refuse(
      `Task ${open.id} "${open.title}" is still open (status: ${open.status}). Only one task may be open at a time; wait until it is resolved before proposing another.`,
    );
  }
  if (project.session.tasksDispatched >= ctx.settings.maxTasksPerSession) {
    refuse(
      `This session has already sent ${project.session.tasksDispatched} tasks to Arena, which is the configured limit. Tell the user; they must pause and resume the session to continue.`,
    );
  }
  const title = ctx.scrub(str(args, 'title', { required: true, max: 200 }));
  const instructions = ctx.scrub(str(args, 'instructions', { required: true, max: 30_000 }));
  const context = ctx.scrub(str(args, 'context', { max: 20_000 }));
  const rationale = ctx.scrub(str(args, 'rationale', { required: true, max: 2000 }));
  const acceptanceCriteria = cleanList(args.acceptance_criteria, 30, 1000).map(ctx.scrub);
  if (acceptanceCriteria.length === 0) refuse('"acceptance_criteria" needs at least one concrete, checkable criterion.');

  const milestoneId = str(args, 'milestone_id', { max: 20 }) || project.currentMilestoneId;
  if (milestoneId && !project.milestones.some((m) => m.id === milestoneId)) {
    refuse(`No milestone "${milestoneId}". Known: ${project.milestones.map((m) => m.id).join(', ') || 'none'}.`);
  }

  const fp = taskFingerprint({ title, instructions, context, acceptanceCriteria });
  const duplicate = project.tasks.find((t) => t.fingerprint === fp && SENT_STATUSES.includes(t.status));
  if (duplicate) {
    refuse(
      `This is identical to ${duplicate.id} "${duplicate.title}", which was already sent to Arena (status: ${duplicate.status}). Do not re-send the same task. If the work must be redone, write a task that says what went wrong and what must change.`,
    );
  }

  const rejected = project.tasks.find((t) => t.fingerprint === fp && t.status === 'rejected');
  if (rejected) {
    refuse(
      `The user already rejected this exact task (${rejected.id}${rejected.rejection?.reason ? `, reason: "${excerpt(rejected.rejection.reason, 200)}"` : ''}). Propose something different, or ask the user what they want.`,
    );
  }

  project.counters.task += 1;
  const at = nowIso();
  const task: ArenaTask = {
    id: `T-${project.counters.task}`,
    seq: project.counters.task,
    title,
    instructions,
    context,
    acceptanceCriteria,
    rationale,
    milestoneId: milestoneId || null,
    status: 'proposed',
    createdAt: at,
    updatedAt: at,
    editedByUser: false,
    approvedAt: null,
    rejection: null,
    dispatch: null,
    arenaResponse: null,
    evaluation: null,
    evaluationError: null,
    fingerprint: fp,
  };
  project.tasks.push(task);
  syncCurrentTask(project);
  addEvent(project, 'task', 'info', `Task ${task.id} proposed: ${task.title}`, rationale, task.id);
  return {
    summary: `Proposed ${task.id}: ${task.title}`,
    task_id: task.id,
    status: 'proposed',
    note: 'The task is now shown to the user. Nothing is sent to Arena until they approve it. Do not propose another task until this one is resolved.',
  };
}

function evaluateResult(project: Project, args: Record<string, unknown>, ctx: ToolContext): ToolOutcome['response'] & { summary: string } {
  const taskId = str(args, 'task_id', { required: true, max: 20 });
  const task = findTask(project, taskId);
  if (!task) refuse(`No task "${taskId}".`);
  if (!task.arenaResponse) {
    refuse(`Task ${task.id} has no reply from Arena yet (status: ${task.status}). A task can only be evaluated against an actual Arena reply.`);
  }
  if (task.status !== 'evaluating') {
    refuse(`Task ${task.id} is not awaiting evaluation (status: ${task.status}).`);
  }
  const verdict = oneOf<EvaluationVerdict>(args, 'verdict', ['complete', 'partial', 'failed', 'unclear']);
  const summary = str(args, 'summary', { required: true, max: 4000 });
  const evidence = cleanList(args.evidence, 12, 1500);
  const missing = cleanList(args.missing, 20, 600);

  const reply = task.arenaResponse.text;
  const unverifiable = evidence.filter((quote) => quote.replace(/\s+/g, '').length < 8 || !containsQuote(reply, quote));
  if (unverifiable.length > 0) {
    refuse(
      `These evidence entries do not appear in Arena's reply: ${unverifiable.map((q) => `"${excerpt(q, 120)}"`).join('; ')}. ` +
        'Evidence must be copied exactly from the reply (at least a few words each). If the reply does not contain supporting text, the verdict cannot be "complete".',
    );
  }
  if (verdict === 'complete' && evidence.length === 0) {
    refuse('The verdict "complete" needs at least one exact quote from Arena\'s reply as evidence. If the reply does not show the work was done, use "partial", "failed" or "unclear".');
  }

  task.evaluation = { verdict, summary, evidence, missing, at: nowIso(), model: ctx.model };
  task.evaluationError = null;
  task.status = VERDICT_STATUS[verdict];
  task.updatedAt = nowIso();
  syncCurrentTask(project);
  const level = verdict === 'complete' ? 'success' : verdict === 'failed' ? 'error' : 'warning';
  addEvent(project, 'evaluation', level, `Task ${task.id} evaluated: ${verdict}`, summary, task.id);
  return {
    summary: `${task.id} evaluated: ${verdict}`,
    task_id: task.id,
    verdict,
    task_status: task.status,
    note:
      verdict === 'complete'
        ? 'Recorded. Update milestones if this finishes one, then decide whether more work is needed.'
        : 'Recorded. Decide what should happen next; a follow-up task must state what was wrong and what must be different.',
  };
}

function recordDecision(project: Project, args: Record<string, unknown>): ToolOutcome['response'] & { summary: string } {
  const summary = str(args, 'summary', { required: true, max: 1000 });
  const rationale = str(args, 'rationale', { max: 2000 });
  project.counters.decision += 1;
  const id = `D-${project.counters.decision}`;
  project.decisions.push({ id, summary, rationale, at: nowIso(), source: 'coordinator' });
  addEvent(project, 'decision', 'info', `Decision ${id}: ${excerpt(summary, 120)}`, rationale);
  return { summary: `Decision ${id} recorded`, decision_id: id };
}

function recordIssue(project: Project, args: Record<string, unknown>): ToolOutcome['response'] & { summary: string } {
  const title = str(args, 'title', { required: true, max: 300 });
  const details = str(args, 'details', { required: true, max: 4000 });
  const severity = oneOf<IssueSeverity>(args, 'severity', ['low', 'medium', 'high']);
  const taskId = str(args, 'task_id', { max: 20 });
  if (taskId && !findTask(project, taskId)) refuse(`No task "${taskId}".`);
  project.counters.issue += 1;
  const id = `I-${project.counters.issue}`;
  project.issues.push({ id, title, details, severity, status: 'open', resolution: '', taskId: taskId || null, createdAt: nowIso(), resolvedAt: null });
  addEvent(project, 'issue', severity === 'high' ? 'error' : 'warning', `Issue ${id} (${severity}): ${excerpt(title, 120)}`, details, taskId || null);
  return { summary: `Issue ${id} recorded (${severity})`, issue_id: id };
}

function resolveIssue(project: Project, args: Record<string, unknown>): ToolOutcome['response'] & { summary: string } {
  const id = str(args, 'issue_id', { required: true, max: 20 });
  const issue = project.issues.find((i) => i.id === id);
  if (!issue) refuse(`No issue "${id}".`);
  if (issue.status === 'resolved') refuse(`Issue ${id} is already resolved.`);
  const resolution = str(args, 'resolution', { required: true, max: 2000 });
  issue.status = 'resolved';
  issue.resolution = resolution;
  issue.resolvedAt = nowIso();
  addEvent(project, 'issue', 'success', `Issue ${id} resolved`, resolution, issue.taskId);
  return { summary: `Issue ${id} resolved`, issue_id: id };
}

function updateBrief(project: Project, args: Record<string, unknown>, ctx: ToolContext): ToolOutcome['response'] & { summary: string } {
  const changed: string[] = [];
  const objective = ctx.scrub(str(args, 'objective', { max: 4000 }));
  if (objective && objective !== project.objective) {
    project.objective = objective;
    changed.push('objective');
  }
  if (typeof args.instructions === 'string') {
    const instructions = ctx.scrub(args.instructions.trim().slice(0, 20_000));
    if (instructions !== project.instructions) {
      project.instructions = instructions;
      changed.push('instructions');
    }
  }
  if (Array.isArray(args.constraints)) {
    project.constraints = cleanList(args.constraints, 40, 600).map(ctx.scrub);
    changed.push('constraints');
  }
  if (changed.length === 0) refuse('Nothing to change: provide objective, instructions or constraints.');
  touch(project);
  addEvent(project, 'project', 'info', `Project brief updated by the coordinator: ${changed.join(', ')}`, changed.includes('objective') ? project.objective : '');
  return { summary: `Project brief updated (${changed.join(', ')})`, changed };
}

function markComplete(project: Project, args: Record<string, unknown>): ToolOutcome['response'] & { summary: string } {
  const summary = str(args, 'summary', { required: true, max: 4000 });
  const open = project.tasks.find(isOpenTask);
  if (open) refuse(`Task ${open.id} is still open (status: ${open.status}). The objective cannot be complete while work is outstanding.`);
  const completed = project.tasks.filter((t) => t.status === 'completed');
  if (completed.length === 0) {
    refuse('No task has been verified as completed from an Arena reply, so there is no evidence that the objective is met.');
  }
  const unfinished = project.milestones.filter((m) => m.status !== 'done');
  if (unfinished.length > 0) {
    refuse(`These milestones are not done: ${unfinished.map((m) => `${m.id} "${m.title}" (${m.status})`).join(', ')}. Finish them, or correct the plan first.`);
  }
  project.status = 'complete';
  project.completion = { summary, at: nowIso() };
  project.session.status = 'completed';
  project.session.updatedAt = nowIso();
  project.session.pauseReason = null;
  addEvent(project, 'project', 'success', 'Objective complete', summary);
  return { summary: 'Objective marked complete', status: 'complete', verified_tasks: completed.map((t) => t.id) };
}

/**
 * Applies one tool call to the project. Refusals are returned to Gemini as an
 * error payload so it can correct itself; they never throw past this function.
 */
export function executeTool(project: Project, name: string, args: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  try {
    let result: ToolOutcome['response'] & { summary: string };
    switch (name) {
      case 'set_plan':
        result = setPlan(project, args);
        break;
      case 'update_milestone':
        result = updateMilestone(project, args);
        break;
      case 'propose_arena_task':
        result = proposeTask(project, args, ctx);
        break;
      case 'evaluate_arena_result':
        result = evaluateResult(project, args, ctx);
        break;
      case 'record_decision':
        result = recordDecision(project, args);
        break;
      case 'record_issue':
        result = recordIssue(project, args);
        break;
      case 'resolve_issue':
        result = resolveIssue(project, args);
        break;
      case 'update_project_brief':
        result = updateBrief(project, args, ctx);
        break;
      case 'mark_objective_complete':
        result = markComplete(project, args);
        break;
      default:
        refuse(`Unknown tool "${name}".`);
    }
    const { summary, ...response } = result;
    return { action: { name, ok: true, summary }, response: { ok: true, ...response } };
  } catch (error) {
    if (error instanceof ToolRefusal) {
      return { action: { name, ok: false, summary: excerpt(error.message, 240) }, response: { ok: false, error: error.message } };
    }
    throw error;
  }
}
