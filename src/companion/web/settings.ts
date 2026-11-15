/**
 * The companion's own settings page. It is the only place a Gemini API key is
 * ever typed: the page is served by the companion on the loopback address and
 * talks only to it, so the key never passes through extension code.
 */
import type { ApiErrorBody, CredentialStatusResponse, ModelsResponse, StatusResponse } from '../../shared/api.js';
import { API_PREFIX } from '../../shared/api.js';
import { describeGemini, formatTime, type Tone } from '../../shared/statusText.js';
import type { CompanionSettings, GeminiModelInfo, GeminiStatus } from '../../shared/types.js';

const TOKEN_STORAGE_KEY = 'agentlink.pairingToken';
const CUSTOM_MODEL = '__custom__';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let token = '';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'offline', 'The companion is not responding. Check that it is still running in your terminal.');
  }
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'error', error?.message ?? `Request failed (${response.status}).`);
  }
  return data as T;
}

// ------------------------------------------------------------------ token ---

/** Takes the token from the link fragment once, then removes it from the address bar and history entry. */
function readToken(): string {
  const match = /(?:^|[#&])token=([^&]+)/.exec(window.location.hash);
  if (match?.[1]) {
    const value = decodeURIComponent(match[1]);
    sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    history.replaceState(null, '', window.location.pathname);
    return value;
  }
  return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
}

// ---------------------------------------------------------------- helpers ---

function setNote(el: HTMLElement, tone: 'ok' | 'bad' | 'warn' | 'plain' | null, text = ''): void {
  el.hidden = tone === null;
  el.className = tone === null || tone === 'plain' ? 'note' : `note note--${tone}`;
  el.textContent = text;
}

function setFacts(list: HTMLElement, facts: [string, string, ('ok' | 'bad' | 'warn')?][]): void {
  list.replaceChildren();
  for (const [name, value, state] of facts) {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (state) dd.dataset.state = state;
    list.append(dt, dd);
  }
}

function toneState(tone: Tone): 'ok' | 'bad' | 'warn' | undefined {
  if (tone === 'ok') return 'ok';
  if (tone === 'bad') return 'bad';
  if (tone === 'warn' || tone === 'busy') return 'warn';
  return undefined;
}

async function withBusy<T>(button: HTMLButtonElement, busyText: string, work: () => Promise<T>): Promise<T> {
  const label = button.textContent ?? '';
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

// ------------------------------------------------------------------- state ---

let gemini: GeminiStatus | null = null;
let settings: CompanionSettings | null = null;
let models: GeminiModelInfo[] = [];

function renderGemini(): void {
  if (!gemini) return;
  const text = describeGemini(gemini);
  byId('gemini-dot').className = `dot dot--${text.tone}`;
  byId('gemini-chip-text').textContent = `Gemini · ${text.label}`;

  const stateEl = byId('key-state');
  stateEl.textContent = text.label;
  const state = toneState(text.tone);
  if (state) stateEl.dataset.state = state;
  else delete stateEl.dataset.state;

  const source =
    gemini.keySource === 'saved'
      ? 'Saved on this computer'
      : gemini.keySource === 'environment'
        ? 'GEMINI_API_KEY environment variable'
        : 'None';
  setFacts(byId('key-facts'), [
    ['Status', text.detail, state],
    ['Key source', source],
    ['Key fingerprint', gemini.keyFingerprint ?? '—'],
    ['Model', gemini.model],
    ['Last checked', formatTime(gemini.lastCheckedAt)],
    ['Last success', formatTime(gemini.lastOkAt)],
  ]);

  byId('key-label').textContent = gemini.keySource === 'saved' ? 'Replace API key' : 'Enter API key';
  byId<HTMLButtonElement>('key-save').textContent = gemini.keySource === 'saved' ? 'Update and test' : 'Save and test';
  byId<HTMLButtonElement>('key-test').disabled = !gemini.keyConfigured;
  const remove = byId<HTMLButtonElement>('key-remove');
  remove.hidden = gemini.keySource !== 'saved';
}

function renderModels(): void {
  if (!settings) return;
  const select = byId<HTMLSelectElement>('model-select');
  const current = settings.model;
  select.replaceChildren();
  const known = models.some((m) => m.id === current);
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.displayName && model.displayName !== model.id ? `${model.displayName} — ${model.id}` : model.id;
    select.append(option);
  }
  if (!known) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = models.length > 0 ? `${current} — not in the list for this key` : current;
    select.prepend(option);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_MODEL;
  custom.textContent = 'Other model ID…';
  select.append(custom);
  select.value = current;
  byId<HTMLSelectElement>('thinking-select').value = settings.thinkingLevel;
  renderModelDetail();
}

function renderModelDetail(): void {
  const select = byId<HTMLSelectElement>('model-select');
  const isCustom = select.value === CUSTOM_MODEL;
  byId('custom-model-field').hidden = !isCustom;
  const model = models.find((m) => m.id === select.value);
  const parts: string[] = [];
  if (model?.inputTokenLimit) parts.push(`${model.inputTokenLimit.toLocaleString()} input tokens`);
  if (model?.outputTokenLimit) parts.push(`${model.outputTokenLimit.toLocaleString()} output tokens`);
  byId('model-detail').textContent = isCustom ? '' : parts.join(' · ');
}

function renderLimits(): void {
  if (!settings) return;
  byId<HTMLInputElement>('limit-tasks').value = String(settings.maxTasksPerSession);
  byId<HTMLInputElement>('limit-rounds').value = String(settings.maxToolRounds);
  byId<HTMLInputElement>('limit-retries').value = String(settings.maxRetries);
  byId<HTMLInputElement>('limit-first').value = String(Math.round(settings.firstChunkTimeoutMs / 1000));
  byId<HTMLInputElement>('limit-idle').value = String(Math.round(settings.idleTimeoutMs / 1000));
  byId<HTMLInputElement>('limit-total').value = String(Math.round(settings.totalTimeoutMs / 1000));
}

async function loadModels(force: boolean): Promise<void> {
  const message = byId('model-message');
  if (!gemini?.keyConfigured) {
    models = [];
    renderModels();
    setNote(message, 'plain', 'Add an API key to load the list of models available to it.');
    return;
  }
  try {
    const result = await api<ModelsResponse>('GET', `/gemini/models${force ? '?refresh=1' : ''}`);
    models = result.models;
    renderModels();
    if (result.currentAvailable) setNote(message, null);
    else setNote(message, 'warn', `The Gemini API does not list "${result.current}" for this key. Requests may fail until you pick a listed model.`);
  } catch (error) {
    models = [];
    renderModels();
    setNote(message, 'bad', `The model list could not be loaded: ${describeError(error)}`);
  }
}

async function loadAll(): Promise<void> {
  const status = await api<StatusResponse>('GET', '/status');
  gemini = status.gemini;
  settings = status.settings;
  renderGemini();
  renderLimits();
  renderModels();
  setFacts(byId('about-facts'), [
    ['Version', status.version],
    ['Address', window.location.origin],
    ['Data directory', status.dataDir],
  ]);
  await loadModels(false);
}

// ------------------------------------------------------------------ wiring ---

function wire(): void {
  const keyInput = byId<HTMLInputElement>('key-input');
  const keyMessage = byId('key-message');

  byId('key-reveal').addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(show));
  });

  byId<HTMLFormElement>('key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      setNote(keyMessage, 'bad', 'Paste an API key first.');
      keyInput.focus();
      return;
    }
    void withBusy(byId<HTMLButtonElement>('key-save'), 'Testing…', async () => {
      try {
        const result = await api<CredentialStatusResponse>('PUT', '/credentials', { apiKey });
        gemini = result.gemini;
        // The key is not kept in the page once the companion has it.
        keyInput.value = '';
        keyInput.type = 'password';
        byId('key-reveal').textContent = 'Show';
        byId('key-reveal').setAttribute('aria-pressed', 'false');
        renderGemini();
        const text = describeGemini(result.gemini);
        if (result.gemini.state === 'connected') setNote(keyMessage, 'ok', `Key saved. ${text.detail}`);
        else setNote(keyMessage, text.tone === 'warn' ? 'warn' : 'bad', `Key saved, but the test did not pass. ${text.detail}`);
        await loadModels(true);
      } catch (error) {
        setNote(keyMessage, 'bad', describeError(error));
      }
    });
  });

  byId('key-test').addEventListener('click', (event) => {
    void withBusy(event.currentTarget as HTMLButtonElement, 'Testing…', async () => {
      try {
        const result = await api<CredentialStatusResponse>('POST', '/gemini/test');
        gemini = result.gemini;
        renderGemini();
        const text = describeGemini(result.gemini);
        setNote(keyMessage, result.gemini.state === 'connected' ? 'ok' : text.tone === 'warn' ? 'warn' : 'bad', text.detail);
      } catch (error) {
        setNote(keyMessage, 'bad', describeError(error));
      }
    });
  });

  byId('key-remove').addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.dataset.armed !== 'true') {
      // Two-step confirmation without a blocking dialog.
      button.dataset.armed = 'true';
      button.textContent = 'Click again to remove';
      window.setTimeout(() => {
        button.dataset.armed = 'false';
        button.textContent = 'Remove saved key';
      }, 4000);
      return;
    }
    button.dataset.armed = 'false';
    button.textContent = 'Remove saved key';
    void withBusy(button, 'Removing…', async () => {
      try {
        const result = await api<CredentialStatusResponse>('DELETE', '/credentials');
        gemini = result.gemini;
        renderGemini();
        setNote(
          keyMessage,
          'plain',
          result.gemini.keyConfigured ? 'Saved key removed. The key from the GEMINI_API_KEY environment variable is now in use.' : 'Saved key removed. Gemini is not configured until you add a key.',
        );
        await loadModels(true);
      } catch (error) {
        setNote(keyMessage, 'bad', describeError(error));
      }
    });
  });

  byId('model-select').addEventListener('change', renderModelDetail);
  byId('model-refresh').addEventListener('click', (event) => {
    void withBusy(event.currentTarget as HTMLButtonElement, 'Refreshing…', () => loadModels(true));
  });

  byId<HTMLFormElement>('model-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const select = byId<HTMLSelectElement>('model-select');
    const model = select.value === CUSTOM_MODEL ? byId<HTMLInputElement>('model-custom').value.trim() : select.value;
    const thinkingLevel = byId<HTMLSelectElement>('thinking-select').value;
    const message = byId('model-message');
    if (!model) {
      setNote(message, 'bad', 'Enter a model ID.');
      return;
    }
    void withBusy(byId<HTMLButtonElement>('model-save'), 'Saving…', async () => {
      try {
        const saved = await api<{ settings: CompanionSettings; gemini: GeminiStatus }>('PATCH', '/settings', { model, thinkingLevel });
        settings = saved.settings;
        gemini = saved.gemini;
        if (gemini.keyConfigured) {
          const tested = await api<CredentialStatusResponse>('POST', '/gemini/test');
          gemini = tested.gemini;
        }
        renderGemini();
        renderModels();
        const text = describeGemini(gemini);
        if (gemini.state === 'connected') setNote(message, 'ok', `Saved. ${text.detail}`);
        else if (!gemini.keyConfigured) setNote(message, 'plain', 'Saved. It will be tested once an API key is configured.');
        else setNote(message, text.tone === 'warn' ? 'warn' : 'bad', `Saved, but the test did not pass. ${text.detail}`);
      } catch (error) {
        setNote(message, 'bad', describeError(error));
      }
    });
  });

  byId<HTMLFormElement>('limits-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const number = (id: string): number => Number(byId<HTMLInputElement>(id).value);
    const message = byId('limits-message');
    void withBusy(byId<HTMLButtonElement>('limits-save'), 'Saving…', async () => {
      try {
        const saved = await api<{ settings: CompanionSettings }>('PATCH', '/settings', {
          maxTasksPerSession: number('limit-tasks'),
          maxToolRounds: number('limit-rounds'),
          maxRetries: number('limit-retries'),
          firstChunkTimeoutMs: number('limit-first') * 1000,
          idleTimeoutMs: number('limit-idle') * 1000,
          totalTimeoutMs: number('limit-total') * 1000,
        });
        settings = saved.settings;
        renderLimits();
        setNote(message, 'ok', 'Limits saved.');
      } catch (error) {
        setNote(message, 'bad', describeError(error));
      }
    });
  });
}

