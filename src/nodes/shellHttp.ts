import crypto from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';
import { HttpServer } from '../httpServer';
import { nodesManager, type HttpExecTransport } from './manager';
import { authenticateApprovedNode, touchApprovedNode } from './registry';
import { BACKGROUND_COMPLETION_EVENT_RETENTION_MS, resolveExecTimeoutSeconds } from '../../packages/shared/dist/persistentExec';

export const SHELL_EXEC_CAPABILITY = {
  name: 'exec',
  description: 'Run a POSIX shell command on this Node. Returns bounded output with its total byte count; full output is not retained. If the command outlasts timeout, it continues in the background and returns an execId. Completion is reported to the originating session.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command or pipeline to execute.' },
      cwd: { type: 'string', description: 'Working directory for this command. Omit to use the directory where the Shell Node was started.' },
      timeout: { type: 'number', description: 'Seconds to wait before returning a still-running command as a background execution. Defaults to 15; values above 60 are reduced to 60.', default: 15, minimum: 1 },
    },
    required: ['command'],
  },
};

const PROTOCOL = 'foxwarm-shell-1';
const OUTPUT_BYTES = 8192;
const TASK_BYTES = 65536;
const POLL_MS = 25_000;
const ONLINE_MS = 90_000;
const MAX_TASKS = 32;

type Dispatch = Parameters<HttpExecTransport['dispatch']>[0];
type Task = {
  id: string; connection: string; nodeId: string; request: Dispatch; script: string;
  timeout: number; warning?: string; startedAt: number; delivered: boolean;
  state: 'foreground' | 'background' | 'finished';
  serial: Promise<void>;
};

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function header(req: Request, name: string): string { return String(req.get(name) || ''); }

async function body(req: Request, limit: number): Promise<Buffer> {
  if (!String(req.get('content-type') || '').startsWith('application/octet-stream')) throw new Error('Expected application/octet-stream');
  if (Number(req.get('content-length') || 0) > limit) throw new Error('Body exceeds limit');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > limit) throw new Error('Body exceeds limit');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

function outputText(sample: Buffer, total: number, exitCode: number): string {
  const binary = sample.includes(0) || !Buffer.from(sample.toString('utf8')).equals(sample);
  const rendered = binary ? `[Binary output sample, hexadecimal]\n${sample.toString('hex')}` : sample.toString('utf8');
  const truncation = total > OUTPUT_BYTES ? '\n[Output truncated: first 4096 and last 4096 bytes; full output was not retained.]' : '';
  return `${rendered || '(No output)'}${truncation}\n\nExit code: ${exitCode}\nTotal output bytes: ${total}`;
}

