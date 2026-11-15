import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { API_PREFIX, COMPANION_NAME, type ApiErrorBody, type CompanionEvent, type HealthResponse, type ModelsResponse, type StatusResponse } from '../../shared/api.js';
import type { CompanionConfig } from '../config.js';
import { CredentialError, type CredentialStore } from '../credentials/credentialStore.js';
import { GeminiError } from '../gemini/errors.js';
import type { GeminiService } from '../gemini/geminiService.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../orchestration/eventBus.js';
import { OrchestratorError, type Orchestrator } from '../orchestration/orchestrator.js';
import { SettingsError, type SettingsStore } from '../settingsStore.js';
import { bearerToken, classifyOrigin, isAllowedHost, tokensMatch, type OriginKind } from './security.js';

export interface ServerDeps {
  config: CompanionConfig;
  version: string;
  token: string;
  credentials: CredentialStore;
  settings: SettingsStore;
  gemini: GeminiService;
  orchestrator: Orchestrator;
  bus: EventBus;
  logger: Logger;
  /** Directory with the built settings page (settings.html/.css/.js). */
  webDir: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  origin: OriginKind;
  params: Record<string, string>;
  body: () => Promise<Record<string, unknown>>;
}

type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const NO_CONTENT = Symbol('no-content');
const HANDLED = Symbol('handled');

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/settings': { file: 'settings.html', type: 'text/html; charset=utf-8' },
  '/settings.css': { file: 'settings.css', type: 'text/css; charset=utf-8' },
  '/settings.js': { file: 'settings.js', type: 'text/javascript; charset=utf-8' },
};

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Bundled UI fonts. The name is matched strictly, so this can never be used to read other files. */
const FONT_PATH = /^\/fonts\/([a-z0-9-]+\.woff2)$/;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) {
      // Requiring JSON keeps "simple" cross-site form posts from ever being parsed.
      reject(new HttpError(415, 'unsupported_media_type', 'Request bodies must be application/json.'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'payload_too_large', 'The request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'invalid_json', 'The request body must be a JSON object.'));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'The request body is not valid JSON.'));
      }
    });
  });
}

/** The local HTTP API used by the extension and by the companion's own settings page. */
export class CompanionServer {
  private readonly server: Server;
  private readonly routes: Route[] = [];
  private readonly streams = new Set<ServerResponse>();
  private port: number;

  constructor(private readonly deps: ServerDeps) {
    this.port = deps.config.port;
    this.registerRoutes();
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.keepAliveTimeout = 65_000;
  }