async function unlock(): Promise<void> {
  const locked = byId('locked');
  const content = byId('content');
  const tokenError = byId('token-error');
  if (!token) {
    locked.hidden = false;
    content.hidden = true;
    byId('gemini-chip-text').textContent = 'Locked';
    return;
  }
  try {
    await loadAll();
    locked.hidden = true;
    content.hidden = false;
  } catch (error) {
    content.hidden = true;
    locked.hidden = false;
    byId('gemini-chip-text').textContent = 'Locked';
    if (error instanceof ApiError && error.status === 401) {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      token = '';
      setNote(tokenError, 'bad', 'That pairing token was not accepted. Use the link or token printed by the companion that is running now.');
    } else {
      setNote(tokenError, 'bad', describeError(error));
    }
  }
}

function start(): void {
  token = readToken();
  wire();
  byId<HTMLFormElement>('token-form').addEventListener('submit', (event) => {
    event.preventDefault();
    token = byId<HTMLInputElement>('token-input').value.trim();
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    byId<HTMLInputElement>('token-input').value = '';
    void unlock();
  });
  void unlock();
  // Keep the indicator honest if the status changes elsewhere (for example a failed request in a session).
  window.setInterval(() => {
    if (!token || document.hidden) return;
    api<CredentialStatusResponse>('GET', '/credentials')
      .then((result) => {
        gemini = result.gemini;
        renderGemini();
      })
      .catch(() => {
        byId('gemini-dot').className = 'dot dot--bad';
        byId('gemini-chip-text').textContent = 'Companion offline';
      });
  }, 10_000);
}

start();
