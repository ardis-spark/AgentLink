import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_ARENA_ADAPTER_CONFIG, type ArenaAdapterConfig } from '../../../shared/messages.js';
import { describeGemini, formatTime } from '../../../shared/statusText.js';
import { validateSelector } from '../../lib/settings.js';
import { store, type WorkspaceState } from '../store.js';
import { LINK_TEXT } from '../view.js';
import { Button, Dot, Tag } from './common.js';

export type SettingsSection = 'companion' | 'gemini' | 'arena';

// --------------------------------------------------------------- companion ---

/** Address + pairing token. Also used full-page when the extension is not paired yet. */
export function PairingForm({ state }: { state: WorkspaceState }): VNode {
  const [url, setUrl] = useState(state.ext.companionUrl);
  const [token, setToken] = useState(state.ext.pairingToken);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Follow saved settings when they change elsewhere (another AgentLink page), without touching what is being typed.
  const saved = useRef({ url: state.ext.companionUrl, token: state.ext.pairingToken });
  useEffect(() => {
    if (saved.current.url === state.ext.companionUrl && saved.current.token === state.ext.pairingToken) return;
    saved.current = { url: state.ext.companionUrl, token: state.ext.pairingToken };
    setUrl(state.ext.companionUrl);
    setToken(state.ext.pairingToken);
  }, [state.ext.companionUrl, state.ext.pairingToken]);

  // The companion prints "<address>/settings#token=<token>". Pasting that whole link fills both fields.
  const onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData('text') ?? '';
    const match = /^\s*(https?:\/\/[^\s#]+?)(?:\/settings)?\/?#token=([^\s&]+)\s*$/.exec(text);
    if (!match) return;
    event.preventDefault();
    setUrl(match[1] as string);
    setToken(decodeURIComponent(match[2] as string));
  };

  return (
    <form
      class="form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void store
          .pair(url, token)
          .then(setError)
          .finally(() => setBusy(false));
      }}
    >
      <div class="field">
        <label class="label" for="companion-url">
          Companion address
        </label>
        <input id="companion-url" class="input input--mono" value={url} spellcheck={false} autocomplete="off" onPaste={onPaste} onInput={(e) => setUrl((e.currentTarget as HTMLInputElement).value)} />
      </div>
      <div class="field">
        <label class="label" for="companion-token">
          Pairing token
        </label>
        <input id="companion-token" class="input input--mono" type="password" value={token} spellcheck={false} autocomplete="off" onPaste={onPaste} onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} />
        <p class="field__hint">Printed in the terminal when the companion starts. You can paste the whole link it prints into either field.</p>
      </div>
      {error && (
        <p class="note note--bad" role="alert">
          {error}
        </p>
      )}
      <div class="button-row">
        <Button variant="primary" type="submit" busy={busy} busyLabel="Connecting…" disabled={!url.trim() || !token.trim()}>
          {state.link === 'online' ? 'Save and reconnect' : 'Connect'}
        </Button>
        {state.link !== 'online' && state.ext.pairingToken && (
          <Button onClick={() => void store.connect()}>Try again</Button>
        )}
      </div>
    </form>
  );
}

function CompanionSection({ state }: { state: WorkspaceState }): VNode {
  const online = state.link === 'online';
  return (
    <section class="set" id="settings-companion">
      <h3 class="set__title">Companion</h3>
      <p class="set__status">
        <Dot tone={online ? 'ok' : state.link === 'loading' ? 'busy' : 'bad'} />
        <span>{LINK_TEXT[state.link]}</span>
        {online && state.version && <span class="mono faint">v{state.version}</span>}
      </p>
      {!online && state.linkMessage && <p class="set__text">{state.linkMessage}</p>}
      <PairingForm state={state} />
    </section>
  );
}

// ------------------------------------------------------------------ gemini ---

