/**
 * Interactive Node Client — requires user confirmation before executing tools.
 *
 * Usage:
 *   node lib/nodes/interactive-client.js --host http://master:3001 --id macbook --token <token>
 *
 * Options:
 *   --auto-approve <regex>   Auto-approve tools matching regex (e.g. "read|browse_list")
 *   --auto-approve-all       Skip confirmation for all tools
 *   --timeout <seconds>      Auto-reject if no response within N seconds (default: none)
 */

// Suppress pino console output in interactive mode — we handle our own display.
// Logger still writes to the log file via common.ts.
process.env.FOXWARM_NO_CONSOLE_LOG = '1';

import fs from 'fs';
import tty from 'tty';
import { NodeClient } from './client';
import { initializeExecManager } from '../execManager';
import { logger } from '../common';

// ─── ANSI helpers ───
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

function c(color: string, text: string) { return `${color}${text}${C.reset}`; }

// ─── Pretty-print a tool call ───
function formatToolPreview(tool: string, args: any): string {
  const lines: string[] = [];
  const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s;

  switch (tool) {
    case 'exec':
      lines.push(`${C.bold}Command:${C.reset}`);
      lines.push(c(C.cyan, `  $ ${args.command}`));
      if (args.cwd) lines.push(`  cwd: ${args.cwd}`);
      break;
    case 'read':
      lines.push(`${C.bold}Read:${C.reset} ${c(C.cyan, args.filePath)}`);
      if (args.startLine || args.endLine) lines.push(`  lines ${args.startLine || 1}–${args.endLine || 'EOF'}`);
      break;
    case 'write': {
      const content: string = args.content || '';
      lines.push(`${C.bold}Write:${C.reset} ${c(C.cyan, args.filePath)}  (${content.length} chars, overwrite=${args.overwrite ?? false})`);
      lines.push(c(C.dim, '  ' + trunc(content, 300).split('\n').join('\n  ')));
      break;
    }
    case 'edit':
      lines.push(`${C.bold}Edit:${C.reset} ${c(C.cyan, args.filePath)}`);
      lines.push(c(C.red,   '  - ' + trunc(args.oldText || '', 120)));
      lines.push(c(C.green, '  + ' + trunc(args.newText || '', 120)));
      break;
    case 'apply_patch':
      lines.push(`${C.bold}Patch:${C.reset}`);
      lines.push(c(C.dim, '  ' + trunc(args.input || '', 400).split('\n').join('\n  ')));
      break;
    case 'browse_open':
      lines.push(`${C.bold}Open URL:${C.reset} ${c(C.cyan, args.url)}`);
      break;
    case 'browse_interact':
      lines.push(`${C.bold}Browser ${args.action}:${C.reset} tab ${args.tabId}`);
      if (args.params) lines.push(`  ${JSON.stringify(args.params)}`);
      break;
    default:
      lines.push(`${C.bold}${tool}:${C.reset} ${trunc(JSON.stringify(args), 300)}`);
  }
  return lines.join('\n');
}

// ─── Interactive confirmer ───
class InteractiveConfirm {
  private ttyFd: number | null = null;
  private ttyInput: tty.ReadStream | null = null;
  private autoPattern: RegExp | null;
  private autoAll: boolean;
  private timeoutSec: number;
  private pendingResolve: ((result: boolean | string) => void) | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(opts: { autoApprove?: string; autoApproveAll?: boolean; timeout?: number }) {
    this.autoPattern = opts.autoApprove ? new RegExp(opts.autoApprove, 'i') : null;
    this.autoAll = opts.autoApproveAll || false;
    this.timeoutSec = opts.timeout || 0;
  }

