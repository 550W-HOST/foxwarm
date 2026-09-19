import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ErrorCode, isInitializeRequest, ListToolsRequestSchema, McpError,
  type CallToolResult, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { authenticateMcpInboundBearer, type NormalizedMcpInboundConfig, type VerifiedMcpInboundPrincipal } from './mcpInboundConfig';
import type { HttpServer } from './httpServer';

const IDLE_MS = 15 * 60_000;
const MAX_SESSIONS = 32;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_TOOLS = 64;
const MAX_PARALLEL_REQUESTS = 4;
// Configured outbound MCP tool timeouts can be as long as one hour; preserve their SDK deadline.
const POST_DEADLINE_MS = 65 * 60_000;

/** This is not an Agent or a Foxwarm internal Session. Only an authenticated MCP transport owns it. */
export interface ExternalExecutionContext {
  readonly id: string;
  readonly externalId: string;
  /** Set synchronously when the owning transport is disposed; never reset or persisted. */
  disposed?: boolean;
  /** Bounded to Nodes used by this live context; release must reach Nodes even after record eviction. */
  externalExecNodes?: Set<string>;
  currentNode: string;
  cwd: string | null;
  selectionGeneration: number;
}

/** Trusted process-local catalog; the application registers only implemented capabilities. */
export interface McpInboundCatalog {
  listTools(context: ExternalExecutionContext, principal: VerifiedMcpInboundPrincipal): Promise<Tool[]>;
  callTool(context: ExternalExecutionContext, name: string, args: Record<string, unknown>, signal: AbortSignal, principal: VerifiedMcpInboundPrincipal): Promise<CallToolResult>;
  releaseContext?(context: ExternalExecutionContext, principal: VerifiedMcpInboundPrincipal): void | Promise<void>;
}

/** Only the trusted catalog may mark a diagnostic as safe to return to the external client. */
export class McpInboundSafeError extends Error {}

type Connection = {
  id: string;
  principal: VerifiedMcpInboundPrincipal;
  context: ExternalExecutionContext;
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  active: number;
  activePosts: number;
  activeSse?: Response;
  initialized: boolean;
  disposed: boolean;
};

