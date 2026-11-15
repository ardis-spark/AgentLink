import type { VNode } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ConversationEntry, TurnState } from '../../../shared/types.js';
import { store, type WorkspaceState } from '../store.js';
import { composerBlock, dayAndClock } from '../view.js';
import { AutoTextarea, Button, Empty, PaneHeader } from './common.js';
import { Markdown } from './Markdown.js';

const SPEAKER: Record<ConversationEntry['role'], string> = { user: 'You', coordinator: 'Gemini', system: 'AgentLink' };

function turnText(turn: TurnState | null): string | null {
  if (!turn?.active) return null;
  switch (turn.phase) {
    case 'compacting':
      return 'Summarising older conversation to stay within context…';
    case 'retrying':
      return turn.retry ? `Gemini request failed (${turn.retry.reason}). Retrying, attempt ${turn.retry.attempt} of ${turn.retry.maxAttempts}…` : 'Retrying…';
    case 'tools':
      return 'Updating the plan…';
    case 'streaming':
      return turn.kind === 'evaluation' ? "Reviewing Arena's reply…" : 'Writing…';
    case 'waiting':
    default:
      return turn.kind === 'evaluation' ? "Reading Arena's reply…" : 'Thinking…';
  }
}

function Entry({ entry, onShowTask }: { entry: ConversationEntry; onShowTask: (taskId: string) => void }): VNode {
  const streaming = entry.status === 'streaming';
  const isNote = entry.role === 'system' || entry.kind !== 'message';
  return (
    <li class={`entry entry--${entry.role}${isNote ? ' entry--note' : ''}`}>
      <div class="entry__gutter">
        <span class="entry__who">{SPEAKER[entry.role]}</span>
        <time class="entry__time" dateTime={entry.at}>
          {dayAndClock(entry.at)}
        </time>
      </div>
      <div class="entry__body">
        {entry.role === 'coordinator' ? (
          entry.text ? (
            <Markdown text={entry.text} />
          ) : (
            !streaming && entry.actions.length === 0 && <p class="faint">No text was produced.</p>
          )
        ) : (
          entry.text && (
            <p class="entry__plain">
              {entry.text}
              {entry.kind === 'arena_result' && entry.taskId && (
                <>
                  {' '}
                  <button type="button" class="link-button" onClick={() => onShowTask(entry.taskId as string)}>
                    View reply
                  </button>
                </>
              )}
            </p>
          )
        )}
        {streaming && <span class="caret" aria-hidden="true" />}

        {entry.actions.length > 0 && (
          <ul class="actions" aria-label="Changes made by the coordinator">
            {entry.actions.map((action, index) => (
              <li class={`action${action.ok ? '' : ' action--refused'}`} key={index}>
                <span class="action__mark" aria-hidden="true">
                  {action.ok ? '✓' : '✕'}
                </span>
                <span>
                  {!action.ok && <span class="visually-hidden">Refused: </span>}
                  {action.summary}
                </span>
              </li>
            ))}
          </ul>
        )}

        {entry.status === 'interrupted' && <p class="entry__flag">Stopped before it finished.</p>}
        {entry.status === 'error' && <p class="entry__flag entry__flag--bad">{entry.error ?? 'The request failed.'}</p>}
        {entry.role === 'coordinator' && entry.status === 'complete' && entry.usage && (
          <p class="entry__meta mono">
            {entry.model} · {entry.usage.totalTokens.toLocaleString()} tokens
          </p>
        )}
      </div>
    </li>
  );
}

export function Conversation({ state, onShowTask }: { state: WorkspaceState; onShowTask: (taskId: string) => void }): VNode {
  const { conversation, turn, busy } = state;
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const blocked = composerBlock(state);
  const working = turn?.active === true;
  const status = turnText(turn);

  // Follow new output only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || blocked || working) return;
    pinned.current = true;
    if (await store.send(text)) setDraft('');
  };

  const last = conversation[conversation.length - 1];
  const showStatus = status && !(last?.status === 'streaming' && last.text && turn?.phase === 'streaming');

  return (
    <section class="pane pane--chat" aria-label="Coordinator conversation">
      <PaneHeader title="Coordinator" meta={state.settings ? <span class="mono">{state.settings.model}</span> : undefined} />
      <div
        class="chat__scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget as HTMLDivElement;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {conversation.length === 0 ? (
          <Empty title="Describe what you want built.">
            Gemini will plan the work and propose one task at a time for Arena. Nothing is sent to Arena until you approve it.
          </Empty>
        ) : (
          <ol class="entries">
            {conversation.map((entry) => (
              <Entry entry={entry} key={entry.id} onShowTask={onShowTask} />
            ))}
          </ol>
        )}
        {showStatus && (
          <p class="chat__status" role="status" aria-live="polite">
            <span class="dot dot--busy" aria-hidden="true" />
            {status}
          </p>
        )}
      </div>

      <form
        class="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {blocked && <p class="composer__blocked">{blocked}</p>}
        <div class="composer__row">
          <label class="visually-hidden" for="composer-input">
            Message to the coordinator
          </label>
          <AutoTextarea
            id="composer-input"
            class="textarea composer__input"
            rows={2}
            maxRows={10}
            value={draft}
            disabled={blocked !== null}
            placeholder={conversation.length === 0 ? 'What should this project achieve?' : 'Reply, redirect the work, or ask for the next step'}
            onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {working ? (
            <Button variant="danger" busy={busy['turn:cancel']} onClick={() => void store.cancelTurn()}>
              Stop reply
            </Button>
          ) : (
            <Button variant="primary" type="submit" busy={busy.message} disabled={blocked !== null || !draft.trim()}>
              Send
            </Button>
          )}
        </div>
        <p class="composer__hint">Enter to send · Shift+Enter for a new line</p>
      </form>
    </section>
  );
}