  get address(): string {
    return `http://${this.deps.config.host}:${this.port}`;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.deps.config.port, this.deps.config.host, () => {
        this.server.off('error', onError);
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  // --------------------------------------------------------------- routing ---

  private route(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const source = path.replace(/:([A-Za-z]+)/g, (_m, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${API_PREFIX}${source}$`), keys, handler });
  }

  private registerRoutes(): void {
    const { credentials, settings, gemini, orchestrator, config, version } = this.deps;

    this.route('GET', '/status', (): StatusResponse => ({
      version,
      gemini: gemini.status(),
      settings: settings.get(),
      activeProjectId: orchestrator.listProjects().activeProjectId,
      dataDir: config.dataDir,
    }));

    this.route('GET', '/events', (ctx) => this.openEventStream(ctx));

    // ---- credentials. The key goes in; it never comes back out. ----
    this.route('GET', '/credentials', () => ({ gemini: gemini.status() }));
    this.route('PUT', '/credentials', async (ctx) => {
      this.requireKeyEntryOrigin(ctx);
      const body = await ctx.body();
      credentials.save(body.apiKey);
      gemini.refresh();
      return { gemini: await gemini.testConnection() };
    });
    this.route('DELETE', '/credentials', (ctx) => {
      this.requireKeyEntryOrigin(ctx);
      credentials.clear();
      const status = gemini.refresh();
      if (status.keyConfigured) void gemini.testConnection();
      return { gemini: gemini.status() };
    });

    // ---- gemini ----
    this.route('POST', '/gemini/test', async () => ({ gemini: await gemini.testConnection() }));
    this.route('GET', '/gemini/models', async (ctx): Promise<ModelsResponse> => {
      const models = await gemini.listModels({ force: ctx.url.searchParams.get('refresh') === '1' });
      const current = settings.get().model;
      return { models, current, currentAvailable: models.some((m) => m.id === current) };
    });
    this.route('PATCH', '/settings', async (ctx) => {
      const before = settings.get();
      const next = settings.update(await ctx.body());
      this.deps.bus.emit({ type: 'settings', settings: next });
      if (next.model !== before.model) {
        gemini.refresh();
        if (gemini.status().keyConfigured) void gemini.testConnection();
      }
      return { settings: next, gemini: gemini.status() };
    });

    // ---- projects ----
    this.route('GET', '/projects', () => orchestrator.listProjects());
    this.route('POST', '/projects', async (ctx) => {
      const body = await ctx.body();
      return orchestrator.createProject({
        name: body.name as string,
        objective: body.objective as string,
        instructions: body.instructions as string | undefined,
        constraints: body.constraints as string[] | undefined,
      });
    });
    this.route('GET', '/projects/:id', (ctx) => orchestrator.getProject(ctx.params.id as string));
    this.route('PATCH', '/projects/:id', async (ctx) => orchestrator.updateProject(ctx.params.id as string, await ctx.body()));
    this.route('DELETE', '/projects/:id', (ctx) => {
      orchestrator.deleteProject(ctx.params.id as string);
      return NO_CONTENT;
    });
    this.route('POST', '/projects/:id/activate', (ctx) => orchestrator.activateProject(ctx.params.id as string));
    this.route('POST', '/projects/:id/messages', async (ctx) => {
      const body = await ctx.body();
      const { entry } = orchestrator.sendMessage(ctx.params.id as string, body.text);
      ctx.res.statusCode = 202;
      return { entry };
    });
    this.route('POST', '/projects/:id/session', async (ctx) => {
      const body = await ctx.body();
      return orchestrator.controlSession(ctx.params.id as string, body.action as never);
    });
    this.route('POST', '/projects/:id/cancel-turn', (ctx) => orchestrator.cancelTurn(ctx.params.id as string));

    // ---- tasks ----
    const task = (handler: (projectId: string, taskId: string, ctx: RequestContext) => Promise<unknown> | unknown): Handler => {
      return (ctx) => handler(ctx.params.id as string, ctx.params.taskId as string, ctx);
    };
    this.route('GET', '/projects/:id/tasks/:taskId', task((p, t) => ({ task: orchestrator.getTask(p, t) })));
    this.route('PATCH', '/projects/:id/tasks/:taskId', task(async (p, t, ctx) => ({ task: orchestrator.editTask(p, t, await ctx.body()) })));
    this.route('POST', '/projects/:id/tasks/:taskId/approve', task((p, t) => ({ task: orchestrator.approveTask(p, t) })));
    this.route('POST', '/projects/:id/tasks/:taskId/reject', task(async (p, t, ctx) => ({ task: orchestrator.rejectTask(p, t, (await ctx.body()).reason) })));
    this.route('POST', '/projects/:id/tasks/:taskId/cancel', task((p, t) => ({ task: orchestrator.cancelTask(p, t) })));
    this.route('POST', '/projects/:id/tasks/:taskId/evaluate', task((p, t) => ({ task: orchestrator.retryEvaluation(p, t) })));
    this.route('POST', '/projects/:id/tasks/:taskId/dispatch/claim', task(async (p, t, ctx) => orchestrator.claimDispatch(p, t, await ctx.body())));
    this.route('POST', '/projects/:id/tasks/:taskId/dispatch/confirm', task(async (p, t, ctx) => ({ task: orchestrator.confirmDispatch(p, t, (await ctx.body()).dispatchId) })));
    this.route('POST', '/projects/:id/tasks/:taskId/dispatch/fail', task(async (p, t, ctx) => {
      const body = await ctx.body();
      return {
        task: orchestrator.failDispatch(p, t, {
          dispatchId: body.dispatchId as string,
          error: body.error as string,
          submitted: body.submitted === false ? false : 'unknown',
        }),
      };
    }));
    this.route('POST', '/projects/:id/tasks/:taskId/dispatch/reset', task((p, t) => ({ task: orchestrator.resetDispatch(p, t) })));
    this.route('POST', '/projects/:id/tasks/:taskId/arena-response', task(async (p, t, ctx) => {
      const body = await ctx.body();
      return {
        task: orchestrator.recordArenaResponse(p, t, {
          dispatchId: (body.dispatchId as string | null | undefined) ?? null,
          text: body.text as string,
          source: body.source as never,
        }),
      };
    }));
  }

  /**
   * A Gemini key may only be submitted from the companion's own settings page
   * (or a local tool with no Origin). Browser-extension pages are refused, so
   * extension JavaScript can never be the path a key travels through.
   */
  private requireKeyEntryOrigin(ctx: RequestContext): void {
    if (ctx.origin !== 'self' && ctx.origin !== 'none') {
      throw new HttpError(403, 'forbidden_origin', 'API keys can only be changed from the AgentLink companion settings page.');
    }
  }

  // -------------------------------------------------------------- handling ---

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { config, logger } = this.deps;
    const started = Date.now();
    let path = req.url ?? '/';
    try {
      if (!isAllowedHost(req.headers.host, this.port)) {
        throw new HttpError(403, 'forbidden_host', 'This service only answers on its loopback address.');
      }
      const url = new URL(req.url ?? '/', this.address);
      path = url.pathname;
      const originHeader = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
      const origin = classifyOrigin(originHeader, this.port, config.extraAllowedOrigins);
      if (origin === 'foreign') throw new HttpError(403, 'forbidden_origin', 'This origin may not use the AgentLink companion.');

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (originHeader && origin !== 'none') {
        res.setHeader('Access-Control-Allow-Origin', originHeader);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      if (!path.startsWith(`${API_PREFIX}/`)) {
        this.serveStatic(method, path, res);
        return;
      }

      if (path === `${API_PREFIX}/health` && method === 'GET') {
        const body: HealthResponse = { ok: true, name: COMPANION_NAME, version: this.deps.version };
        this.sendJson(res, 200, body);
        return;
      }

      if (!tokensMatch(this.deps.token, bearerToken(req.headers.authorization))) {
        throw new HttpError(401, 'unauthorized', 'Missing or wrong pairing token.');
      }

      let pathMatched = false;
      for (const route of this.routes) {
        const match = route.pattern.exec(path);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1] ?? '');
        });
        let cached: Promise<Record<string, unknown>> | null = null;
        const result = await route.handler({ req, res, url, origin, params, body: () => (cached ??= readBody(req)) });
        if (result === HANDLED) return;
        if (result === NO_CONTENT) {
          res.writeHead(204).end();
          return;
        }
        this.sendJson(res, res.statusCode === 202 ? 202 : 200, result);
        logger.debug(`${method} ${path} → ${res.statusCode} (${Date.now() - started} ms)`);
        return;
      }
      throw pathMatched ? new HttpError(405, 'method_not_allowed', `${method} is not supported here.`) : new HttpError(404, 'not_found', 'Unknown endpoint.');
    } catch (error) {
      this.sendError(res, error, `${req.method ?? ''} ${path}`);
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  private sendError(res: ServerResponse, error: unknown, what: string): void {
    let status = 500;
    let code = 'internal_error';
    let message = 'Unexpected error.';
    if (error instanceof HttpError) {
      ({ status, code, message } = error);
    } else if (error instanceof OrchestratorError) {
      status = error.httpStatus;
      code = error.code;
      message = error.message;
    } else if (error instanceof CredentialError || error instanceof SettingsError) {
      status = 400;
      code = 'invalid_request';
      message = error.message;
    } else if (error instanceof GeminiError) {
      status = error.kind === 'no_key' ? 409 : 502;
      code = `gemini_${error.kind}`;
      message = error.message;
    } else {
      this.deps.logger.error(`Unhandled error in ${what}:`, error);
    }
    const body: ApiErrorBody = { error: { code, message } };
    this.sendJson(res, status, body);
  }

  private serveStatic(method: string, path: string, res: ServerResponse): void {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Only GET is supported here.');
    if (path === '/' || path === '') {
      res.writeHead(302, { Location: '/settings' }).end();
      return;
    }
    const font = FONT_PATH.exec(path);
    const entry = font ? { file: join('fonts', font[1] as string), type: 'font/woff2' } : STATIC_FILES[path];
    if (!entry) throw new HttpError(404, 'not_found', 'Unknown page.');
    const file = join(this.deps.webDir, entry.file);
    if (!existsSync(file)) throw new HttpError(404, 'not_found', 'The settings page has not been built. Run "npm run build".');
    const content = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Length': content.length,
      'Content-Security-Policy': PAGE_CSP,
      'X-Frame-Options': 'DENY',
    });
    res.end(method === 'HEAD' ? undefined : content);
  }

  /** Server-sent events: live coordinator output and state changes. */
  private openEventStream(ctx: RequestContext): typeof HANDLED {
    const { res, req } = ctx;
    const projectId = ctx.url.searchParams.get('projectId');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: CompanionEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'hello', version: this.deps.version });
    send({ type: 'gemini', status: this.deps.gemini.status() });

    const unsubscribe = this.deps.bus.subscribe((event) => {
      if ('projectId' in event && projectId && event.projectId !== projectId) return;
      send(event);
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    this.streams.add(res);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return HANDLED;
  }
}
