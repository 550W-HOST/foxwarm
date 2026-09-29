import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

async function until(check: () => unknown | Promise<unknown>, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('actual POSIX shell/curl Node uses Main dispatch, bounded output and scoped background completion', { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-shell-e2e-'));
  process.env.FOXWARM_DATA_DIR = path.join(root, 'main');
  const { HttpServer } = await import('../httpServer');
  const { registerNodeHttpRoutes } = await import('./httpRoutes');
  const { registerNodeWebSocket } = await import('./websocket');
  const { default: WebSocket } = await import('ws');
  const { nodesManager } = await import('./manager');
  const registry = await import('./registry');
  const sessionManager = await import('../sessionManager');
  const { executeNodeTool, validateNodeSelection, shutdownNodeExecution } = await import('../nodeExecution');
  const { tool_wait } = await import('../toolsSessionAgent/interSession');
  const { hasRemoteExecLivenessClaim } = await import('./remoteExecLiveness');
  const { resolveSessionToolDefinitions } = await import('../llm');
  const { setNodeEventCapabilitySecretForTests } = await import('./sessionEventCapability');
  setNodeEventCapabilitySecretForTests(Buffer.alloc(32, 47));
  const server = new HttpServer(0, 'fixture-api');
  registerNodeWebSocket(server, 'unused-pairing-fixture');
  // A real reverse-proxy path strip, before the ordinary registered routes.
  server.app.use((req, _res, next) => {
    if (req.url.startsWith('/deployment/')) req.url = req.url.slice('/deployment'.length);
    next();
  });
  let dropFinishedReply = false;
  let finishedRequests = 0;
  let invalidPoll = true;
  server.app.use((req, res, next) => {
    if (invalidPoll && req.path === '/node/shell/poll') {
      invalidPoll = false;
      res.type('text/html').send(`printf unexpected > '${path.join(root, 'error-effect')}'`);
      return;
    }
    next();
  });
  server.app.use((req, res, next) => {
    if (req.path === '/node/shell/report' && req.get('X-Foxwarm-Result') === 'finished') {
      finishedRequests++;
      if (dropFinishedReply) {
        dropFinishedReply = false;
        // Drop the response after durable acceptance, not before command execution.
        const end = res.end.bind(res);
        res.end = ((...args: any[]) => { res.socket?.destroy(); return end(...args as [any]); }) as typeof res.end;
      }
    }
    next();
  });
  const stopRoutes = registerNodeHttpRoutes(server);
  let client: ChildProcess | undefined;
  let stdout = '';
  let stderr = '';
  try {
    await sessionManager.loadSessions();
    const session = await sessionManager.getSession('main/shell-source');
    session.busy = true; // retain real admitted completion in the Session mailbox/queue
    session.history = [{ role: 'user', parts: [{ text: 'fixture' }] }];
    await sessionManager.saveSession(session.id);
    const approved = await registry.createApprovedNode('shell-fixture');
    await server.start();
    const port = (server as any).httpServer.address().port;
    const host = `http://127.0.0.1:${port}/deployment`;
    const bootstrap = await fetch(`${host}/node/run-shell.sh`);
    assert.equal(bootstrap.status, 200);
    const downloaded = path.join(root, 'run-shell.sh');
    const script = await bootstrap.text();
    assert.ok(script.includes(`HOST='http://127.0.0.1:${port}'`));
    await fs.writeFile(downloaded, script);
    const oldWs = new WebSocket(`ws://127.0.0.1:${port}/node_ws?id=shell-fixture&auth=${approved.authToken}`);
    await once(oldWs, 'open');
    const oldRegistered = once(oldWs, 'message');
    oldWs.send(JSON.stringify({ type: 'node_register', nodeType: 'fixture-ws', capabilities: { tools: [{ name: 'exec' }] }, nodeProtocol: { min: 1, max: 3 } }));
    assert.equal(JSON.parse(String((await oldRegistered)[0])).type, 'registered');
    const wsClosed = once(oldWs, 'close');
    const startup = path.join(root, "node's-start");
    await fs.ensureDir(path.join(startup, 'relative'));
    const clientTmp = path.join(root, 'client-tmp');
    await fs.ensureDir(clientTmp);
    const bin = path.join(root, 'busybox-bin');
    await fs.ensureDir(bin);
    const busybox = await fs.pathExists('/usr/bin/busybox');
    if (busybox) {
      for (const app of ['sh', 'mktemp', 'mkfifo', 'dd', 'wc', 'head', 'tail', 'cat', 'mv', 'rm', 'mkdir', 'chmod', 'sleep', 'date', 'sed', 'tr']) await fs.symlink('/usr/bin/busybox', path.join(bin, app));
      await fs.symlink('/usr/bin/curl', path.join(bin, 'curl'));
    }
    client = spawn(busybox ? '/usr/bin/busybox' : '/bin/sh', [
      ...(busybox ? ['ash'] : []), downloaded, `--host=${host}`, '--node-id=shell-fixture',
    ], {
      cwd: startup, env: { ...process.env, ...(busybox ? { PATH: bin } : {}), NODE_AUTH_TOKEN: approved.authToken, TMPDIR: clientTmp }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    client.stdout!.on('data', chunk => { stdout += String(chunk); });
    client.stderr!.on('data', chunk => { stderr += String(chunk); });
    await until(() => nodesManager.getNode('shell-fixture')?.httpExec, `HTTP registration (${stderr})`);
    await wsClosed;
    assert.ok(nodesManager.getNode('shell-fixture')?.httpExec, 'the superseded WebSocket close cannot remove the HTTP Node');
    const state = path.join(clientTmp, (await fs.readdir(clientTmp))[0]);
    assert.equal((await fs.stat(path.join(state, 'auth'))).mode & 0o077, 0);
    const selected = await validateNodeSelection(session.id, 'shell-fixture');
    assert.equal(selected.defaultCwd, startup);
    session.currentNode = selected.nodeId;
    delete session.cwd;
    await sessionManager.saveSession(session.id);
    const advertised = nodesManager.listNodesWithTools().find(node => node.id === 'shell-fixture')!;
    assert.deepEqual(advertised.tools.map(tool => tool.name), ['exec']);
    const directExec = (await resolveSessionToolDefinitions(session)).find(tool => tool.name === 'exec')!;
    assert.equal(directExec.description, advertised.tools[0].description, 'direct execution uses the advertised capability, not the master implementation');
    assert.deepEqual(Object.keys(directExec.parameters.properties).filter(key => !key.startsWith('__')), ['command', 'cwd', 'timeout']);
    assert.equal(nodesManager.getNode('shell-fixture')!.ws, null);
    const short = await executeNodeTool(session.id, 'shell-fixture', 'exec', { command: 'pwd; printf hello; exit 7' });
    assert.match(short.output, new RegExp(startup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(short.output, /hello/);
    assert.equal(short.exitCode, 7);
    assert.equal(await fs.pathExists(path.join(root, 'error-effect')), false, 'an HTTP error page cannot become executable task content');
    const relative = await executeNodeTool(session.id, 'shell-fixture', 'exec', { command: 'pwd', cwd: 'relative' });
    assert.match(relative.output, /relative/);
    const unchanged = await executeNodeTool(session.id, 'shell-fixture', 'exec', { command: 'pwd' });
    assert.equal(unchanged.totalBytes, Buffer.byteLength(`${startup}\n`));

    let largeDone = false;
    let observedSampleBytes = 0;
    const largeCall = executeNodeTool(session.id, 'shell-fixture', 'exec', { command: "dd if=/dev/zero bs=65536 count=64 2>/dev/null | tr '\\000' x", timeout: 10 });
    largeCall.finally(() => { largeDone = true; }).catch(() => {});
    while (!largeDone) {
      for (const stateName of await fs.readdir(clientTmp)) {
        const stateDir = path.join(clientTmp, stateName);
        for (const taskName of await fs.readdir(stateDir).catch((): string[] => [])) {
          if (!taskName.startsWith('task-')) continue;
          for (const name of ['chunk', 'head', 'tail', 'combined', 'next-tail', 'output']) {
            const stats = await fs.stat(path.join(stateDir, taskName, name)).catch((): null => null);
            if (!stats) continue;
            observedSampleBytes = Math.max(observedSampleBytes, stats.size);
            assert.ok(stats.size <= 8192, `${name} exceeded the bounded sample allocation`);
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const large = await largeCall;
    assert.ok(observedSampleBytes >= 4096, 'large-output collector was observed while it was draining');
    assert.equal(large.totalBytes, 4 * 1024 * 1024);
    assert.equal(large.exitCode, 0, 'collector drains output without SIGPIPE');
    assert.equal(large.truncated, true);
    assert.ok(large.output.length < 9000);
    const empty = await executeNodeTool(session.id, 'shell-fixture', 'exec', { command: ':' });
    assert.equal(empty.totalBytes, 0);
    const overlap = await executeNodeTool(session.id, 'shell-fixture', 'exec', { command: "dd if=/dev/zero bs=6000 count=1 2>/dev/null | tr '\\000' z" });
    assert.equal(overlap.totalBytes, 6000);
    assert.equal(overlap.output.split('\n')[0].length, 6000, 'head/tail overlap is not duplicated');
    const binary = await executeNodeTool(session.id, 'shell-fixture', 'exec', { command: "printf '\\000\\377'" });
    assert.match(binary.output, /hexadecimal.*\n00ff/);

    dropFinishedReply = true;
    const beforeReports = finishedRequests;
    const background = await executeNodeTool(session.id, 'shell-fixture', 'exec', { command: 'printf once >> effect; sleep 4; printf completed', timeout: 1 });
    assert.ok(background.execId);
    assert.equal(hasRemoteExecLivenessClaim([session.id], 'main', background.execId), true);
    const wait = await tool_wait({ waitExecIds: [background.execId] }, { sessionId: session.id, session } as any);
    assert.ok(wait);
    const oldTransport = nodesManager.getNode('shell-fixture')!.httpExec!;
    const replacement = await fetch(`${host}/node/shell/register`, {
      method: 'POST', headers: { 'X-Foxwarm-Node': 'shell-fixture', Authorization: `Bearer ${approved.authToken}`, 'Content-Type': 'application/octet-stream' }, body: startup,
    });
    assert.equal(replacement.status, 204);
    const newTransport = nodesManager.getNode('shell-fixture')!.httpExec;
    assert.notEqual(oldTransport, newTransport);
    nodesManager.disconnectHttpExecNode('shell-fixture', oldTransport, 'stale callback');
    assert.equal(nodesManager.getNode('shell-fixture')!.httpExec, newTransport);
    // Moving the current Node does not change the signed original Session target.
    session.currentNode = 'master';
    await sessionManager.saveSession(session.id);
    await until(() => session.queue?.some(item => item.execId === background.execId), 'real Session completion');
    await until(() => finishedRequests >= beforeReports + 2, 'completion retry after lost ACK');
    assert.equal(session.queue.filter(item => item.execId === background.execId).length, 1);
    assert.equal(await fs.readFile(path.join(startup, 'effect'), 'utf8'), 'once');
    assert.equal(hasRemoteExecLivenessClaim([session.id], 'main', background.execId), false);
    assert.ok(session.meta.acceptedExternalEventIds?.includes(`remote-exec-completion:${background.execId}`));
    assert.match(JSON.stringify(session.queue.find(item => item.execId === background.execId)), /completed/);
    assert.equal(stdout.includes(approved.authToken) || stderr.includes(approved.authToken), false);
    const bad = await fetch(`${host}/node/shell/register`, { method: 'POST', headers: { 'X-Foxwarm-Node': 'shell-fixture', Authorization: 'Bearer bad', 'Content-Type': 'application/octet-stream' }, body: startup });
    assert.equal(bad.status, 401);
    await registry.removeApprovedNode('shell-fixture');
    nodesManager.disconnectNode('shell-fixture', 'fixture revoked');
    await until(() => client?.exitCode !== null, 'client stops after revoke');
    assert.equal(nodesManager.getNode('shell-fixture'), undefined);
  } finally {
    client?.kill('SIGTERM');
    stopRoutes();
    await server.stop();
    if (client && client.exitCode === null) await until(() => client!.exitCode !== null || client!.signalCode !== null, 'client cleanup');
    await shutdownNodeExecution();
    setNodeEventCapabilitySecretForTests();
    await fs.remove(root);
  }
});
