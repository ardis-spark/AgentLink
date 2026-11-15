import {
  API_PREFIX,
  COMPANION_NAME,
  type ApiErrorBody,
  type ArenaResponseRequest,
  type ClaimDispatchRequest,
  type ClaimDispatchResponse,
  type CompanionEvent,
  type CreateProjectRequest,
  type CredentialStatusResponse,
  type DispatchFailureRequest,
  type HealthResponse,
  type ModelsResponse,
  type NoResponseRequest,
  type ProjectListResponse,
  type ProjectResponse,
  type RelayReportRequest,
  type RelayWorkResponse,
  type ResetDispatchRequest,
  type SessionAction,
  type StatusResponse,
  type TaskResponse,
  type UpdateProjectRequest,
} from '../../shared/api.js';
import type { CompanionSettings, ConversationEntry, GeminiStatus } from '../../shared/types.js';
import { createSseParser } from './sse.js';

export type CompanionErrorCode = 'offline' | 'unpaired' | 'unauthorized' | 'not_agentlink' | string;

export class CompanionError extends Error {
  constructor(
    readonly status: number,
    readonly code: CompanionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompanionError';
  }
}

export interface CompanionEndpoint {
  url: string;
  token: string;
}

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface EventStreamOptions {
  projectId?: string | null;
  onEvent: (event: CompanionEvent) => void;
  onState: (state: StreamState, error: CompanionError | null) => void;
}

const OFFLINE_MESSAGE = 'The AgentLink companion is not running. Start it with "npm start" in the AgentLink folder.';

/**
 * Typed client for the local companion. It carries the pairing token and
 * nothing else; the companion never returns the Gemini key, so this code
 * cannot see it.
 */
const HEALTH_TIMEOUT_MS = 5_000;

