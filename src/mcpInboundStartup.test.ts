import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try { await finished; } finally { clearTimeout(deadline); }
}

test('headless inbound config starts real Main HTTP, Node bootstrap/WS and MCP without WebUI channel', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-headless-inbound-'));
  const port = await availablePort();
  const secret = 'headless-synthetic-test-token';
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let logs = '';
  try {
    await fs.outputFile(path.join(dir, 'state', 'config.yaml'), `bot:\n  name: headless-synthetic\n  httpPort: ${port}\n  enableWebUI: false\n  enableTrigger: false\nmcpInbound:\n  enabled: true\n  identities:\n    smoke: { token: ${secret} }\nvector: false\nsessionWorkers: false\ndbWorkers: false\nchannels: {}\n`);
    child = spawn(process.execPath, [require.resolve('./index')], {
      env: { ...process.env, FOXWARM_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-30_000); });
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(500) });
        ready = response.status === 400;
        await response.body?.cancel();
        if (ready) break;
      } catch { /* Wait for Main startup. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `Headless Main did not start: ${logs.slice(-6_000)}`);
    const nodeTemplate = await fetch(`${base}/node/run.sh`);
    assert.equal(nodeTemplate.status, 200);
    assert.match(await nodeTemplate.text(), /node/i);
    assert.equal((await fetch(`${base}/api/setup/status`, { headers: { Authorization: 'Bearer instance-token' } })).status, 404);
    const token = (await fs.readFile(path.join(dir, 'state', 'node_token'), 'utf8')).trim();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/node_ws?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => { ws.close(); resolve(); });
      ws.once('error', reject);
    });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    });
    const client = new Client({ name: 'headless-smoke', version: '1.0.0' });
    await client.connect(transport);
    try {
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['foxwarm_discover', 'foxwarm_call', 'foxwarm_node', 'foxwarm_exec_result', 'foxwarm_session']);
    } finally { await client.close(); }
    await stop(child);
    assert.equal(child.exitCode, 0, `Headless Main failed to shut down cleanly: ${logs.slice(-6_000)}`);
    child = undefined;
  } finally {
    if (child) await stop(child);
    await fs.remove(dir);
  }
});