/** Process-local HTTP transport; a handed-out command is never returned to the queue. */
export function registerShellNodeHttpRoutes(server: HttpServer): () => void {
  const runtimes = new Map<string, Runtime>();
  const tasks = new Map<string, Task>();

  class Runtime implements HttpExecTransport {
    readonly connection = crypto.randomBytes(16).toString('hex');
    private queue: Task[] = [];
    private pending?: { res: Response; timer: NodeJS.Timeout };
    lastSeen = Date.now();
    closed = false;
    constructor(readonly nodeId: string, readonly cwd: string) {}

    dispatch(request: Dispatch): void {
      if (this.closed || request.tool !== 'exec' || !request.backgroundExecId || !request.completionCapability) throw new Error('Shell Node exec transport is unavailable');
      const command = request.args.command;
      if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > TASK_BYTES - 8192 || command.includes('\0')) throw new Error('Shell Node command must be non-empty and at most 56 KiB');
      if ([...tasks.values()].filter(task => task.nodeId === this.nodeId && task.state !== 'finished').length >= MAX_TASKS) throw new Error('Shell Node is busy; no command was started');
      const explicitCwd = request.args.cwd;
      if (explicitCwd !== undefined && (typeof explicitCwd !== 'string' || !explicitCwd.trim())) throw new Error('cwd must be a non-empty directory');
      const cwd = path.posix.resolve(this.cwd, typeof explicitCwd === 'string' ? explicitCwd : (request.sessionCwd || this.cwd));
      if (cwd.includes('\0') || Buffer.byteLength(cwd) > 4096) throw new Error('Shell Node cwd is invalid');
      const resolved = resolveExecTimeoutSeconds(request.args.timeout);
      const task: Task = {
        id: crypto.randomBytes(16).toString('hex'), connection: this.connection, nodeId: this.nodeId,
        request, timeout: Math.ceil(resolved.effectiveSeconds), warning: resolved.warning,
        script: `cd ${shellQuote(cwd)} || exit 125\n${command}\n`,
        startedAt: Date.now(), delivered: false, state: 'foreground', serial: Promise.resolve(),
      };
      tasks.set(task.id, task);
      this.queue.push(task);
      this.flush();
    }

    cancel(callId: string): void {
      this.queue = this.queue.filter(task => {
        if (task.request.callId !== callId) return true;
        tasks.delete(task.id);
        return false;
      });
    }

    disconnect(_reason: string): void {
      this.closed = true;
      for (const task of this.queue) tasks.delete(task.id);
      this.queue = [];
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.res.status(409).end();
        this.pending = undefined;
      }
      if (runtimes.get(this.nodeId) === this) runtimes.delete(this.nodeId);
    }

    poll(res: Response): void {
      this.lastSeen = Date.now();
      nodesManager.updateNodeActivity(this.nodeId);
      if (this.pending) { res.status(409).end(); return; }
      const timer = setTimeout(() => {
        if (this.pending?.res !== res) return;
        this.pending = undefined;
        res.setHeader('X-Foxwarm-Shell', PROTOCOL);
        res.status(204).end();
      }, POLL_MS);
      timer.unref();
      this.pending = { res, timer };
      res.on('close', () => {
        if (this.pending?.res !== res) return;
        clearTimeout(timer);
        this.pending = undefined;
      });
      this.flush();
    }

    private flush(): void {
      if (!this.pending || this.queue.length === 0) return;
      const task = this.queue.shift()!;
      const { res, timer } = this.pending;
      clearTimeout(timer);
      this.pending = undefined;
      task.delivered = true;
      res.setHeader('X-Foxwarm-Shell', PROTOCOL);
      res.setHeader('X-Foxwarm-Task', task.id);
      res.setHeader('X-Foxwarm-Exec', task.request.backgroundExecId!);
      res.setHeader('X-Foxwarm-Timeout', String(task.timeout));
      res.type('application/x-foxwarm-shell');
      res.status(200).send(task.script);
    }
  }

  async function authenticate(req: Request, res: Response): Promise<string | undefined> {
    const nodeId = header(req, 'X-Foxwarm-Node');
    const auth = header(req, 'Authorization');
    if (!/^[a-zA-Z0-9_-]+$/.test(nodeId) || !auth.startsWith('Bearer ') || !await authenticateApprovedNode(nodeId, auth.slice(7))) {
      res.status(401).end();
      return undefined;
    }
    return nodeId;
  }

  function route(method: 'GET' | 'POST', suffix: string, handler: (req: Request, res: Response, nodeId: string) => Promise<void>): void {
    server.addRoute({ method, path: `/node/shell/${suffix}`, noAuth: true, handler: async (req, res) => {
      const nodeId = await authenticate(req, res);
      if (!nodeId) return;
      try { await handler(req, res, nodeId); }
      catch { if (!res.headersSent) res.status(400).end(); }
    } });
  }

  route('POST', 'register', async (req, res, nodeId) => {
    const cwd = (await body(req, 4096)).toString('utf8');
    if (!cwd.startsWith('/') || cwd.includes('\0') || cwd.includes('\n') || cwd.includes('\r')) throw new Error('Invalid startup directory');
    const runtime = new Runtime(nodeId, cwd);
    nodesManager.registerHttpExecNode(nodeId, runtime, cwd, SHELL_EXEC_CAPABILITY);
    runtimes.set(nodeId, runtime);
    await touchApprovedNode(nodeId, {
      nodeType: 'shell-node', capabilities: { tools: [SHELL_EXEC_CAPABILITY], features: { remoteExecBackgroundRegistration: true } }, lastSeenAt: Date.now(),
    });
    res.setHeader('X-Foxwarm-Shell', PROTOCOL);
    res.setHeader('X-Foxwarm-Connection', runtime.connection);
    res.status(204).end();
  });

  route('GET', 'poll', async (req, res, nodeId) => {
    const runtime = runtimes.get(nodeId);
    if (!runtime || runtime.connection !== header(req, 'X-Foxwarm-Connection') || runtime.closed) { res.status(409).end(); return; }
    runtime.poll(res);
  });

  route('POST', 'report', async (req, res, nodeId) => {
    const task = tasks.get(header(req, 'X-Foxwarm-Task'));
    if (!task || !task.delivered || task.nodeId !== nodeId || task.connection !== header(req, 'X-Foxwarm-Connection') || Date.now() - task.startedAt > BACKGROUND_COMPLETION_EVENT_RETENTION_MS) { res.status(410).end(); return; }
    const kind = header(req, 'X-Foxwarm-Result');
    if (!['background', 'finished'].includes(kind)) throw new Error('Invalid result');
    const sample = await body(req, OUTPUT_BYTES);
    const totalField = header(req, 'X-Foxwarm-Bytes');
    const exitField = header(req, 'X-Foxwarm-Exit');
    const total = Number(totalField);
    const exitCode = Number(exitField);
    if (kind === 'finished' && (!/^\d+$/.test(totalField) || !/^\d+$/.test(exitField)
      || !Number.isSafeInteger(total) || sample.length !== Math.min(total, OUTPUT_BYTES)
      || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) throw new Error('Invalid result metadata');
    const previous = task.serial;
    let release!: () => void;
    task.serial = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (task.state !== 'finished') {
        const request = task.request;
        const identity = { sessionId: request.sessionId, execId: request.backgroundExecId!, completionCapability: request.completionCapability! };
        if (kind === 'background') {
          if (task.state === 'foreground') {
            nodesManager.registerRemoteExecBackground(nodeId, identity);
            task.state = 'background';
            nodesManager.handleToolResponse(request.callId, { execId: identity.execId, output: `${task.warning ? `${task.warning}\n` : ''}Command continues in background. Exec ID: ${identity.execId}. Completion will be reported to the originating session; full output is not retained.` }, nodeId);
          }
        } else {
          const output = `${task.warning ? `${task.warning}\n` : ''}${outputText(sample, total, exitCode)}`;
          if (task.state === 'background') {
            try {
              await nodesManager.handleSessionEvent(nodeId, request.sessionId, `Shell Node exec ${identity.execId} completed.\n${output}`, 'background', {
                eventId: `remote-exec-completion:${identity.execId}`, execId: identity.execId,
                completionCapability: identity.completionCapability, eventTimestamp: Date.now(),
              });
            } catch { res.status(503).end(); return; }
          } else nodesManager.handleToolResponse(request.callId, { output, exitCode, totalBytes: total, truncated: total > OUTPUT_BYTES }, nodeId);
          task.state = 'finished';
          task.script = '';
          task.request = { ...request, args: {} };
          const completed = [...tasks.values()].filter(item => item.nodeId === nodeId && item.state === 'finished');
          for (const old of completed.slice(0, Math.max(0, completed.length - MAX_TASKS))) tasks.delete(old.id);
        }
      }
      res.setHeader('X-Foxwarm-Shell', PROTOCOL);
      res.status(204).end();
    } finally { release(); }
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const runtime of runtimes.values()) {
      if (now - runtime.lastSeen > ONLINE_MS) nodesManager.disconnectHttpExecNode(runtime.nodeId, runtime, 'Shell Node stopped polling; execution outcome may be unknown');
    }
    for (const [id, task] of tasks) if (now - task.startedAt > BACKGROUND_COMPLETION_EVENT_RETENTION_MS) tasks.delete(id);
  }, 10_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const runtime of [...runtimes.values()]) nodesManager.disconnectHttpExecNode(runtime.nodeId, runtime, 'Shell Node HTTP transport stopped');
    tasks.clear();
  };
}
