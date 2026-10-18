import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Independent executable contract fixture: no imports from Core implementation.
const root = process.argv[2];
const mode = process.argv[3] || 'normal';
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const local = (value: string) => value.startsWith('fixture://') ? path.join(root, value.slice('fixture://'.length)) : value;
const stat = (value: fs.Stats) => ({ kind: value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other', size: value.size, modifiedAtMs: value.mtimeMs });
const node = { id: 'process-fixture', kind: 'remote', type: 'fixture', availability: 'ready', filesystem: 'read-write', exec: true, defaultCwd: 'fixture://cwd' };

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const envelope = JSON.parse(input);
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(path.join(root, 'requests.jsonl'), JSON.stringify(envelope) + '\n');
  const reply: any = { protocol: 'foxwarm-node-provider', providerId: envelope.providerId, requestId: envelope.requestId, operation: envelope.operation, ok: true };
  const request = envelope.request;
  try {
    switch (envelope.operation) {
      case 'describe': reply.result = { label: 'Process fixture', description: 'Independent process fixture.', lifecycle: [] }; break;
      case 'list': reply.result = { nodes: [node] }; break;
      case 'exec-start': {
        const ref = crypto.randomUUID();
        const directory = path.join(root, ref);
        fs.mkdirSync(directory);
        fs.mkdirSync(path.join(root, 'cwd'), { recursive: true });
        const status = path.join(directory, 'status');
        const cwd = path.join(directory, 'cwd');
        const output = path.join(directory, 'output');
        const script = path.join(directory, 'command.sh');
        const finalize = `code=$?; pwd > ${quote(cwd)}; echo "$code" > ${quote(status)}`;
        fs.writeFileSync(script, `trap ${quote(finalize)} EXIT\n${request.command}\n`);
        const fd = fs.openSync(output, 'w');
        const child = spawn('/bin/bash', [script], { cwd: local(request.cwd || 'fixture://cwd'), detached: true, stdio: ['ignore', fd, fd] });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        fs.closeSync(fd);
        fs.writeFileSync(path.join(directory, 'pid'), String(child.pid));
        child.unref();
        fs.writeFileSync(path.join(root, 'start-ready'), ref);
        if (mode === 'drop-start') return;
        if (mode === 'slow-start') await new Promise(resolve => setTimeout(resolve, 500));
        reply.result = { ref, outputPath: `fixture://${ref}/output`, cwd: request.cwd || 'fixture://cwd' };
        break;
      }
      case 'exec-poll': {
        if (mode === 'hang-poll') await new Promise(resolve => setTimeout(resolve, 30_000));
        if (mode === 'fail-poll' && !fs.existsSync(path.join(root, 'failed-once'))) {
          fs.writeFileSync(path.join(root, 'failed-once'), '1');
          throw Object.assign(new Error('Temporary query failure'), { code: 'TransientFailure' });
        }
        const directory = path.join(root, request.ref);
        const status = path.join(directory, 'status');
        if (mode === 'lost' || !fs.existsSync(directory)) reply.result = { state: 'lost', reason: 'Fixture execution records removed.' };
        else if (fs.existsSync(status)) reply.result = { state: 'finished', exitCode: Number(fs.readFileSync(status, 'utf8')), cwd: fs.readFileSync(path.join(directory, 'cwd'), 'utf8').replace(/\n$/, ''), finishedAt: new Date().toISOString() };
        else reply.result = { state: 'running' };
        break;
      }
      case 'filesystem': {
        const target = local(request.path);
        if (mode === 'unreadable-log' && /\/output$/.test(target)) throw Object.assign(new Error('No log access'), { code: 'EACCES' });
        switch (request.operation) {
          case 'parent': reply.result = { path: path.dirname(request.path) }; break;
          case 'stat': reply.result = stat(fs.statSync(target)); break;
          case 'read': {
            const fd = fs.openSync(target, 'r');
            try {
              const buffer = Buffer.alloc(mode === 'short-log' && /\/output$/.test(target) ? Math.min(3, request.count) : request.count);
              const bytes = fs.readSync(fd, buffer, 0, buffer.length, request.offset);
              reply.result = { dataBase64: buffer.subarray(0, bytes).toString('base64') };
            } finally { fs.closeSync(fd); }
            break;
          }
          case 'write': fs.writeFileSync(target, Buffer.from(request.contentBase64, 'base64'), { flag: request.flag }); reply.result = null; break;
          case 'mkdir': fs.mkdirSync(target, { recursive: true }); reply.result = null; break;
          case 'remove': fs.rmSync(target, { recursive: true, force: true }); reply.result = null; break;
          case 'readdir': reply.result = fs.readdirSync(target).map(name => ({ name, ...stat(fs.lstatSync(path.join(target, name))) })); break;
          default: throw new Error('Unsupported filesystem operation');
        }
        break;
      }
      default: throw new Error('Unsupported operation');
    }
  } catch (error: any) {
    reply.ok = false;
    reply.error = { code: error.code || 'FixtureError', message: error.message, retryable: false };
  }
  process.stdout.write(JSON.stringify(reply));
}

void main().catch(() => { process.exitCode = 1; });
