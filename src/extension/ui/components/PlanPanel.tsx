import type { VNode } from 'preact';
import type { MilestoneStatus, ProjectView } from '../../../shared/types.js';
import { dayAndClock } from '../view.js';
import { Button, Empty, PaneHeader, Tag } from './common.js';

const MILESTONE_TEXT: Record<MilestoneStatus, string> = { pending: 'To do', in_progress: 'In progress', done: 'Done', blocked: 'Blocked' };

export function PlanPanel({ project, onEdit }: { project: ProjectView | null; onEdit: () => void }): VNode {
  if (!project) {
    return (
      <section class="pane pane--plan" aria-label="Project memory">
        <PaneHeader title="Project memory" />
      </section>
    );
  }
  const openIssues = project.issues.filter((i) => i.status === 'open');
  const resolvedIssues = project.issues.filter((i) => i.status === 'resolved');
  return (
    <section class="pane pane--plan" aria-label="Project memory">
      <PaneHeader title="Project memory" />
      <div class="pane__scroll">
        <section class="memo">
          <div class="memo__head">
            <h3 class="memo__name">{project.name}</h3>
            <Button small onClick={onEdit}>
              Edit brief
            </Button>
          </div>
          <p class="memo__objective">{project.objective}</p>
          {project.status === 'complete' && project.completion && (
            <p class="note note--ok">
              Objective complete · {dayAndClock(project.completion.at)}
              <br />
              {project.completion.summary}
            </p>
          )}
        </section>

        {(project.instructions || project.constraints.length > 0) && (
          <section class="memo">
            {project.instructions && (
              <>
                <h4 class="label">Standing instructions</h4>
                <p class="memo__text">{project.instructions}</p>
              </>
            )}
            {project.constraints.length > 0 && (
              <>
                <h4 class="label">Constraints · added to every task</h4>
                <ul class="bullets">
                  {project.constraints.map((constraint, i) => (
                    <li key={i}>{constraint}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        <section class="memo">
          <h4 class="label">Milestones</h4>
          {project.milestones.length === 0 ? (
            <p class="faint">Gemini writes the plan here once it understands the objective.</p>
          ) : (
            <ol class="milestones">
              {project.milestones.map((m) => (
                <li class={`milestone milestone--${m.status}${m.id === project.currentMilestoneId ? ' is-current' : ''}`} key={m.id}>
                  <span class="milestone__mark" aria-hidden="true" />
                  <div class="milestone__body">
                    <p class="milestone__title">
                      <span class="mono milestone__id">{m.id}</span> {m.title}
                    </p>
                    {m.description && <p class="milestone__text">{m.description}</p>}
                    {m.notes && <p class="milestone__text">{m.notes}</p>}
                  </div>
                  <span class="milestone__state">{MILESTONE_TEXT[m.status]}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section class="memo">
          <h4 class="label">Known issues{openIssues.length > 0 ? ` · ${openIssues.length} open` : ''}</h4>
          {project.issues.length === 0 ? (
            <p class="faint">None recorded.</p>
          ) : (
            <ul class="records">
              {[...openIssues, ...resolvedIssues].map((issue) => (
                <li class={`record${issue.status === 'resolved' ? ' record--closed' : ''}`} key={issue.id}>
                  <p class="record__head">
                    <span class="mono">{issue.id}</span>
                    {issue.status === 'open' ? <Tag tone={issue.severity === 'high' ? 'bad' : issue.severity === 'medium' ? 'warn' : 'off'}>{issue.severity}</Tag> : <Tag tone="ok">resolved</Tag>}
                    {issue.taskId && <span class="mono faint">{issue.taskId}</span>}
                  </p>
                  <p class="record__title">{issue.title}</p>
                  {issue.details && <p class="record__text">{issue.details}</p>}
                  {issue.resolution && <p class="record__text">Resolved: {issue.resolution}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="memo">
          <h4 class="label">Decisions</h4>
          {project.decisions.length === 0 ? (
            <p class="faint">None recorded.</p>
          ) : (
            <ul class="records">
              {[...project.decisions].reverse().map((decision) => (
                <li class="record" key={decision.id}>
                  <p class="record__head">
                    <span class="mono">{decision.id}</span>
                    <span class="faint">
                      {decision.source === 'user' ? 'you' : 'Gemini'} · {dayAndClock(decision.at)}
                    </span>
                  </p>
                  <p class="record__title">{decision.summary}</p>
                  {decision.rationale && <p class="record__text">{decision.rationale}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

export function TimelinePanel({ project, onShowTask }: { project: ProjectView | null; onShowTask: (taskId: string) => void }): VNode {
  const events = project ? [...project.timeline].reverse() : [];
  return (
    <section class="pane pane--activity" aria-label="Activity">
      <PaneHeader title="Activity" meta={events.length > 0 ? `${events.length} events` : undefined} />
      <div class="pane__scroll">
        {events.length === 0 ? (
          <Empty title="Nothing has happened yet.">Every approval, dispatch, reply and review is recorded here and kept with the project.</Empty>
        ) : (
          <ol class="timeline">
            {events.map((event) => (
              <li class={`event event--${event.level}`} key={event.id}>
                <span class="event__mark" aria-hidden="true" />
                <div class="event__body">
                  <p class="event__title">
                    {event.title}
                    {event.taskId && (
                      <>
                        {' '}
                        <button type="button" class="link-button mono" onClick={() => onShowTask(event.taskId as string)}>
                          {event.taskId}
                        </button>
                      </>
                    )}
                  </p>
                  {event.detail && <p class="event__detail">{event.detail}</p>}
                </div>
                <time class="event__time mono" dateTime={event.at}>
                  {dayAndClock(event.at)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
