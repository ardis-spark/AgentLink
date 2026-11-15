import type { Tone } from '../../shared/statusText.js';
import type { ArenaTask, Blocker, EvaluationVerdict, ProjectView, RelayLink, SessionState, TaskStatus, TurnState } from '../../shared/types.js';
import type { LinkState, WorkspaceState } from './store.js';

export interface Badge {
  label: string;
  tone: Tone | 'act';
}

const TASK_BADGES: Record<TaskStatus, Badge> = {
  queued: { label: 'Going to Arena', tone: 'busy' },
  dispatching: { label: 'Sending to Arena', tone: 'busy' },
  awaiting_response: { label: 'Arena is working', tone: 'busy' },
  evaluating: { label: 'Gemini is reviewing', tone: 'busy' },
  completed: { label: 'Verified complete', tone: 'ok' },
  partial: { label: 'Partly done', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  inconclusive: { label: 'Unclear', tone: 'warn' },
  no_response: { label: 'No reply from Arena', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'off' },
};

export function taskBadge(task: ArenaTask): Badge {
  if (task.status === 'queued' && task.relay?.attention) return { label: 'Waiting for Arena', tone: 'warn' };
  if (task.status === 'awaiting_response' && task.dispatch?.unconfirmed) return { label: 'Checking delivery', tone: 'warn' };
  if (task.status === 'awaiting_response' && task.relay?.attention) return { label: 'Looking for the reply', tone: 'warn' };
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
      return { label: 'Running by itself', tone: 'ok' };
    case 'paused':
      return { label: 'Paused', tone: 'warn' };
    case 'blocked':
      return { label: session.blocker?.kind === 'question' ? 'Waiting for your answer' : 'Needs you', tone: 'warn' };
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
  key: 'plan' | 'send' | 'run' | 'review';
  label: string;
  owner: string;
  state: StageState;
}

const STAGES: Pick<RelayStage, 'key' | 'label' | 'owner'>[] = [
  { key: 'plan', label: 'Plan', owner: 'Gemini' },
  { key: 'send', label: 'Send', owner: 'AgentLink' },
  { key: 'run', label: 'Execute', owner: 'Arena' },
  { key: 'review', label: 'Review', owner: 'Gemini' },
];

/**
 * Where the loop is: Gemini plans, AgentLink sends, Arena executes, Gemini
 * reviews, and round again. Derived only from recorded state.
 */
export function relayStages(project: ProjectView | null, turn: TurnState | null): { stages: RelayStage[]; caption: string } {
  const states: StageState[] = ['todo', 'todo', 'todo', 'todo'];
  const mark = (current: number, state: StageState): void => {
    for (let i = 0; i < current; i += 1) states[i] = 'done';
    states[current] = state;
  };
  const task = project?.tasks.find((t) => t.id === project.currentTaskId) ?? null;
  const session = project?.session.status ?? 'idle';
  const held = session === 'paused' ? 'Paused' : session === 'blocked' ? 'Waiting for you' : null;
  let caption = 'Nothing in progress';

  if (!task) {
    if (session === 'completed') caption = 'Objective complete';
    else if (session === 'stopped') caption = 'Stopped';
    else if (session === 'idle') caption = 'Not started';
    else if (held) {
      mark(0, 'waiting');
      caption = held;
    } else {
      mark(0, 'active');
      caption = turn?.active && turn.phase === 'retrying' ? 'Gemini did not answer; trying again' : 'Gemini is working out the next step';
    }
  } else {
    const relay = task.relay;
    switch (task.status) {
      case 'queued':
        mark(1, relay?.attention ? 'problem' : held ? 'waiting' : 'active');
        caption = held ? `${held} · ${task.id} has not been sent` : (relay?.message ?? `Sending ${task.id} to Arena`);
        break;
      case 'dispatching':
        mark(1, 'active');
        caption = relay?.message ?? `Typing ${task.id} into Arena`;
        break;
      case 'awaiting_response':
        mark(2, relay?.attention || task.dispatch?.unconfirmed ? 'problem' : 'active');
        caption = relay?.message ?? `Arena is working on ${task.id}`;
        break;
      case 'evaluating':
        mark(3, held ? 'waiting' : 'active');
        caption = held
          ? `${held} · Arena's reply to ${task.id} is saved`
          : task.evaluationError
            ? `Review of ${task.id} did not finish; trying again`
            : `Gemini is reviewing Arena's reply to ${task.id}`;
        break;
      default:
        break;
    }
  }
  return { stages: STAGES.map((stage, i) => ({ ...stage, state: states[i] as StageState })), caption };
}

export interface Attention {
  tone: 'warn' | 'bad';
  title: string;
  detail: string;
  /** Answers the coordinator offered; choosing one sends it. */
  options: string[];
  /** Whether "Continue" makes sense (anything except an open question, which needs an answer). */
  canContinue: boolean;
  /** Which settings section fixes it, if one does. */
  settings: 'gemini' | 'arena' | null;
}

function blockerAttention(blocker: Blocker): Attention {
  return {
    tone: 'warn',
    title: blocker.title,
    detail: blocker.detail,
    options: blocker.options,
    canContinue: blocker.kind !== 'question',
    settings: blocker.kind === 'gemini' ? 'gemini' : blocker.kind === 'arena' ? 'arena' : null,
  };
}

/**
 * The one thing, if any, that keeps the project from moving by itself.
 * `null` means AgentLink is working (or finished) and nothing is expected of the user.
 */
export function attentionOf(project: ProjectView | null, relay: RelayLink | null): Attention | null {
  if (!project) return null;
  const session = project.session;
  if (session.status === 'blocked' && session.blocker) return blockerAttention(session.blocker);
  if (session.status !== 'running') return null;
  const task = project.tasks.find((t) => t.id === project.currentTaskId) ?? null;
  if (!task) return null;
  const inRelay = task.status === 'queued' || task.status === 'dispatching' || task.status === 'awaiting_response';
  if (!inRelay) return null;
  if (relay && !relay.online) {
    return {
      tone: 'bad',
      title: 'The browser relay is not reaching the companion',
      detail: 'The part of the extension that carries tasks to Arena has not checked in. It reconnects by itself; if this stays, reload the extension.',
      options: [],
      canContinue: false,
      settings: null,
    };
  }
  if (task.relay?.attention) {
    return { tone: 'warn', title: `${task.id} is waiting on the Arena tab`, detail: task.relay.message, options: [], canContinue: false, settings: 'arena' };
  }
  return null;
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
  if (project.session.status === 'paused') return 'Session paused. Resume it to continue.';
  return null;
}

/** What the message box invites, given where the session stands. */
export function composerPlaceholder(project: ProjectView, empty: boolean): string {
  switch (project.session.status) {
    case 'blocked':
      return project.session.blocker?.kind === 'question' ? 'Your answer' : 'Tell the coordinator how to proceed, or press Continue above';
    case 'stopped':
    case 'completed':
      return 'Describe what to do next; sending starts a new session';
    case 'running':
      return 'Redirect the work or add information at any time (not required)';
    default:
      return empty ? 'What should this project achieve?' : 'Message the coordinator';
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
