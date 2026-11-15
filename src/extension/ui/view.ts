import type { ArenaExecutionStatus } from '../../shared/messages.js';
import type { Tone } from '../../shared/statusText.js';
import type { ArenaTask, EvaluationVerdict, ProjectView, SessionState, TaskStatus, TurnState } from '../../shared/types.js';
import type { LinkState, WorkspaceState } from './store.js';

export interface Badge {
  label: string;
  tone: Tone | 'act';
}

const TASK_BADGES: Record<TaskStatus, Badge> = {
  proposed: { label: 'Needs your approval', tone: 'act' },
  approved: { label: 'Approved, not sent', tone: 'warn' },
  dispatching: { label: 'Sending to Arena', tone: 'busy' },
  awaiting_response: { label: 'Arena is working', tone: 'busy' },
  evaluating: { label: 'Gemini is reviewing', tone: 'busy' },
  completed: { label: 'Verified complete', tone: 'ok' },
  partial: { label: 'Partly done', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  inconclusive: { label: 'Unclear', tone: 'warn' },
  rejected: { label: 'Rejected by you', tone: 'off' },
  cancelled: { label: 'Cancelled', tone: 'off' },
};

export function taskBadge(task: ArenaTask): Badge {
  if (task.status === 'awaiting_response' && task.dispatch?.unconfirmed) return { label: 'Delivery unconfirmed', tone: 'warn' };
  if (task.status === 'evaluating' && task.evaluationError) return { label: 'Review did not finish', tone: 'bad' };
  return TASK_BADGES[task.status];
}

export const VERDICT_TEXT: Record<EvaluationVerdict, Badge> = {
  complete: { label: 'Complete', tone: 'ok' },
  partial: { label: 'Partial', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  unclear: { label: 'Unclear', tone: 'warn' },
};

export function sessionBadge(session: SessionState): Badge {
  switch (session.status) {
    case 'running':
      return { label: 'Running', tone: 'ok' };
    case 'paused':
      return { label: session.pauseReason === 'restart' ? 'Paused · restored' : session.pauseReason === 'task_budget' ? 'Paused · task limit' : 'Paused', tone: 'warn' };
    case 'stopped':
      return { label: 'Stopped', tone: 'off' };
    case 'completed':
      return { label: 'Objective complete', tone: 'ok' };
    case 'idle':
    default:
      return { label: 'Not started', tone: 'off' };
  }
}

export type StageState = 'todo' | 'done' | 'active' | 'waiting' | 'problem';

export interface RelayStage {
  key: 'plan' | 'approve' | 'send' | 'run' | 'review';
  label: string;
  owner: string;
  state: StageState;
}

const STAGES: Pick<RelayStage, 'key' | 'label' | 'owner'>[] = [
  { key: 'plan', label: 'Plan', owner: 'Gemini' },
  { key: 'approve', label: 'Approve', owner: 'You' },
  { key: 'send', label: 'Send', owner: 'AgentLink' },
  { key: 'run', label: 'Execute', owner: 'Arena' },
  { key: 'review', label: 'Review', owner: 'Gemini' },
];

/** Where the open task is on its way from Gemini to Arena and back. Derived only from recorded state. */
export function relayStages(project: ProjectView | null, turn: TurnState | null, execution: ArenaExecutionStatus | null): { stages: RelayStage[]; caption: string } {
  const states: StageState[] = ['todo', 'todo', 'todo', 'todo', 'todo'];
  const mark = (current: number, state: StageState): void => {
    for (let i = 0; i < current; i += 1) states[i] = 'done';
    states[current] = state;
  };
  const task = project?.tasks.find((t) => t.id === project.currentTaskId) ?? null;
  let caption = 'No task in progress';

  if (!task) {
    if (turn?.active && turn.kind !== 'evaluation') {
      mark(0, 'active');
      caption = 'Gemini is working out the next step';
    } else if (project?.status === 'complete') {
      caption = 'Objective complete';
    }
  } else {
    switch (task.status) {
      case 'proposed':
        mark(1, 'waiting');
        caption = `${task.id} is waiting for your decision`;
        break;
      case 'approved':
        mark(2, task.dispatch?.error ? 'problem' : 'waiting');
        caption = task.dispatch?.error ? `${task.id} was not sent` : `${task.id} is approved and ready to send`;
        break;
      case 'dispatching':
        mark(2, 'active');
        caption = `Sending ${task.id} to Arena`;
        break;
      case 'awaiting_response': {
        const trouble = task.dispatch?.unconfirmed || execution?.phase === 'timeout' || execution?.phase === 'error';
        mark(3, trouble ? 'problem' : 'active');
        caption = task.dispatch?.unconfirmed ? `Delivery of ${task.id} is unconfirmed` : trouble ? `${task.id} needs your attention` : `Arena is working on ${task.id}`;
        break;
      }
      case 'evaluating':
        mark(4, task.evaluationError ? 'problem' : 'active');
        caption = task.evaluationError ? `Review of ${task.id} did not finish` : `Gemini is reviewing Arena's reply to ${task.id}`;
        break;
      default:
        break;
    }
  }
  return { stages: STAGES.map((stage, i) => ({ ...stage, state: states[i] as StageState })), caption };
}

export const LINK_TEXT: Record<LinkState, string> = {
  loading: 'Connecting to the companion…',
  offline: 'Companion not running',
  foreign: 'Wrong companion address',
  unpaired: 'Not paired',
  unauthorized: 'Pairing token rejected',
  online: 'Companion connected',
};

/** Why the user cannot write to the coordinator right now, or `null` when they can. */
export function composerBlock(state: WorkspaceState): string | null {
  const { project, gemini, link } = state;
  if (link !== 'online') return 'The companion is not connected.';
  if (!project) return 'Create a project first.';
  if (!gemini?.keyConfigured) return 'Add a Gemini API key in Settings to talk to the coordinator.';
  switch (project.session.status) {
    case 'paused':
      return 'Session paused. Resume it to continue.';
    case 'stopped':
      return 'Session stopped. Start a new session to continue.';
    case 'completed':
      return 'Objective complete. Start a new session to keep working on this project.';
    default:
      return null;
  }
}

export function milestoneProgress(project: ProjectView): { done: number; total: number } {
  return { done: project.milestones.filter((m) => m.status === 'done').length, total: project.milestones.length };
}

export function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayAndClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString();
  return today ? clock(iso) : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(iso)}`;
}
