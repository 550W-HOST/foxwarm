import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

export type CodeHelperOpenRequest =
  | { kind: 'addFolder'; path: string }
  | { kind: 'openFile'; path: string; startLine?: number; startColumn?: number };

export type CodeHelperControlResult = { ok: true; message?: string } | { ok: false; error: string };

type CodeHelperWireRequest = {
  version: 1;
  requestId: string;
  capability: string;
  cwd: string;
  args: string[];
};

type CodeHelperWireResponse = {
  requestId: string;
  ok: boolean;
  message?: string;
  error?: string;
};

const MAX_REQUEST_BYTES = 64 * 1024;
const CLIENT_TIMEOUT_MS = 25_000;

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseGotoTarget(value: string): { filePath: string; startLine: number; startColumn?: number } {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(value);
  if (!match || !match[1]) throw new Error('Use --goto <file>:<line>[:<column>].');
  const startLine = Number(match[2]);
  const startColumn = match[3] ? Number(match[3]) : undefined;
  if (!Number.isSafeInteger(startLine) || startLine < 1 || (startColumn !== undefined && (!Number.isSafeInteger(startColumn) || startColumn < 1))) {
    throw new Error('Line and column must be positive integers.');
  }
  return { filePath: match[1], startLine, ...(startColumn !== undefined ? { startColumn } : {}) };
}

async function resolveHelperRequest(cwd: string, args: string[]): Promise<CodeHelperOpenRequest> {
  if (process.platform === 'win32') throw new Error('Foxwarm code helper does not support Windows workspace paths yet.');
  let forceAdd = false;
  let goto = false;
  let positional: string | undefined;
  let parseOptions = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (parseOptions && arg === '--') { parseOptions = false; continue; }
    if (parseOptions && (arg === '--reuse-window' || arg === '-r')) continue;
    if (parseOptions && arg === '--add') {
      forceAdd = true;
      const next = args[++index];
      if (!next) throw new Error('--add requires a folder path.');
      if (positional !== undefined) throw new Error('Foxwarm code helper accepts one path at a time.');
      positional = next;
      continue;
    }
    if (parseOptions && (arg === '--goto' || arg === '-g')) {
      goto = true;
      const next = args[++index];
      if (!next) throw new Error(`${arg} requires <file>:<line>[:<column>].`);
      if (positional !== undefined) throw new Error('Foxwarm code helper accepts one path at a time.');
      positional = next;
      continue;
    }
    if (parseOptions && arg.startsWith('-')) throw new Error(`Unsupported Foxwarm code option: ${arg}`);
    if (positional !== undefined) throw new Error('Foxwarm code helper accepts one path at a time.');
    positional = arg;
  }

  if (!positional) throw new Error('Usage: code [--add <folder> | --goto <file>:<line>[:<column>] | <path>]');
  const gotoTarget = goto ? parseGotoTarget(positional) : undefined;
  const resolvedPath = path.resolve(cwd, gotoTarget?.filePath || positional);
  const stat = await fs.promises.stat(resolvedPath).catch((): null => null);
  if (!stat) throw new Error(`Path does not exist: ${resolvedPath}`);
  if (forceAdd) {
    if (!stat.isDirectory()) throw new Error(`--add requires a directory: ${resolvedPath}`);
    return { kind: 'addFolder', path: resolvedPath };
  }
  if (gotoTarget) {
    if (stat.isDirectory()) throw new Error(`--goto requires a file: ${resolvedPath}`);
    return {
      kind: 'openFile',
      path: resolvedPath,
      startLine: gotoTarget.startLine,
      ...(gotoTarget.startColumn !== undefined ? { startColumn: gotoTarget.startColumn } : {}),
    };
  }
  return stat.isDirectory() ? { kind: 'addFolder', path: resolvedPath } : { kind: 'openFile', path: resolvedPath };
}

export class CodeHelperIpcServer {
  private readonly capabilities = new Map<string, string>();
  private readonly socketPath: string;
  private readonly helperDir: string;
  private server?: net.Server;
  private startPromise?: Promise<void>;
  private exitCleanup?: () => void;

