import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PROTOCOL = 'foxwarm-node-provider@1';
const mode = process.argv[2] || 'normal';
const logPath = process.argv[3];
const statePath = logPath ? `${logPath}.nodes.json` : '';
const filesPath = logPath ? `${logPath}.files.json` : '';

function descriptor(id = 'fixture-sandbox', availability = 'ready') {
  return {
    id,
    kind: 'sandbox',
    type: 'memory-fixture',
    availability,
    defaultCwd: `memfs://${id}/root`,
    filesystem: mode === 'read-only' ? 'read' : 'read-write',
    ...(mode === 'with-exec' ? { exec: true } : {}),
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
  if (mode === 'operation-mismatch') response.operation = request.operation === 'list' ? 'filesystem' : 'list';

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
      response.result = { nodes: [{ ...descriptor(), filesystem: 'provider-defined' }] };
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

  if (request.operation === 'filesystem') {
    const primitive = request.request || {};
    const files: Record<string, string> = filesPath && fs.existsSync(filesPath) ? JSON.parse(fs.readFileSync(filesPath, 'utf8')) : {};
    const key = String(primitive.path);
    const content = Object.prototype.hasOwnProperty.call(files, key) ? files[key] : 'fixture-read';
    if (primitive.operation === 'parent') {
      const split = key.lastIndexOf('/');
      response.result = { path: split > 'memfs://'.length ? key.slice(0, split) : key };
    } else if (primitive.operation === 'stat') response.result = { kind: 'file', size: Buffer.byteLength(content), modifiedAtMs: 1 };
    else if (primitive.operation === 'read') response.result = { dataBase64: Buffer.from(content).subarray(primitive.offset, primitive.offset + primitive.count).toString('base64') };
    else if (primitive.operation === 'readdir') response.result = [];
    else if (primitive.operation === 'write') {
      if (primitive.flag === 'wx' && Object.prototype.hasOwnProperty.call(files, key)) {
        response.ok = false; response.error = { code: 'EEXIST', message: 'File exists.', retryable: false };
      } else {
        files[key] = Buffer.from(primitive.contentBase64, 'base64').toString('utf8');
        if (filesPath) fs.writeFileSync(filesPath, JSON.stringify(files));
        response.result = null;
      }
    } else if (primitive.operation === 'remove') {
      delete files[key]; if (filesPath) fs.writeFileSync(filesPath, JSON.stringify(files)); response.result = null;
    } else response.result = null;
    write(response);
    return;
  }
  if (request.operation === 'exec') {
    response.result = { output: 'fixture-exec', observed: request.request };
    write(response);
    return;
  }
  response.ok = false;
  response.error = { code: 'UnsupportedOperation', message: `Unsupported ${request.operation}`, retryable: false };
  write(response);
}

main().catch((error) => {
  process.stderr.write(error?.stack || String(error));
  process.exitCode = 1;
});
