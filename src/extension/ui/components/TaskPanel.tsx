import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { arenaRef, renderArenaPrompt } from '../../../shared/arenaPrompt.js';
import type { ArenaTask, ProjectView } from '../../../shared/types.js';
import { store, type WorkspaceState } from '../store.js';
import { dayAndClock, taskBadge, VERDICT_TEXT } from '../view.js';
import { AutoTextarea, Button, ConfirmButton, CopyButton, Empty, PaneHeader, Tag } from './common.js';

function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ------------------------------------------------------------- sub-sections ---

/** What the relay is doing for this task right now, as it reported it. */
function RelayLine({ task }: { task: ArenaTask }): VNode {
  const relay = task.relay;
  const sentAt = task.dispatch?.confirmedAt ?? task.dispatch?.claimedAt;
  const tone = !relay ? 'busy' : relay.attention ? 'warn' : 'busy';
  const fallback = task.status === 'queued' ? 'Queued for Arena. AgentLink sends it as soon as the Arena tab is free.' : task.status === 'dispatching' ? 'Typing the task into Arena…' : "Waiting for Arena's reply.";
  return (
    <div class="exec" role="status" aria-live="polite">
      <div class="exec__row">
        <span class={`dot dot--${tone}`} aria-hidden="true" />
        <span class="exec__text">{relay?.message || fallback}</span>
      </div>
      <p class="exec__meta mono">
        {sentAt ? `sent ${dayAndClock(sentAt)}` : 'not sent yet'}
        {hostOf(task.dispatch?.tabUrl) ? ` · ${hostOf(task.dispatch?.tabUrl)}` : ''}
        {task.dispatch && task.dispatch.attempt > 1 ? ` · attempt ${task.dispatch.attempt}` : ''}
        {relay && relay.chars > 0 ? ` · ${relay.chars.toLocaleString()} characters so far` : ''}
      </p>
    </div>
  );
}

function PasteReply({ task }: { task: ArenaTask }): VNode {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const busy = store.state.busy[`paste:${task.id}`];
  if (!open) {
    return (
      <Button small variant="quiet" onClick={() => setOpen(true)}>
        Paste the reply by hand…
      </Button>
    );
  }
  return (
    <form
      class="paste"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        void store.pasteReply(task.id, text).then((ok) => {
          if (ok) {
            setOpen(false);
            setText('');
          }
        });
      }}
    >
      <label class="label" for="paste-reply">
        Arena's reply to {task.id}
      </label>
      <AutoTextarea id="paste-reply" class="textarea textarea--mono" maxRows={14} value={text} placeholder="Paste exactly what Arena answered" onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} />
      <div class="button-row">
        <Button variant="primary" type="submit" busy={busy} disabled={!text.trim()}>
          Hand to Gemini
        </Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

function ArenaReply({ task, state }: { task: ArenaTask; state: WorkspaceState }): VNode | null {
  const reply = task.arenaResponse;
  const [open, setOpen] = useState(false);
  if (!reply) return null;
  const cached = state.fullTasks[task.id]?.arenaResponse;
  const full = cached && cached.id === reply.id ? cached : null;
  const shown = full ?? reply;
  const needsFetch = reply.excerptOnly === true && !full;
  const source = reply.source === 'auto' ? 'read from the Arena tab' : reply.source === 'manual_capture' ? 'taken on request' : 'pasted by you';
  return (
    <section class="block">
      <div class="block__head">
        <h4 class="label">Arena's reply</h4>
        <span class="block__meta mono">
          {reply.chars.toLocaleString()} chars · {source} · {dayAndClock(reply.receivedAt)}
        </span>
      </div>
      <pre class={`reply${open ? ' reply--open' : ''}`} tabIndex={0}>
        {shown.text}
        {needsFetch ? '\n…' : ''}
      </pre>
      <div class="button-row">
        <Button
          small
          variant="quiet"
          busy={state.busy[`task:${task.id}`]}
          onClick={() => {
            if (!open && needsFetch) void store.loadFullTask(task.id);
            setOpen(!open);
          }}
        >
          {open ? 'Show less' : 'Show full reply'}
        </Button>
        {reply.truncated && <span class="faint">The reply was longer than AgentLink stores; the end was cut.</span>}
      </div>
    </section>
  );
}