  /** Set up tty input with raw mode — all keystrokes are consumed immediately */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    try {
      this.ttyFd = fs.openSync('/dev/tty', 'r');
      // Use tty.ReadStream for proper raw mode support
      this.ttyInput = new tty.ReadStream(this.ttyFd);
      this.ttyInput.setRawMode(true);
    } catch {
      // Fallback: use process.stdin if it's a TTY
      if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
        (process.stdin as any).setRawMode(true);
      }
    }

    const input = this.ttyInput || process.stdin;

    input.on('data', (chunk: Buffer) => {
      for (const byte of chunk) {
        // Ctrl+C
        if (byte === 3) {
          process.emit('SIGINT' as any);
          return;
        }

        // 'a'/'A' — toggle auto-approve-all (works anytime, even without pending question)
        if (byte === 97 || byte === 65) {
          this.autoAll = !this.autoAll;
          process.stderr.write(c(this.autoAll ? C.yellow : C.green,
            `\n  [Auto-approve: ${this.autoAll ? 'ON — all tools will be auto-approved' : 'OFF — back to manual confirmation'}]\n`));
          // If toggled ON while a question is pending, approve it immediately
          if (this.autoAll && this.pendingResolve) {
            process.stderr.write(c(C.green, '  ✓ Auto-approved\n'));
            this.resolve(true);
          }
          continue;
        }

        if (!this.pendingResolve) {
          // No pending question — discard all input
          continue;
        }

        // Enter (CR or LF) or 'y'/'Y' → approve
        if (byte === 13 || byte === 10 || byte === 121 || byte === 89) {
          process.stderr.write('\n');
          process.stderr.write(c(C.green, '  ✓ Approved\n'));
          this.resolve(true);
        }
        // 'n'/'N' → reject
        else if (byte === 110 || byte === 78) {
          process.stderr.write('\n');
          process.stderr.write(c(C.red, '  ✗ Rejected\n'));
          this.resolve(false);
        }
        // Any other key — ignore
      }
    });

    // Don't let the input stream keep the process alive
    if (typeof (input as any).unref === 'function') {
      (input as any).unref();
    }
  }

  private resolve(result: boolean | string): void {
    if (!this.pendingResolve) return;
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    resolve(result);
  }

  async confirm(tool: string, args: any, sessionId: string, _callId: string, serverTimeoutMs?: number): Promise<boolean | string> {
    if (this.autoAll || (this.autoPattern && this.autoPattern.test(tool))) {
      process.stderr.write(c(C.dim, `  [auto-approved: ${tool}]\n`));
      return true;
    }

    this.init();

    // Use server timeout (with margin) or user-configured timeout
    const effectiveTimeoutSec = serverTimeoutMs
      ? Math.max(1, Math.floor(serverTimeoutMs / 1000) - 2)  // 2s margin before server timeout
      : (this.timeoutSec || 0);

    process.stderr.write('\n');
    process.stderr.write(c(C.bold + C.yellow, ' ⚡ TOOL CALL ') + '\n');
    process.stderr.write(`${C.bold}Session:${C.reset} ${c(C.magenta, sessionId)}\n`);
    process.stderr.write(formatToolPreview(tool, args) + '\n');
    if (effectiveTimeoutSec > 0) {
      process.stderr.write(c(C.dim, `  (auto-reject in ${effectiveTimeoutSec}s)\n`));
    }
    process.stderr.write('\n');

    const prompt = `${C.bold}Execute?${C.reset} [${c(C.green, 'Y')}/${c(C.red, 'n')}] `;
    process.stderr.write(prompt);

    return new Promise<boolean | string>((resolvePromise) => {
      // Cancel any previous pending question (shouldn't happen, but be safe)
      if (this.pendingResolve) {
        this.resolve('timeout');
      }

      this.pendingResolve = resolvePromise;

      if (effectiveTimeoutSec > 0) {
        this.pendingTimer = setTimeout(() => {
          process.stderr.write('\r\x1b[2K');  // clear prompt line
          process.stderr.write(c(C.red, '  ✗ Timeout — rejected\n'));
          this.resolve('timeout');
        }, effectiveTimeoutSec * 1000);
      }
    });
  }

  close() {
    this.resolve('timeout');
    if (this.ttyInput) {
      try { this.ttyInput.setRawMode(false); } catch {}
      try { this.ttyInput.destroy(); } catch {}
      this.ttyInput = null;
    }
    if (this.ttyFd !== null) {
      try { fs.closeSync(this.ttyFd); } catch {}
      this.ttyFd = null;
    }
  }
}

// ─── CLI arg parsing ───
interface Opts {
  host: string; nodeId?: string; token?: string; authToken?: string;
  credentialsFile?: string; localTrigger?: boolean; localTriggerPort?: number;
  autoApprove?: string; autoApproveAll?: boolean; timeout?: number;
}

function parseArgs(): Opts {
  const args = process.argv.slice(2);
  const o: any = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--host')              o.host = args[++i];
    else if (a === '--id')           o.nodeId = args[++i];
    else if (a === '--token')        o.token = args[++i];
    else if (a === '--auth-token')   o.authToken = args[++i];
    else if (a === '--credentials-file') o.credentialsFile = args[++i];
    else if (a === '--local-trigger-port') o.localTriggerPort = Number(args[++i]);
    else if (a === '--no-local-trigger') o.localTrigger = false;
    else if (a === '--auto-approve') o.autoApprove = args[++i];
    else if (a === '--auto-approve-all') o.autoApproveAll = true;
    else if (a === '--timeout')      o.timeout = Number(args[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`
Interactive Foxwarm Node Client
===============================
Every tool call requires your confirmation before execution.

Usage:
  node lib/nodes/interactive-client.js --host URL --id NAME --token TOKEN [options]

Options:
  --host <url>              Master URL (required)
  --id <name>               Node name (e.g. macbook)
  --token <token>           Pairing token
  --credentials-file <path> Stored credentials file
  --auto-approve <regex>    Auto-approve matching tools (e.g. "read|browse_list")
  --auto-approve-all        Skip all confirmations
  --timeout <seconds>       Auto-reject after N seconds
  --no-local-trigger        Disable local trigger server
`);
      process.exit(0);
    }
  }
  if (!o.host) { console.error('Error: --host required. Use --help.'); process.exit(1); }
  if (!o.token && !(o.authToken && o.nodeId) && !o.credentialsFile) {
    console.error('Error: provide --token, --auth-token+--id, or --credentials-file'); process.exit(1);
  }
  return o as Opts;
}

