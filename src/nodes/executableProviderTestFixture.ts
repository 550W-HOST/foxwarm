import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PROTOCOL = 'foxwarm-node-provider@1';
const mode = process.argv[2] || 'normal';
const logPath = process.argv[3];
const statePath = logPath ? `${logPath}.nodes.json` : '';

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

function readDynamicNodes(): ReturnType<typeof descriptor>[] {
  if (!statePath || !fs.existsSync(statePath)) return [];
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeDynamicNodes(nodes: ReturnType<typeof descriptor>[]): void {
  if (statePath) fs.writeFileSync(statePath, JSON.stringify(nodes));
}

function currentNodes(primaryId = 'fixture-sandbox'): ReturnType<typeof descriptor>[] {
  return [descriptor(primaryId), descriptor('fixture-secondary'), ...readDynamicNodes()];
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
        nodes: currentNodes(primaryId).map((node, index) => index === 0 && mode === 'unavailable'
          ? { ...node, availability: 'unavailable' }
          : node),
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

  if (['create', 'ensure', 'inspect', 'destroy'].includes(request.operation)) {
    if (mode === 'unsupported-lifecycle') {
      response.ok = false;
      response.error = { code: 'UnsupportedOperation', message: `fixture does not support ${request.operation}`, retryable: false };
      write(response);
      return;
    }
    if (mode === 'lifecycle-oversized') {
      response.result = { node: descriptor('oversized-node'), details: { value: 'x'.repeat(600 * 1024) } };
      write(response);
      return;
    }
    if (mode === 'lifecycle-malformed') {
      response.result = { unexpected: true };
      write(response);
      return;
    }
    const lifecycleRequest = request.request || {};
    if (request.operation === 'create' || request.operation === 'ensure') {
      const requestedId = typeof lifecycleRequest.nodeId === 'string' ? lifecycleRequest.nodeId : 'fixture-created';
      const dynamic = readDynamicNodes();
      let node = currentNodes().find(candidate => candidate.id === requestedId);
      if (!node) {
        node = descriptor(requestedId);
        dynamic.push(node);
        writeDynamicNodes(dynamic);
      } else if (request.operation === 'create') {
        response.ok = false;
        response.error = { code: 'AlreadyExists', message: `Node ${requestedId} already exists.`, retryable: false };
        write(response);
        return;
      }
      response.result = {
        node: mode === 'lifecycle-node-mismatch' ? descriptor('wrong-node') : node,
        effect: request.operation === 'create' ? 'Fixture created or registered the requested Node.' : 'Fixture ensured the requested Node exists.',
        dataRetention: 'Fixture state persists only in its test state file.',
        details: { observed: lifecycleRequest, operation: request.operation },
      };
      write(response);
      return;
    }
    const requestedId = lifecycleRequest.nodeId;
    const node = currentNodes().find(candidate => candidate.id === requestedId);
    if (!node) {
      response.ok = false;
      response.error = { code: 'NotFound', message: `Node ${requestedId} does not exist.`, retryable: false };
      write(response);
      return;
    }
    if (request.operation === 'inspect') {
      response.result = {
        node: mode === 'lifecycle-node-mismatch' ? descriptor('wrong-node') : node,
        effect: 'Inspection has no generic mutation effect.',
        dataRetention: 'Fixture reports test-only file-backed state.',
        details: { observed: lifecycleRequest },
      };
      write(response);
      return;
    }
    writeDynamicNodes(readDynamicNodes().filter(candidate => candidate.id !== requestedId));
    response.result = {
      nodeId: mode === 'lifecycle-node-mismatch' ? 'wrong-node' : requestedId,
      effect: 'Fixture removed its test registration for the requested Node.',
      dataRetention: 'The fixture makes no claim about external data deletion.',
      details: { observed: lifecycleRequest },
    };
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