function headerExactlyOnce(req: Request, name: string): string | undefined {
  if (req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length !== 1) {
    return undefined;
  }
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function sendError(res: Response, code: number, message: string): void {
  if (!res.headersSent) res.status(code).json({ error: message });
}

export class McpInboundHttpService {
  private readonly connections = new Map<string, Connection>();
  private readonly requestSignals = new AsyncLocalStorage<AbortSignal>();
  private readonly live = new Set<Connection>();
  private readonly sweep: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly config: NormalizedMcpInboundConfig,
    private readonly catalog?: McpInboundCatalog,
    private readonly idleMs: number = IDLE_MS,
    private readonly maxSessions: number = MAX_SESSIONS,
    private readonly postDeadlineMs: number = POST_DEADLINE_MS,
  ) {
    if (!config.enabled) throw new Error('Inbound MCP must be enabled before registration.');
    this.sweep = setInterval(() => this.expireIdle(), Math.min(idleMs, 60_000));
    this.sweep.unref();
  }

  register(httpServer: HttpServer): void {
    // The shared HTTP parser deliberately skips /mcp. Authenticate before parsing
    // request bytes, then bound and sanitize parser errors without changing WebUI.
    httpServer.app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
      const principal = authenticateMcpInboundBearer(this.config, headerExactlyOnce(req, 'authorization'));
      if (!principal) return sendError(res, 401, 'Unauthorized.');
      next();
    });
    httpServer.app.use('/mcp', express.json({ limit: MAX_REQUEST_BYTES }));
    httpServer.app.use('/mcp', (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const code = (error as { status?: unknown })?.status === 413 ? 413 : 400;
      sendError(res, code, code === 413 ? 'MCP request exceeds size limit.' : 'Invalid MCP request body.');
    });
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      httpServer.addRoute({ path: '/mcp', method, noAuth: true, handler: (req, res) => this.handle(req, res) });
    }
  }

  /** Close open SSE connections and fence new requests; it does not undo external effects. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.sweep);
    await Promise.allSettled([...this.live].map(connection => this.dispose(connection)));
  }

  private expireIdle(): void {
    const now = Date.now();
    for (const connection of this.live) {
      if (connection.activePosts === 0 && now - connection.lastActivity >= this.idleMs) {
        void this.dispose(connection).catch(() => {});
      }
    }
  }

  private async dispose(connection: Connection): Promise<void> {
    if (connection.disposed) return;
    connection.disposed = true;
    connection.context.disposed = true;
    this.connections.delete(connection.id);
    this.live.delete(connection);
    try { await this.catalog?.releaseContext?.(connection.context, connection.principal); }
    finally { await connection.server.close(); }
  }

  private async open(principal: VerifiedMcpInboundPrincipal): Promise<Connection> {
    const id = randomUUID();
    const context: ExternalExecutionContext = { id, externalId: principal.externalId,
      currentNode: 'master', cwd: null, selectionGeneration: 0, disposed: false, externalExecNodes: new Set() };
    Object.defineProperties(context, {
      id: { writable: false }, externalId: { writable: false },
    });
    Object.seal(context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
      onsessioninitialized: sessionId => {
        const connection = this.liveConnection(id);
        if (sessionId !== id || !connection || connection.disposed) throw new Error('MCP session is unavailable.');
        connection.initialized = true;
        this.connections.set(id, connection);
      },
    });
    const server = new Server({ name: 'foxwarm', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        const tools = this.catalog ? await this.catalog.listTools(context, principal) : [];
        if (!Array.isArray(tools) || tools.length > MAX_TOOLS || Buffer.byteLength(JSON.stringify(tools)) > MAX_CATALOG_BYTES) {
          throw new Error('Tool catalog exceeds size limit.');
        }
        return { tools };
      } catch {
        throw new McpError(ErrorCode.InternalError, 'Tool catalog is unavailable.');
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!this.catalog) return { isError: true, content: [{ type: 'text', text: 'No tools are available.' }] };
      try {
        const requestSignal = this.requestSignals.getStore();
        const signal = requestSignal ? AbortSignal.any([extra.signal, requestSignal]) : extra.signal;
        const result = await this.catalog.callTool(context, request.params.name, request.params.arguments || {}, signal, principal);
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
          return { isError: true, content: [{ type: 'text', text: 'The tool may have completed, but its result exceeded the 16 MiB transport limit. Do not retry automatically.' }] };
        }
        return result;
      } catch (error) {
        const detail = error instanceof McpInboundSafeError
          ? error.message.slice(0, 1_200)
          : 'Tool outcome unknown; do not retry automatically.';
        return { isError: true, content: [{ type: 'text', text: detail }] };
      }
    });
    const connection: Connection = {
      id, principal, context, server, transport, lastActivity: Date.now(), active: 0, activePosts: 0,
      initialized: false, disposed: false,
    };
    this.live.add(connection);
    try {
      await server.connect(transport);
    } catch (error) {
      await this.dispose(connection);
      throw error;
    }
    return connection;
  }

  private liveConnection(id: string): Connection | undefined {
    for (const connection of this.live) if (connection.id === id) return connection;
    return undefined;
  }

  private async handle(req: Request, res: Response): Promise<void> {
    if (this.stopped) return sendError(res, 503, 'MCP service unavailable.');
    // The main instance cookie/token never authenticates this route. Recheck for every HTTP request.
    const principal = authenticateMcpInboundBearer(this.config, headerExactlyOnce(req, 'authorization'));
    if (!principal) return sendError(res, 401, 'Unauthorized.');
    const origin = headerExactlyOnce(req, 'origin');
    if (req.headers.origin !== undefined && (!origin || !req.headers.host || !this.isSameOrigin(origin, req.headers.host))) {
      return sendError(res, 403, 'Origin not allowed.');
    }
    const sessionId = headerExactlyOnce(req, 'mcp-session-id');
    if (req.headers['mcp-session-id'] !== undefined && !sessionId) return sendError(res, 400, 'Invalid MCP session header.');
    let connection: Connection | undefined;
    if (sessionId) {
      connection = this.connections.get(sessionId);
      if (!connection || connection.disposed || connection.principal.externalId !== principal.externalId) {
        return sendError(res, 404, 'MCP session not found.');
      }
      if (connection.activePosts === 0 && Date.now() - connection.lastActivity >= this.idleMs) {
        await this.dispose(connection).catch(() => {});
        return sendError(res, 404, 'MCP session not found.');
      }
    } else if (req.method === 'POST') {
      if (!isInitializeRequest(req.body)) return sendError(res, 400, 'Initialize a new MCP session first.');
      if (this.live.size >= this.maxSessions) return sendError(res, 503, 'MCP session capacity reached.');
      try {
        connection = await this.open(principal);
      } catch {
        return sendError(res, 503, 'MCP session unavailable.');
      }
    } else {
      return sendError(res, 400, 'MCP session header required.');
    }
    if (connection.active >= MAX_PARALLEL_REQUESTS) return sendError(res, 429, 'Too many concurrent requests.');
    if (req.method === 'GET' && connection.activeSse) return sendError(res, 409, 'MCP SSE stream already open.');
    if (req.method === 'POST' && req.body !== undefined && Buffer.byteLength(JSON.stringify(req.body)) > MAX_REQUEST_BYTES) {
      if (!sessionId) await this.dispose(connection).catch(() => {});
      return sendError(res, 413, 'MCP request exceeds size limit.');
    }
    connection.lastActivity = Date.now();
    connection.active++;
    if (req.method === 'POST') connection.activePosts++;
    const requestAbort = req.method === 'POST' ? new AbortController() : undefined;
    if (req.method === 'GET') {
      connection.activeSse = res;
      res.once('close', () => {
        if (connection.activeSse === res) {
          connection.activeSse = undefined;
          connection.transport.closeStandaloneSSEStream();
        }
      });
    }
    const deadline = req.method === 'POST'
      ? setTimeout(() => {
        requestAbort?.abort();
        sendError(res, 504, 'MCP request timed out; a running tool may have an unknown outcome. Do not retry automatically.');
        if (!connection!.initialized) void this.dispose(connection!).catch(() => {});
      }, this.postDeadlineMs)
      : undefined;
    deadline?.unref();
    try {
      res.once('close', () => {
        if (req.method === 'POST' && !res.writableFinished) {
          requestAbort?.abort();
          if (!connection.initialized) void this.dispose(connection).catch(() => {});
        }
      });
      const transportTask = requestAbort
        ? this.requestSignals.run(requestAbort.signal, () => connection.transport.handleRequest(req, res, req.body))
        : connection.transport.handleRequest(req, res, req.body);
      await Promise.race([
        transportTask,
        new Promise<void>(resolve => res.once('close', () => resolve())),
      ]);
    } catch {
      sendError(res, 500, 'MCP request failed.');
    } finally {
      if (deadline) clearTimeout(deadline);
      connection.active--;
      if (req.method === 'POST') {
        connection.activePosts--;
        connection.lastActivity = Date.now();
      }
      if (req.method === 'DELETE' || (!connection.initialized && !sessionId)) await this.dispose(connection).catch(() => {});
    }
  }

  private isSameOrigin(origin: string, host: string): boolean {
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
        && parsed.host.toLowerCase() === host.toLowerCase() && parsed.pathname === '/';
    } catch {
      return false;
    }
  }
}