// ─── Main ───
async function main() {
  const opts = parseArgs();

  const confirmer = new InteractiveConfirm({
    autoApprove: opts.autoApprove,
    autoApproveAll: opts.autoApproveAll,
    timeout: opts.timeout,
  });
  confirmer.init();  // Start consuming input immediately to drain stale keypresses

  process.stderr.write('\n');
  process.stderr.write(c(C.bold + C.cyan, '╔══════════════════════════════════════════╗') + '\n');
  process.stderr.write(c(C.bold + C.cyan, '║   🔒 Interactive Foxwarm Node Client     ║') + '\n');
  process.stderr.write(c(C.bold + C.cyan, '╚══════════════════════════════════════════╝') + '\n');
  process.stderr.write('\n');
  process.stderr.write(`  Host:    ${opts.host}\n`);
  process.stderr.write(`  Node ID: ${opts.nodeId || '(auto)'}\n`);
  if (opts.autoApprove) process.stderr.write(`  Auto-approve: /${opts.autoApprove}/i\n`);
  if (opts.timeout)     process.stderr.write(`  Timeout: ${opts.timeout}s\n`);
  process.stderr.write('\n');
  process.stderr.write(c(C.yellow, '  Every tool call will require your confirmation.\n'));
  process.stderr.write(c(C.dim,    '  Press Y/Enter to approve, N to reject, A to toggle auto-approve.\n'));
  process.stderr.write('\n');

  const log = (msg: string) => process.stderr.write(c(C.dim, `  ${msg}\n`));

  const client = new NodeClient({
    host: opts.host,
    nodeId: opts.nodeId,
    token: opts.token,
    authToken: opts.authToken,
    credentialsFile: opts.credentialsFile,
    localTrigger: opts.localTrigger,
    localTriggerPort: opts.localTriggerPort,
    toolCallInterceptor: (tool, args, sessionId, callId, timeoutMs) =>
      confirmer.confirm(tool, args, sessionId, callId, timeoutMs),
    onStatus: (event: string, detail?: Record<string, any>) => {
      switch (event) {
        case 'connecting':
          log(`Connecting to master (${detail?.mode || 'unknown'})…`);
          break;
        case 'connected':
          log(c(C.green, `Connected (${detail?.mode || 'unknown'})`));
          break;
        case 'registered':
          log(c(C.green, `✓ Registered as ${c(C.bold, detail?.nodeId || '?')}`));
          break;
        case 'pair_pending':
          log(c(C.yellow, `Pairing pending — code: ${detail?.pairCode || '?'}, id: ${detail?.pendingId || '?'}`));
          log(c(C.yellow, `Approve on master: /node pair approve ${detail?.pendingId || '<id>'} ${opts.nodeId || ''}`));
          break;
        case 'pair_approved':
          log(c(C.green, `✓ Pairing approved! Node ID: ${detail?.nodeId || '?'}`));
          break;
        case 'disconnected':
          log(c(C.red, `Disconnected: ${detail?.reason || 'unknown'}`));
          break;
        case 'reconnecting':
          log(`Reconnecting in ${detail?.delay || '?'}ms…`);
          break;
      }
    },
  });

  await initializeExecManager({
    completionDispatcher: async (entry, _status, message) => {
      if (!entry.sessionId) return;
      await client.sendSessionEvent(entry.sessionId, message, 'background');
    },
  });

  await client.startLocalTriggerServer();
  await client.connect();

  const forceExit = () => {
    // Use SIGKILL to bypass pino's on-exit-leak-free flushSync hook
    // which hangs for 10s waiting on thread-stream
    process.kill(process.pid, 'SIGKILL');
  };

  const shutdown = async () => {
    process.stderr.write(c(C.dim, '\nShutting down…\n'));
    confirmer.close();
    // Force exit after 1s if graceful shutdown hangs
    setTimeout(forceExit, 1000);
    try {
      await client.disconnect();
    } catch {}
    forceExit();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => { logger.error({ err }, 'Interactive node client failed'); process.exit(1); });