  constructor(
    stateDir: string,
    private readonly onRequest: (terminalId: string, requestId: string, request: CodeHelperOpenRequest) => Promise<CodeHelperControlResult>,
  ) {
    const runtimeId = crypto.createHash('sha256').update(`${path.resolve(stateDir)}\0${process.pid}`).digest('hex').slice(0, 16);
    this.socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\foxwarm-code-${runtimeId}`
      : path.join(os.tmpdir(), `foxwarm-code-${runtimeId}.sock`);
    this.helperDir = path.join(stateDir, '.temp', `code-helper-${process.pid}`);
  }

  async registerTerminal(terminalId: string): Promise<{ capability: string; env: Record<string, string> }> {
    await this.start();
    const capability = crypto.randomBytes(32).toString('hex');
    this.capabilities.set(capability, terminalId);
    const binDir = path.join(this.helperDir, 'bin');
    return {
      capability,
      env: {
        FOXWARM_CODE_IPC: this.socketPath,
        FOXWARM_CODE_CAPABILITY: capability,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    };
  }

  unregisterTerminal(capability?: string): void {
    if (capability) this.capabilities.delete(capability);
  }

  async close(): Promise<void> {
    this.capabilities.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.exitCleanup) process.removeListener('exit', this.exitCleanup);
    this.exitCleanup = undefined;
    if (process.platform !== 'win32') await fs.promises.rm(this.socketPath, { force: true }).catch((): undefined => undefined);
    await fs.promises.rm(this.helperDir, { recursive: true, force: true }).catch((): undefined => undefined);
  }

  private async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    await this.writeHelperScripts();
    if (process.platform !== 'win32') await fs.promises.rm(this.socketPath, { force: true }).catch((): undefined => undefined);
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });
    server.unref();
    if (process.platform !== 'win32') await fs.promises.chmod(this.socketPath, 0o600);
    this.exitCleanup = () => {
      try { if (process.platform !== 'win32') fs.rmSync(this.socketPath, { force: true }); } catch {}
      try { fs.rmSync(this.helperDir, { recursive: true, force: true }); } catch {}
    };
    process.once('exit', this.exitCleanup);
  }

  private async writeHelperScripts(): Promise<void> {
    const binDir = path.join(this.helperDir, 'bin');
    await fs.promises.mkdir(binDir, { recursive: true });
    if (process.platform === 'win32') {
      const script = `@echo off\r\n"${process.execPath.replace(/"/g, '""')}" "${__filename.replace(/"/g, '""')}" %*\r\n`;
      await fs.promises.writeFile(path.join(binDir, 'code.cmd'), script);
      return;
    }
    const script = `#!/bin/sh\nexec ${quotePosix(process.execPath)} ${quotePosix(__filename)} "$@"\n`;
    await fs.promises.writeFile(path.join(binDir, 'code'), script, { mode: 0o755 });
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify({ requestId: '', ok: false, error: 'Foxwarm code helper request is too large.' })}\n`);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void this.handleRequestLine(buffer.slice(0, newline)).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  }

  private async handleRequestLine(line: string): Promise<CodeHelperWireResponse> {
    let wire: CodeHelperWireRequest;
    try {
      wire = JSON.parse(line) as CodeHelperWireRequest;
    } catch {
      return { requestId: '', ok: false, error: 'Invalid Foxwarm code helper JSON request.' };
    }
    const requestId = typeof wire.requestId === 'string' ? wire.requestId : '';
    try {
      if (wire.version !== 1 || !requestId) throw new Error('Unsupported Foxwarm code helper protocol request.');
      const terminalId = this.capabilities.get(wire.capability);
      if (!terminalId) throw new Error('Foxwarm code helper capability is invalid or expired.');
      if (typeof wire.cwd !== 'string' || !path.isAbsolute(wire.cwd) || !Array.isArray(wire.args) || wire.args.some((arg) => typeof arg !== 'string')) {
        throw new Error('Foxwarm code helper cwd/args are invalid.');
      }
      const request = await resolveHelperRequest(wire.cwd, wire.args);
      const result = await this.onRequest(terminalId, requestId, request);
      return result.ok
        ? { requestId, ok: true, ...(result.message ? { message: result.message } : {}) }
        : { requestId, ok: false, error: result.error };
    } catch (error) {
      return { requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function runCodeHelperClient(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'Foxwarm Code helper',
      '',
      'Usage:',
      '  code <file>                         Open a file in the connected Code workbench',
      '  code <folder>                       Add a folder to the current workspace',
      '  code --add <folder>                 Add a folder to the current workspace',
      '  code --goto <file>:<line>[:column]  Open a file at a location',
      '',
    ].join('\n'));
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write('foxwarm-code-helper 1\n');
    return;
  }
  const socketPath = process.env.FOXWARM_CODE_IPC;
  const capability = process.env.FOXWARM_CODE_CAPABILITY;
  if (!socketPath || !capability) throw new Error('Foxwarm Code helper is only available inside a Foxwarm terminal.');
  const request: CodeHelperWireRequest = {
    version: 1,
    requestId: crypto.randomUUID(),
    capability,
    cwd: process.cwd(),
    args,
  };
  const response = await new Promise<CodeHelperWireResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for the connected Code workbench.'));
    }, CLIENT_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try { resolve(JSON.parse(buffer.slice(0, newline)) as CodeHelperWireResponse); }
      catch { reject(new Error('Invalid response from Foxwarm Code bridge.')); }
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.once('end', () => {
      if (!buffer.includes('\n')) {
        clearTimeout(timeout);
        reject(new Error('Foxwarm Code bridge closed before replying.'));
      }
    });
  });
  if (!response.ok) throw new Error(response.error || 'Foxwarm Code request failed.');
  if (response.message) process.stdout.write(`${response.message}\n`);
}

if (require.main === module) {
  void runCodeHelperClient().catch((error) => {
    process.stderr.write(`code: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
