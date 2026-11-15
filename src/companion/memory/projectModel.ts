import { randomUUID } from 'node:crypto';
import { renderArenaPrompt } from '../../shared/arenaPrompt.js';
import { fingerprint } from '../../shared/text.js';
import {
  OPEN_TASK_STATUSES,
  type ArenaTask,
  type ConversationEntry,
  type ConversationKind,
  type ConversationRole,
  type Project,
  type ProjectSummary,
  type ProjectView,
  type TimelineEvent,
  type TimelineKind,
  type TimelineLevel,
} from '../../shared/types.js';

export const MAX_TIMELINE_EVENTS = 2_000;
export const MAX_CONVERSATION_ENTRIES = 5_000;

export function nowIso(): string {
  return new Date().toISOString();
}

export function createProject(input: { name: string; objective: string; instructions?: string; constraints?: string[] }): Project {
  const at = nowIso();
  const project: Project = {
    schemaVersion: 1,
    id: `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name: input.name,
    objective: input.objective,
    instructions: input.instructions ?? '',
    constraints: input.constraints ?? [],
    status: 'active',
    completion: null,
    createdAt: at,
    updatedAt: at,
    milestones: [],
    currentMilestoneId: null,
    tasks: [],
    currentTaskId: null,
    decisions: [],
    issues: [],
    timeline: [],
    session: { status: 'idle', startedAt: null, updatedAt: at, pauseReason: null, tasksDispatched: 0, note: null },
    conversation: [],
    transcript: [],
    contextSummary: '',
    activeTurn: null,
    pendingNotices: [],
    counters: { task: 0, milestone: 0, decision: 0, issue: 0, event: 0, entry: 0 },
  };
  addEvent(project, 'project', 'info', 'Project created', input.objective);
  return project;
}

export function touch(project: Project): void {
  project.updatedAt = nowIso();
}

export function addEvent(
  project: Project,
  kind: TimelineKind,
  level: TimelineLevel,
  title: string,
  detail = '',
  taskId: string | null = null,
): TimelineEvent {
  project.counters.event += 1;
  const event: TimelineEvent = { id: `E-${project.counters.event}`, at: nowIso(), kind, level, title, detail, taskId };
  project.timeline.push(event);
  if (project.timeline.length > MAX_TIMELINE_EVENTS) {
    project.timeline.splice(0, project.timeline.length - MAX_TIMELINE_EVENTS);
  }
  touch(project);
  return event;
}

export function addEntry(
  project: Project,
  role: ConversationRole,
  kind: ConversationKind,
  text: string,
  extra: Partial<Pick<ConversationEntry, 'taskId' | 'status' | 'model'>> = {},
): ConversationEntry {
  project.counters.entry += 1;
  const entry: ConversationEntry = {
    id: `C-${project.counters.entry}`,
    at: nowIso(),
    role,
    kind,
    text,
    taskId: extra.taskId ?? null,
    status: extra.status ?? 'complete',
    error: null,
    actions: [],
    model: extra.model ?? null,
    usage: null,
  };
  project.conversation.push(entry);
  if (project.conversation.length > MAX_CONVERSATION_ENTRIES) {
    project.conversation.splice(0, project.conversation.length - MAX_CONVERSATION_ENTRIES);
  }
  touch(project);
  return entry;
}

export function isOpenTask(task: ArenaTask): boolean {
  return OPEN_TASK_STATUSES.includes(task.status);
}

export function openTask(project: Project): ArenaTask | null {
  return project.tasks.find(isOpenTask) ?? null;
}

export function findTask(project: Project, taskId: string): ArenaTask | null {
  return project.tasks.find((t) => t.id === taskId) ?? null;
}

/** Keeps `currentTaskId` pointing at the open task, or at nothing. */
export function syncCurrentTask(project: Project): void {
  project.currentTaskId = openTask(project)?.id ?? null;
}

export function taskPrompt(project: Project, task: ArenaTask): string {
  return renderArenaPrompt({ task, projectName: project.name, constraints: project.constraints });
}

/**
 * Fingerprint of what a task asks Arena to do. The task id is left out so the
 * same request under a new id is still recognised as a duplicate.
 */
export function taskFingerprint(task: Pick<ArenaTask, 'title' | 'instructions' | 'context' | 'acceptanceCriteria'>): string {
  return fingerprint([task.instructions, task.context, task.acceptanceCriteria.join('\n')].join('\n---\n'));
}

export function toProjectSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    objective: project.objective,
    status: project.status,
    sessionStatus: project.session.status,
    updatedAt: project.updatedAt,
    openTaskId: openTask(project)?.id ?? null,
    tasksCompleted: project.tasks.filter((t) => t.status === 'completed').length,
  };
}

const VIEW_FULL_RESPONSES = 3;
const VIEW_RESPONSE_EXCERPT_CHARS = 2_000;

/** The project as sent to the UI: no model-facing transcript, and only recent Arena replies in full. */
export function toProjectView(project: Project): ProjectView {
  const { transcript: _transcript, conversation: _conversation, schemaVersion: _schema, counters: _counters, ...rest } = project;
  const withResponses = project.tasks.filter((t) => t.arenaResponse).map((t) => t.id);
  const keepFull = new Set(withResponses.slice(-VIEW_FULL_RESPONSES));
  const tasks = project.tasks.map((task) => {
    if (!task.arenaResponse || keepFull.has(task.id) || task.arenaResponse.text.length <= VIEW_RESPONSE_EXCERPT_CHARS) return task;
    return {
      ...task,
      arenaResponse: { ...task.arenaResponse, text: task.arenaResponse.text.slice(0, VIEW_RESPONSE_EXCERPT_CHARS), excerptOnly: true },
    };
  });
  return { ...rest, tasks };
}