export class CompanionClient {
  constructor(
    private readonly endpoint: () => CompanionEndpoint,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, authenticated = true, timeoutMs?: number): Promise<T> {
    const { url, token } = this.endpoint();
    if (authenticated && !token) {
      throw new CompanionError(0, 'unpaired', 'AgentLink is not paired with the companion yet. Paste the pairing token in Settings.');
    }
    const headers: Record<string, string> = {};
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${url}${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CompanionError(0, 'offline', OFFLINE_MESSAGE);
    }
    if (response.status === 204) return undefined as T;
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (data as ApiErrorBody | null)?.error;
      if (response.status === 401) {
        throw new CompanionError(401, 'unauthorized', 'The companion rejected the pairing token. Paste the token printed by the running companion in Settings.');
      }
      throw new CompanionError(response.status, error?.code ?? 'error', error?.message ?? `The companion answered with status ${response.status}.`);
    }
    return data as T;
  }

  /** Checks that something is listening and that it really is the AgentLink companion. */
  async health(): Promise<HealthResponse> {
    const foreign = new CompanionError(0, 'not_agentlink', 'Something else is answering on the companion address. Check the address in Settings.');
    let result: HealthResponse | null;
    try {
      // A loopback service answers at once; without a limit an unreachable address would leave the UI waiting.
      result = await this.request<HealthResponse | null>('GET', '/health', undefined, false, HEALTH_TIMEOUT_MS);
    } catch (error) {
      // The companion's health check never fails; any answer other than "nobody home" is another program.
      if (error instanceof CompanionError && error.code === 'offline') throw error;
      throw foreign;
    }
    if (!result || result.name !== COMPANION_NAME) throw foreign;
    return result;
  }

  status(): Promise<StatusResponse> {
    return this.request('GET', '/status');
  }
  testGemini(): Promise<CredentialStatusResponse> {
    return this.request('POST', '/gemini/test');
  }
  models(refresh = false): Promise<ModelsResponse> {
    return this.request('GET', `/gemini/models${refresh ? '?refresh=1' : ''}`);
  }
  updateSettings(patch: Partial<CompanionSettings>): Promise<{ settings: CompanionSettings; gemini: GeminiStatus }> {
    return this.request('PATCH', '/settings', patch);
  }

  listProjects(): Promise<ProjectListResponse> {
    return this.request('GET', '/projects');
  }
  createProject(body: CreateProjectRequest): Promise<ProjectResponse> {
    return this.request('POST', '/projects', body);
  }
  getProject(id: string): Promise<ProjectResponse> {
    return this.request('GET', `/projects/${encodeURIComponent(id)}`);
  }
  updateProject(id: string, body: UpdateProjectRequest): Promise<ProjectResponse> {
    return this.request('PATCH', `/projects/${encodeURIComponent(id)}`, body);
  }
  deleteProject(id: string): Promise<void> {
    return this.request('DELETE', `/projects/${encodeURIComponent(id)}`);
  }
  activateProject(id: string): Promise<ProjectResponse> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/activate`, {});
  }
  sendMessage(id: string, text: string): Promise<{ entry: ConversationEntry }> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/messages`, { text });
  }
  controlSession(id: string, action: SessionAction): Promise<ProjectResponse> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/session`, { action });
  }
  cancelTurn(id: string): Promise<{ cancelled: boolean }> {
    return this.request('POST', `/projects/${encodeURIComponent(id)}/cancel-turn`, {});
  }

  private taskPath(projectId: string, taskId: string, suffix = ''): string {
    return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}${suffix}`;
  }
  getTask(projectId: string, taskId: string): Promise<TaskResponse> {
    return this.request('GET', this.taskPath(projectId, taskId));
  }
  cancelTask(projectId: string, taskId: string): Promise<TaskResponse> {
    return this.request('POST', this.taskPath(projectId, taskId, '/cancel'), {});
  }
  claimDispatch(projectId: string, taskId: string, body: ClaimDispatchRequest): Promise<ClaimDispatchResponse> {
    return this.request('POST', this.taskPath(projectId, taskId, '/dispatch/claim'), body);
  }
  confirmDispatch(projectId: string, taskId: string, dispatchId: string): Promise<TaskResponse> {
    return this.request('POST', this.taskPath(projectId, taskId, '/dispatch/confirm'), { dispatchId });
  }
  failDispatch(projectId: string, taskId: string, body: DispatchFailureRequest): Promise<TaskResponse> {
    return this.request('POST', this.taskPath(projectId, taskId, '/dispatch/fail'), body);
  }
  resetDispatch(projectId: string, taskId: string, body: ResetDispatchRequest): Promise<TaskResponse> {
    return this.request('POST', this.taskPath(projectId, taskId, '/dispatch/reset'), body);
  }
  recordNoResponse(projectId: string, taskId: string, body: NoResponseRequest): Promise<TaskResponse> {
    return this.request('POST', this.taskPath(projectId, taskId, '/no-response'), body);
  }
  /** What has to be carried to Arena or fetched from it right now. Asking is also the extension's heartbeat. */
  relayWork(): Promise<RelayWorkResponse> {
    return this.request('GET', '/relay/work', undefined, true, 10_000);
  }
  reportRelay(projectId: string, taskId: string, body: RelayReportRequest): Promise<void> {
    return this.request('POST', this.taskPath(projectId, taskId, '/relay'), body, true, 10_000);
  }
  recordArenaResponse(projectId: string, taskId: string, body: ArenaResponseRequest): Promise<TaskResponse> {
    return this.request('POST', this.taskPath(projectId, taskId, '/arena-response'), body);
  }

  /**
   * Opens the live event stream and keeps it open, reconnecting with back-off.
   * `fetch` is used instead of EventSource because EventSource cannot send
   * the Authorization header.
   */
  openEvents(options: EventStreamOptions): () => void {
    let closed = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const scheduleRetry = (error: CompanionError): void => {
      if (closed) return;
      options.onState('reconnecting', error);
      // An unauthorised stream will not fix itself quickly; poll slowly until the token changes.
      const delay = error.code === 'unauthorized' || error.code === 'unpaired' ? 5_000 : Math.min(8_000, 500 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async (): Promise<void> => {
      if (closed) return;
      const { url, token } = this.endpoint();
      if (!token) {
        scheduleRetry(new CompanionError(0, 'unpaired', 'AgentLink is not paired with the companion yet.'));
        return;
      }
      controller = new AbortController();
      if (attempt === 0) options.onState('connecting', null);
      try {
        const query = options.projectId ? `?projectId=${encodeURIComponent(options.projectId)}` : '';
        const response = await this.fetchImpl(`${url}${API_PREFIX}/events${query}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal,
        });
        if (response.status === 401) throw new CompanionError(401, 'unauthorized', 'The companion rejected the pairing token.');
        if (!response.ok || !response.body) throw new CompanionError(response.status, 'error', `The event stream answered with status ${response.status}.`);

        attempt = 0;
        options.onState('open', null);
        const parser = createSseParser((data) => {
          try {
            options.onEvent(JSON.parse(data) as CompanionEvent);
          } catch {
            // A malformed frame is skipped; the next state event corrects the view.
          }
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        throw new CompanionError(0, 'offline', OFFLINE_MESSAGE);
      } catch (error) {
        if (closed) return;
        scheduleRetry(error instanceof CompanionError ? error : new CompanionError(0, 'offline', OFFLINE_MESSAGE));
      }
    };

    void connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
      options.onState('closed', null);
    };
  }
}