function Evaluation({ task }: { task: ArenaTask }): VNode | null {
  const evaluation = task.evaluation;
  if (!evaluation) return null;
  const verdict = VERDICT_TEXT[evaluation.verdict];
  return (
    <section class={`block verdict verdict--${verdict.tone}`}>
      <div class="block__head">
        <h4 class="label">Gemini's review</h4>
        <span class="block__meta mono">
          {evaluation.model} · {dayAndClock(evaluation.at)}
        </span>
      </div>
      <p class="verdict__line">
        <Tag tone={verdict.tone}>{verdict.label}</Tag>
        <span>{evaluation.summary}</span>
      </p>
      {evaluation.evidence.length > 0 && (
        <div>
          <p class="label">Quoted from Arena's reply</p>
          <ul class="quotes">
            {evaluation.evidence.map((quote, i) => (
              <li key={i}>
                <q>{quote}</q>
              </li>
            ))}
          </ul>
        </div>
      )}
      {evaluation.missing.length > 0 && (
        <div>
          <p class="label">Not shown in the reply</p>
          <ul class="bullets">
            {evaluation.missing.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ actions ---

/**
 * Nothing here is needed for the work to proceed. The task moves by itself;
 * these are the ways to step in: abandon the task, or help when the Arena
 * page cannot be read.
 */
function TaskActions({ task, state }: { task: ArenaTask; state: WorkspaceState }): VNode | null {
  const { busy } = state;
  const session = state.project?.session.status;
  const cancel = <ConfirmButton small label="Cancel task" confirmLabel="Cancel this task?" busy={busy[`cancel:${task.id}`]} onConfirm={() => void store.cancelTask(task.id)} />;

  if (task.status === 'queued' || task.status === 'dispatching') {
    return (
      <div class="decision">
        {session === 'paused' && <p class="note">The session is paused. This task is sent when you resume.</p>}
        {task.dispatch?.error && <p class="note note--warn">Last attempt: {task.dispatch.error} AgentLink tries again by itself.</p>}
        <div class="button-row">
          <Button small variant="quiet" onClick={() => void store.focusArena()}>
            Go to Arena tab
          </Button>
          {cancel}
        </div>
      </div>
    );
  }

  if (task.status === 'awaiting_response') {
    return (
      <div class="decision">
        <p class="decision__prompt">AgentLink collects the reply by itself when Arena has finished. Use these only if it cannot.</p>
        <div class="button-row">
          <Button small variant="quiet" busy={busy[`capture:${task.id}`]} busyLabel="Reading…" onClick={() => void store.captureReply(task.id)} title="Hands over what Arena has written so far, without waiting for it to finish">
            Take the reply as it is now
          </Button>
          <PasteReply task={task} />
          <Button small variant="quiet" onClick={() => void store.focusArena()}>
            Go to Arena tab
          </Button>
          {cancel}
        </div>
      </div>
    );
  }

  if (task.status === 'evaluating') {
    const running = state.turn?.active && state.turn.kind === 'evaluation';
    const waiting = session === 'paused' ? 'The reply is saved. Gemini reviews it when the session is resumed.' : session === 'blocked' ? 'The reply is saved. Gemini reviews it when the session continues.' : 'The reply is saved. Gemini reviews it next.';
    return (
      <div class="decision">
        {task.evaluationError && <p class="note note--warn">The last review did not finish: {task.evaluationError}</p>}
        <p class="note">{running ? "Gemini is reviewing Arena's reply against the acceptance criteria…" : waiting}</p>
        {!running && <div class="button-row">{cancel}</div>}
      </div>
    );
  }
  return null;
}

// -------------------------------------------------------------------- card ---

function TaskCard({ task, project, state }: { task: ArenaTask; project: ProjectView; state: WorkspaceState }): VNode {
  const [showPrompt, setShowPrompt] = useState(false);
  const badge = taskBadge(task);
  const inRelay = task.status === 'queued' || task.status === 'dispatching' || task.status === 'awaiting_response';
  const milestone = project.milestones.find((m) => m.id === task.milestoneId);
  // The recorded text once sent. Before that, a preview that differs from the real one only in its reference code.
  const prompt = task.dispatch?.prompt ?? renderArenaPrompt({ task, projectName: project.name, constraints: project.constraints, ref: arenaRef(task.id, 'preview') });

  return (
    <article class={`task task--${task.status}`}>
      <header class="task__head">
        <div class="task__ids">
          <span class="task__id mono">{task.id}</span>
          <Tag tone={badge.tone}>{badge.label}</Tag>
        </div>
        <h3 class="task__title">{task.title}</h3>
        {milestone && (
          <p class="task__milestone">
            <span class="mono">{milestone.id}</span> {milestone.title}
          </p>
        )}
      </header>

      <>
          {task.rationale && (
            <p class="task__why">
              <span class="label">Why now</span> {task.rationale}
            </p>
          )}
          <section class="block">
            <h4 class="label">What Arena should do</h4>
            <p class="task__text">{task.instructions}</p>
          </section>
          {task.context && (
            <section class="block">
              <h4 class="label">Context for Arena</h4>
              <p class="task__text">{task.context}</p>
            </section>
          )}
          <section class="block">
            <h4 class="label">Acceptance criteria</h4>
            <ul class="checks">
              {task.acceptanceCriteria.map((criterion, i) => (
                <li key={i}>{criterion}</li>
              ))}
            </ul>
          </section>

          <section class="block">
            <div class="block__head">
              <button type="button" class="disclosure" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}>
                <span class="disclosure__mark" aria-hidden="true">
                  {showPrompt ? '−' : '+'}
                </span>
                {task.dispatch ? 'Exact text sent to Arena' : 'Text that will be sent to Arena'}
              </button>
              {showPrompt && <CopyButton text={prompt} />}
            </div>
            {showPrompt && (
              <pre class="reply reply--open" tabIndex={0}>
                {prompt}
              </pre>
            )}
          </section>

          {inRelay && <RelayLine task={task} />}
          {task.closedReason && <p class="note">{task.closedReason}</p>}
          <ArenaReply task={task} state={state} />
          <Evaluation task={task} />
          <TaskActions task={task} state={state} />
      </>
    </article>
  );
}

export function TaskPanel({ state, selectedTaskId, onSelect }: { state: WorkspaceState; selectedTaskId: string | null; onSelect: (taskId: string | null) => void }): VNode {
  const project = state.project;
  if (!project) {
    return (
      <section class="pane pane--task" aria-label="Arena task">
        <PaneHeader title="Arena task" />
      </section>
    );
  }
  const open = project.tasks.find((t) => t.id === project.currentTaskId) ?? null;
  const selected = project.tasks.find((t) => t.id === selectedTaskId) ?? open ?? project.tasks[project.tasks.length - 1] ?? null;
  const history = [...project.tasks].reverse();

  return (
    <section class="pane pane--task" aria-label="Arena task">
      <PaneHeader title="Arena task" meta={project.tasks.length > 0 ? `${project.tasks.filter((t) => t.status === 'completed').length} of ${project.tasks.length} verified` : undefined} />
      <div class="pane__scroll">
        {selected ? (
          <>
            {open && selected.id !== open.id && (
              <button type="button" class="banner" onClick={() => onSelect(null)}>
                <span class="mono">{open.id}</span> is the open task — show it
              </button>
            )}
            <TaskCard task={selected} project={project} state={state} key={selected.id} />
          </>
        ) : (
          <Empty title="No task yet.">Each task Gemini sends to Arena appears here, with Arena's reply and Gemini's review of it.</Empty>
        )}

        {history.length > 1 && (
          <section class="history">
            <h3 class="label">All tasks</h3>
            <ul class="history__list">
              {history.map((task) => {
                const badge = taskBadge(task);
                return (
                  <li key={task.id}>
                    <button type="button" class={`history__item${selected?.id === task.id ? ' is-selected' : ''}`} aria-current={selected?.id === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)}>
                      <span class="mono history__id">{task.id}</span>
                      <span class="history__title">{task.title}</span>
                      <Tag tone={badge.tone}>{badge.label}</Tag>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </section>
  );
}