function GeminiSection({ state }: { state: WorkspaceState }): VNode {
  const { gemini, settings, models, modelsError, busy } = state;
  const [custom, setCustom] = useState('');
  useEffect(() => {
    if (gemini?.keyConfigured && models === null && !modelsError) void store.loadModels();
  }, [gemini?.keyConfigured, gemini?.keyFingerprint]);

  if (!gemini || !settings) {
    return (
      <section class="set" id="settings-gemini">
        <h3 class="set__title">Gemini</h3>
        <p class="set__text">Connect the companion first. The Gemini API key lives there, not in the browser.</p>
      </section>
    );
  }
  const text = describeGemini(gemini);
  const listed = models?.some((m) => m.id === settings.model) ?? false;

  return (
    <section class="set" id="settings-gemini">
      <h3 class="set__title">Gemini</h3>
      <p class="set__status">
        <Dot tone={text.tone} />
        <span>{text.label}</span>
      </p>
      <p class="set__text">{text.detail}</p>

      <dl class="facts">
        <div>
          <dt>API key</dt>
          <dd>
            {gemini.keyConfigured ? (
              <>
                {gemini.keySource === 'environment' ? 'From GEMINI_API_KEY' : 'Saved in the companion'}
                {gemini.keyFingerprint && <span class="mono faint"> · id {gemini.keyFingerprint}</span>}
              </>
            ) : (
              'Not set'
            )}
          </dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{gemini.lastCheckedAt ? formatTime(gemini.lastCheckedAt) : 'Never'}</dd>
        </div>
      </dl>

      <div class="button-row">
        <Button variant={gemini.keyConfigured ? 'default' : 'primary'} onClick={store.openKeySettings}>
          {gemini.keyConfigured ? 'Change API key' : 'Add API key'}
        </Button>
        <Button busy={busy['gemini:test']} busyLabel="Testing…" disabled={!gemini.keyConfigured} onClick={() => void store.testGemini()}>
          Test connection
        </Button>
      </div>
      <p class="field__hint">The key is entered on the companion's own page and is never stored in, or sent to, this extension.</p>

      <div class="field">
        <label class="label" for="gemini-model">
          Model
        </label>
        {models && models.length > 0 ? (
          <select
            id="gemini-model"
            class="select"
            value={settings.model}
            disabled={busy['gemini:model']}
            onChange={(e) => {
              const id = (e.currentTarget as HTMLSelectElement).value;
              if (id && id !== settings.model) void store.setModel(id);
            }}
          >
            {!listed && <option value={settings.model}>{settings.model} (not in your key's list)</option>}
            {models.map((m) => (
              <option value={m.id} key={m.id}>
                {m.displayName && m.displayName !== m.id ? `${m.displayName} · ${m.id}` : m.id}
              </option>
            ))}
          </select>
        ) : (
          <p class="set__text mono">{settings.model}</p>
        )}
        {modelsError && <p class="note note--warn">The model list could not be loaded: {modelsError}</p>}
        <div class="button-row">
          <Button small variant="quiet" busy={busy['gemini:models']} busyLabel="Loading…" disabled={!gemini.keyConfigured} onClick={() => void store.loadModels(true)}>
            Refresh model list
          </Button>
        </div>
      </div>

      <form
        class="field"
        onSubmit={(event) => {
          event.preventDefault();
          const id = custom.trim();
          if (!id) return;
          void store.setModel(id).then(() => setCustom(''));
        }}
      >
        <label class="label" for="gemini-model-custom">
          Use a model by ID
        </label>
        <div class="inline-field">
          <input id="gemini-model-custom" class="input input--mono" value={custom} spellcheck={false} autocomplete="off" placeholder="exact model ID" onInput={(e) => setCustom((e.currentTarget as HTMLInputElement).value)} />
          <Button type="submit" busy={busy['gemini:model']} disabled={!custom.trim()}>
            Use
          </Button>
        </div>
        <p class="field__hint">For a model your key can use that the list does not show. AgentLink tests it straight away.</p>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------- arena ---

const SELECTOR_FIELDS: { key: 'composerSelector' | 'sendButtonSelector' | 'responseSelector' | 'busySelector'; label: string; hint: string }[] = [
  { key: 'composerSelector', label: 'Message box', hint: 'The field you type into.' },
  { key: 'sendButtonSelector', label: 'Send button', hint: 'Leave empty to send with Enter when no button is found.' },
  { key: 'responseSelector', label: 'Arena replies', hint: 'Matches each reply; AgentLink reads the ones that follow the task it sent.' },
  { key: 'busySelector', label: 'Working indicator', hint: 'Something that exists only while Arena is still working, such as a Stop button.' },
];

function AdapterForm({ state }: { state: WorkspaceState }): VNode {
  const [draft, setDraft] = useState<ArenaAdapterConfig>(state.ext.adapter);
  const [saving, setSaving] = useState(false);
  const savedAdapter = useRef(state.ext.adapter);
  useEffect(() => {
    if (savedAdapter.current === state.ext.adapter) return;
    savedAdapter.current = state.ext.adapter;
    setDraft(state.ext.adapter);
  }, [state.ext.adapter]);

  const problems = Object.fromEntries(SELECTOR_FIELDS.map((f) => [f.key, draft[f.key].trim() ? validateSelector(draft[f.key].trim()) : null]));
  const invalid = Object.values(problems).some(Boolean);
  const settleSeconds = Math.round(draft.settleMs / 1000);
  const waitMinutes = Math.round(draft.maxWaitMs / 60_000);
  const customised = JSON.stringify(state.ext.adapter) !== JSON.stringify(DEFAULT_ARENA_ADAPTER_CONFIG);

  return (
    <form
      class="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        setSaving(true);
        void store.saveAdapter(draft).finally(() => setSaving(false));
      }}
    >
      <p class="set__text">
        AgentLink finds Arena's message box, send button and replies by their role on the page. If Arena changes its layout and the test below fails, give the CSS selectors here. Empty means automatic.
      </p>
      {SELECTOR_FIELDS.map((field) => (
        <div class="field" key={field.key}>
          <label class="label" for={`adapter-${field.key}`}>
            {field.label}
          </label>
          <input
            id={`adapter-${field.key}`}
            class="input input--mono"
            value={draft[field.key]}
            spellcheck={false}
            autocomplete="off"
            placeholder="automatic"
            aria-invalid={problems[field.key] ? 'true' : undefined}
            onInput={(e) => setDraft({ ...draft, [field.key]: (e.currentTarget as HTMLInputElement).value })}
          />
          <p class={problems[field.key] ? 'field__hint field__hint--bad' : 'field__hint'}>{problems[field.key] ?? field.hint}</p>
        </div>
      ))}
      <div class="field-pair">
        <div class="field">
          <label class="label" for="adapter-settle">
            Quiet time, seconds
          </label>
          <input
            id="adapter-settle"
            class="input input--mono"
            type="number"
            min={2}
            max={600}
            value={settleSeconds}
            onInput={(e) => setDraft({ ...draft, settleMs: (Number((e.currentTarget as HTMLInputElement).value) || 0) * 1000 })}
          />
          <p class="field__hint">Arena ends each report with a completion line. When that line is missing, the reply counts as finished after the page has stopped changing for this long.</p>
        </div>
        <div class="field">
          <label class="label" for="adapter-wait">
            Longest silence, minutes
          </label>
          <input
            id="adapter-wait"
            class="input input--mono"
            type="number"
            min={1}
            max={360}
            value={waitMinutes}
            onInput={(e) => setDraft({ ...draft, maxWaitMs: (Number((e.currentTarget as HTMLInputElement).value) || 0) * 60_000 })}
          />
          <p class="field__hint">If Arena still shows that it is working but nothing has changed for this long, AgentLink hands Gemini what is there, marked as possibly incomplete.</p>
        </div>
      </div>
      <div class="button-row">
        <Button variant="primary" type="submit" busy={saving} disabled={invalid}>
          Save adapter settings
        </Button>
        {customised && (
          <Button
            onClick={() => {
              setDraft(DEFAULT_ARENA_ADAPTER_CONFIG);
              void store.saveAdapter(DEFAULT_ARENA_ADAPTER_CONFIG);
            }}
          >
            Back to automatic
          </Button>
        )}
      </div>
    </form>
  );
}

function ArenaSection({ state }: { state: WorkspaceState }): VNode {
  const { arenaTabs, arenaError, arenaTest, busy } = state;
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    void store.refreshArena();
  }, []);
  const chosen = arenaTabs?.find((t) => t.preferred);
  const remembered = state.ext.preferredTab;

  return (
    <section class="set" id="settings-arena">
      <div class="set__head">
        <h3 class="set__title">Arena</h3>
        <Button small variant="quiet" busy={busy['arena:tabs']} busyLabel="Looking…" onClick={() => void store.refreshArena()}>
          Refresh tabs
        </Button>
      </div>

      {arenaError && (
        <p class="note note--bad" role="alert">
          {arenaError}
        </p>
      )}
      {arenaTabs && arenaTabs.length === 0 && (
        <p class="set__text">No Arena tab is open in this browser. Open Arena, sign in, start an Agent Mode conversation, then refresh.</p>
      )}
      {remembered && arenaTabs && arenaTabs.length > 0 && !chosen && (
        <p class="note note--warn">The tab you chose before ("{remembered.title || remembered.url}") is no longer open. Choose another.</p>
      )}

      {arenaTabs && arenaTabs.length > 0 && (
        <ul class="tabs" role="radiogroup" aria-label="Arena tab to use">
          {arenaTabs.map((tab) => {
            const page = tab.page;
            const problem = !page ? (tab.error ?? 'The page did not answer. Reload the tab.') : !page.composerFound ? 'No message box found on this page.' : page.agentMode === false ? 'This tab does not appear to be in Agent Mode.' : null;
            return (
              <li class={`tab${tab.preferred ? ' is-chosen' : ''}`} key={tab.tabId}>
                <label class="tab__pick">
                  <input type="radio" name="arena-tab" checked={tab.preferred} disabled={busy['arena:prefer']} onChange={() => void store.setPreferredTab(tab.tabId)} />
                  <span class="tab__body">
                    <span class="tab__title">{tab.title || 'Untitled tab'}</span>
                    <span class="tab__url mono">{tab.url}</span>
                    <span class="tab__state">
                      {problem ? <Tag tone={page ? 'warn' : 'bad'}>{problem}</Tag> : <Tag tone={page?.busy ? 'busy' : 'ok'}>{page?.busy ? 'Arena is working' : 'Ready'}</Tag>}
                      {page?.agentMode === null && !problem && <span class="faint">Agent Mode could not be confirmed from the page.</span>}
                    </span>
                  </span>
                </label>
                <Button small busy={busy['arena:test']} onClick={() => void store.testArena(tab.tabId)}>
                  Test
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {arenaTabs && arenaTabs.length > 0 && (
        <div class="button-row">
          <Button busy={busy['arena:test']} busyLabel="Testing…" onClick={() => void store.testArena()}>
            Test Arena connection
          </Button>
          <Button variant="quiet" busy={busy['arena:focus']} onClick={() => void store.focusArena()}>
            Go to Arena tab
          </Button>
          {chosen && arenaTabs.length > 1 && (
            <Button variant="quiet" onClick={() => void store.setPreferredTab(null)}>
              Clear choice
            </Button>
          )}
        </div>
      )}
      {arenaTabs && arenaTabs.length > 1 && !chosen && <p class="field__hint">With several Arena tabs open, AgentLink sends nothing until you choose one.</p>}

      {arenaTest && (
        <div class={`test test--${arenaTest.ok ? 'ok' : 'bad'}`} role="status">
          <p class="test__head">{arenaTest.message}</p>
          <ul class="test__checks">
            {arenaTest.checks.map((check, i) => (
              <li class={check.ok ? 'check check--ok' : 'check check--bad'} key={i}>
                <span class="check__mark" aria-hidden="true">
                  {check.ok ? '✓' : '✕'}
                </span>
                <span class="check__label">{check.label}</span>
                <span class="check__detail">{check.detail}</span>
              </li>
            ))}
          </ul>
          <p class="field__hint">The test only reads the page. It does not type or send anything.</p>
        </div>
      )}

      <button type="button" class="disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        <span class="disclosure__mark" aria-hidden="true">
          {advanced ? '−' : '+'}
        </span>
        Page adapter settings
      </button>
      {advanced && <AdapterForm state={state} />}
    </section>
  );
}

// ------------------------------------------------------------------ drawer ---

export function SettingsDrawer({ state, section, onClose }: { state: WorkspaceState; section: SettingsSection | null; onClose: () => void }): VNode {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const target = section ? panel.current?.querySelector<HTMLElement>(`#settings-${section}`) : null;
    target?.scrollIntoView({ block: 'start' });
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  return (
    <div class="drawer" role="presentation">
      <div class="drawer__scrim" onClick={onClose} />
      <div class="drawer__panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={panel}>
        <header class="drawer__head">
          <h2 id="settings-title" class="drawer__title">
            Settings
          </h2>
          <Button small variant="quiet" onClick={onClose}>
            Close
          </Button>
        </header>
        <div class="drawer__body">
          <CompanionSection state={state} />
          <GeminiSection state={state} />
          <ArenaSection state={state} />
        </div>
      </div>
    </div>
  );
}
