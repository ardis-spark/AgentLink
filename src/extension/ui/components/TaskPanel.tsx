import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { renderArenaPrompt } from '../../../shared/arenaPrompt.js';
import type { ArenaExecutionStatus } from '../../../shared/messages.js';
import type { ArenaTask, ProjectView } from '../../../shared/types.js';
import { store, type WorkspaceState } from '../store.js';
import { dayAndClock, taskBadge, VERDICT_TEXT } from '../view.js';
import { AutoTextarea, Button, ConfirmButton, CopyButton, Empty, PaneHeader, Tag } from './common.js';

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ editor ---

function TaskEditor({ task, onDone }: { task: ArenaTask; onDone: () => void }): VNode {
  const [title, setTitle] = useState(task.title);
  const [instructions, setInstructions] = useState(task.instructions);
  const [context, setContext] = useState(task.context);
  const [criteria, setCriteria] = useState(task.acceptanceCriteria.join('\n'));
  const busy = store.state.busy[`edit:${task.id}`];
  const valid = title.trim() && instructions.trim() && lines(criteria).length > 0;

  return (
    <form
      class="task-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        void store.editTask(task.id, { title: title.trim(), instructions: instructions.trim(), context: context.trim(), acceptanceCriteria: lines(criteria) }).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <div class="field">
        <label class="label" for="task-title">
          Title
        </label>
        <input id="task-title" class="input" value={title} maxLength={200} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <label class="label" for="task-instructions">
          What Arena should do
        </label>
        <AutoTextarea id="task-instructions" class="textarea" maxRows={16} value={instructions} onInput={(e) => setInstructions((e.currentTarget as HTMLTextAreaElement).value)} />
      </div>
      <div class="field">
        <label class="label" for="task-context">
          Context for Arena
        </label>
        <AutoTextarea id="task-context" class="textarea" maxRows={12} value={context} onInput={(e) => setContext((e.currentTarget as HTMLTextAreaElement).value)} />
        <p class="field__hint">Arena does not share the coordinator's memory. Include what it needs to know.</p>
      </div>
      <div class="field">
        <label class="label" for="task-criteria">
          Acceptance criteria
        </label>
        <AutoTextarea id="task-criteria" class="textarea" maxRows={10} value={criteria} onInput={(e) => setCriteria((e.currentTarget as HTMLTextAreaElement).value)} />
        <p class="field__hint">One per line. Gemini checks Arena's reply against these.</p>
      </div>
      <div class="button-row">
        <Button variant="primary" type="submit" busy={busy} disabled={!valid}>
          Save changes
        </Button>
        <Button onClick={onDone}>Discard</Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------- sub-sections ---

function ExecutionLine({ task, execution }: { task: ArenaTask; execution: ArenaExecutionStatus | null }): VNode {
  const sentAt = task.dispatch?.confirmedAt ?? task.dispatch?.claimedAt;
  const live = execution && (execution.phase === 'generating' || execution.phase === 'settling' || execution.phase === 'submitted' || execution.phase === 'sending');
  const tone = !execution ? 'off' : execution.phase === 'error' || execution.phase === 'timeout' ? 'warn' : live ? 'busy' : 'ok';
  return (
    <div class="exec" role="status" aria-live="polite">
      <div class="exec__row">
        <span class={`dot dot--${tone}`} aria-hidden="true" />
        <span class="exec__text">{execution?.message || 'AgentLink is not watching the Arena tab for this task right now. Capture the reply when Arena has finished, or paste it.'}</span>
      </div>
      <p class="exec__meta mono">
        {sentAt ? `sent ${dayAndClock(sentAt)}` : 'not sent'}
        {hostOf(task.dispatch?.tabUrl) ? ` · ${hostOf(task.dispatch?.tabUrl)}` : ''}
        {execution && execution.chars > 0 ? ` · ${execution.chars.toLocaleString()} characters so far` : ''}
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
      <Button small onClick={() => setOpen(true)}>
        Paste reply…
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
  const source = reply.source === 'auto' ? 'read from the Arena tab' : reply.source === 'manual_capture' ? 'captured on request' : 'pasted by you';
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

function TaskActions({ task, state, onEdit }: { task: ArenaTask; state: WorkspaceState; onEdit: () => void }): VNode | null {
  const { busy } = state;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const sending = busy[`send:${task.id}`];
  const paused = state.project?.session.status !== 'running';

  if (task.status === 'proposed') {
    if (rejecting) {
      return (
        <form
          class="reject"
          onSubmit={(event) => {
            event.preventDefault();
            void store.rejectTask(task.id, reason.trim()).then((ok) => {
              if (ok) setRejecting(false);
            });
          }}
        >
          <label class="label" for="reject-reason">
            Why? (optional — Gemini uses this to propose something better)
          </label>
          <AutoTextarea id="reject-reason" class="textarea" maxRows={6} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
          <div class="button-row">
            <Button variant="danger" type="submit" busy={busy[`reject:${task.id}`]}>
              Reject task
            </Button>
            <Button onClick={() => setRejecting(false)}>Keep it</Button>
          </div>
        </form>
      );
    }
    return (
      <div class="decision">
        <p class="decision__prompt">Nothing is sent until you approve.</p>
        <div class="button-row">
          <Button variant="primary" busy={sending} busyLabel="Sending…" disabled={paused} onClick={() => void store.approveAndSend(task.id)}>
            Approve and send to Arena
          </Button>
          <Button onClick={onEdit}>Edit</Button>
          <Button variant="danger" onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
        {paused && <p class="faint">The session is not running. Resume it to approve tasks.</p>}
      </div>
    );
  }

  if (task.status === 'approved') {
    return (
      <div class="decision">
        {task.dispatch?.error && <p class="note note--bad">{task.dispatch.error}</p>}
        <div class="button-row">
          <Button variant="primary" busy={sending} busyLabel="Sending…" disabled={paused} onClick={() => void store.approveAndSend(task.id)}>
            {task.dispatch?.error ? 'Try sending again' : 'Send to Arena'}
          </Button>
          <Button busy={sending} disabled={paused} onClick={() => void store.sendManually(task.id)} title="Copies the task and records it as sent, so you can paste it into Arena yourself">
            Copy and send by hand
          </Button>
          <ConfirmButton label="Cancel task" confirmLabel="Cancel this task?" busy={busy[`cancel:${task.id}`]} onConfirm={() => void store.cancelTask(task.id)} />
        </div>
      </div>
    );
  }

  if (task.status === 'dispatching') {
    return <p class="note">Typing the task into Arena…</p>;
  }

  if (task.status === 'awaiting_response') {
    return (
      <div class="decision">
        {task.dispatch?.unconfirmed && (
          <p class="note note--warn">
            AgentLink could not confirm that Arena received this task{task.dispatch.error ? `: ${task.dispatch.error}` : '.'} Look at the Arena tab. If the task is there, wait for the reply and capture it. If it is not, mark it as not sent.
          </p>
        )}
        <div class="button-row">
          <Button variant="primary" busy={busy[`capture:${task.id}`]} busyLabel="Reading…" onClick={() => void store.captureReply(task.id)}>
            Capture reply now
          </Button>
          <PasteReply task={task} />
          <Button small variant="quiet" onClick={() => void store.focusArena()}>
            Go to Arena tab
          </Button>
        </div>
        <div class="button-row">
          {task.dispatch && <CopyButton text={task.dispatch.prompt} label="Copy task text" />}
          {task.dispatch?.unconfirmed && (
            <Button small busy={busy[`reset:${task.id}`]} onClick={() => void store.markNotSent(task.id)}>
              It was not sent
            </Button>
          )}
          <ConfirmButton small label="Cancel task" confirmLabel="Cancel this task?" busy={busy[`cancel:${task.id}`]} onConfirm={() => void store.cancelTask(task.id)} />
        </div>
      </div>
    );
  }

  if (task.status === 'evaluating') {
    const running = state.turn?.active && state.turn.kind === 'evaluation';
    return (
      <div class="decision">
        {task.evaluationError ? (
          <p class="note note--bad">The review did not finish: {task.evaluationError}</p>
        ) : (
          <p class="note">{running ? "Gemini is reviewing Arena's reply against the acceptance criteria…" : paused ? 'The reply is saved. Gemini will review it when the session is resumed.' : 'Waiting for Gemini to review the reply.'}</p>
        )}
        {!running && !paused && (
          <div class="button-row">
            <Button variant="primary" busy={busy[`evaluate:${task.id}`]} onClick={() => void store.retryEvaluation(task.id)}>
              {task.evaluationError ? 'Run the review again' : 'Run the review'}
            </Button>
            <ConfirmButton label="Cancel task" confirmLabel="Cancel this task?" busy={busy[`cancel:${task.id}`]} onConfirm={() => void store.cancelTask(task.id)} />
          </div>
        )}
      </div>
    );
  }
  return null;
}

// -------------------------------------------------------------------- card ---

function TaskCard({ task, project, state }: { task: ArenaTask; project: ProjectView; state: WorkspaceState }): VNode {
  const [editing, setEditing] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const badge = taskBadge(task);
  const execution = state.executions[task.id] ?? null;
  const milestone = project.milestones.find((m) => m.id === task.milestoneId);
  // Before sending this is a faithful preview; afterwards the recorded text is shown.
  const prompt = task.dispatch?.prompt ?? renderArenaPrompt({ task, projectName: project.name, constraints: project.constraints });

  return (
    <article class={`task task--${task.status}`}>
      <header class="task__head">
        <div class="task__ids">
          <span class="task__id mono">{task.id}</span>
          <Tag tone={badge.tone}>{badge.label}</Tag>
          {task.editedByUser && <span class="faint">edited by you</span>}
        </div>
        <h3 class="task__title">{task.title}</h3>
        {milestone && (
          <p class="task__milestone">
            <span class="mono">{milestone.id}</span> {milestone.title}
          </p>
        )}
      </header>

      {editing && task.status === 'proposed' ? (
        <TaskEditor task={task} onDone={() => setEditing(false)} />
      ) : (
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
                {task.dispatch ? 'Exact text sent to Arena' : 'Exact text that will be sent to Arena'}
              </button>
              {showPrompt && <CopyButton text={prompt} />}
            </div>
            {showPrompt && (
              <pre class="reply reply--open" tabIndex={0}>
                {prompt}
              </pre>
            )}
          </section>

          {task.status === 'awaiting_response' && <ExecutionLine task={task} execution={execution} />}
          {task.rejection && (
            <p class="note">
              Rejected{task.rejection.reason ? `: ${task.rejection.reason}` : ' without a reason.'}
            </p>
          )}
          <ArenaReply task={task} state={state} />
          <Evaluation task={task} />
          <TaskActions task={task} state={state} onEdit={() => setEditing(true)} />
        </>
      )}
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
          <Empty title="No task yet.">When Gemini proposes work for Arena it appears here for you to approve, edit or reject.</Empty>
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
