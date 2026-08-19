import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PROTOCOL = 'foxwarm-node-provider@1';
const mode = process.argv[2] || 'normal';
const logPath = process.argv[3];

function descriptor(id = 'fixture-sandbox', availability = 'ready') {
  return {
    id,
    kind: 'sandbox',
    type: 'memory-fixture',
    availability,
    defaultCwd: `memfs://${id}/root`,
    tools: [{
      name: 'read',
      description: 'Fixture read capability.',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    }],
  };
}

function write(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');

  if (mode === 'malformed') {
    process.stdout.write('not-json');
    return;
  }
  if (mode === 'multiple') {
    process.stdout.write('{}\n{}');
    return;
  }
  if (mode === 'oversized') {
    process.stdout.write('x'.repeat(300 * 1024));
    return;
  }

  const request = JSON.parse(raw);
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, request })}\n`);

  if (mode === 'hang' || mode === 'stderr-overflow') {
    process.on('SIGTERM', () => {});
    if (mode === 'stderr-overflow') process.stderr.write(`private-${'x'.repeat(70 * 1024)}`);
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === 'nonzero') {
    process.stderr.write('super-secret-provider-detail');
    process.exitCode = 7;
    return;
  }
  if (mode === 'signal') {
    process.kill(process.pid, 'SIGTERM');
    return;
  }

  const response: Record<string, unknown> = {
    protocol: PROTOCOL,
    providerId: request.providerId,
    requestId: request.requestId,
    operation: request.operation,
    ok: true,
  };
  if (mode === 'protocol-mismatch') response.protocol = 'foxwarm-node-provider@999';
  if (mode === 'provider-mismatch') response.providerId = 'wrong-provider';
  if (mode === 'request-mismatch') response.requestId = 'wrong-request';
  if (mode === 'operation-mismatch') response.operation = request.operation === 'list' ? 'invoke' : 'list';

  if (request.operation === 'list') {
    const primaryId = mode === 'slash-id'
      ? 'fixture/sandbox'
      : mode === 'reserved-id'
        ? 'MASTER'
        : mode === 'colon-id'
          ? 'fixture:sandbox'
          : 'fixture-sandbox';
    if (mode === 'bad-descriptor') {
      response.result = { nodes: [{ ...descriptor(), kind: 'master' }] };
    } else if (mode === 'oversized-schema') {
      response.result = { nodes: [{ ...descriptor(), tools: [{ name: 'read', parameters: { value: 'x'.repeat(20 * 1024) } }] }] };
    } else {
      response.result = {
        nodes: [
          descriptor(primaryId, mode === 'unavailable' ? 'unavailable' : 'ready'),
          descriptor('fixture-secondary'),
        ],
      };
    }
    if (mode === 'bad-envelope') response.error = { code: 'Unexpected', message: 'must not coexist with result' };
    if (mode === 'inherited-stdio') {
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      grandchild.unref();
    }
    write(response);
    return;
  }

  if (mode === 'error') {
    delete response.result;
    response.ok = false;
    response.error = { code: 'FixtureDenied', message: 'fixture rejected the complete tool call', retryable: false };
    write(response);
    return;
  }
  if (mode === 'oversized-invoke') {
    response.result = { output: 'x'.repeat(9 * 1024 * 1024) };
    write(response);
    return;
  }

  response.result = {
    output: 'fixture-read',
    observed: request.request,
    environmentHasTestSecret: Object.prototype.hasOwnProperty.call(process.env, 'FOXWARM_PROVIDER_SECRET_TEST'),
  };
  write(response);
}

main().catch((error) => {
  process.stderr.write(error?.stack || String(error));
  process.exitCode = 1;
});
