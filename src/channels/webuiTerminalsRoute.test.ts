import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { HttpServer, setHttpServer } from '../httpServer';
import { WebUIChannel } from './webuiChannel';
import { closeTerminal } from '../terminalManager';

const TEST_TOKEN = 'terminal-route-token';

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  const port = 34600 + Math.floor(Math.random() * 500);
  const server = new HttpServer(port, TEST_TOKEN);
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: TEST_TOKEN, enableTrigger: false, enableWebUI: true });
  await server.start();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.stop();
    setHttpServer(null);
  }
}

function bearerHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

test('WebUI terminal API creates terminals from cwd without requiring sessionId', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-terminal-route-'));
  let terminalId = '';
  try {
    await withServer(async (baseUrl) => {
      const missingCwd = await fetch(`${baseUrl}/api/terminals`, {
        method: 'POST',
        headers: bearerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ cols: 40, rows: 10 }),
      });
      assert.equal(missingCwd.status, 400);
      assert.match(await missingCwd.text(), /cwd is required/);

      const create = await fetch(`${baseUrl}/api/terminals`, {
        method: 'POST',
        headers: bearerHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ cwd, nodeId: 'master', cols: 40, rows: 10 }),
      });
      assert.equal(create.status, 200);
      const createPayload = await create.json() as any;
      assert.equal(createPayload.success, true);
      assert.equal(createPayload.terminal.cwd, cwd);
      assert.equal(createPayload.terminal.nodeId, 'master');
      assert.equal(createPayload.terminal.sessionId, undefined);
      terminalId = createPayload.terminal.id;
      assert.ok(terminalId);

      const list = await fetch(`${baseUrl}/api/terminals?sessionId=legacy-session`, { headers: bearerHeaders() });
      assert.equal(list.status, 200);
      const listPayload = await list.json() as any;
      assert.ok(listPayload.terminals.some((terminal: any) => terminal.id === terminalId));

      const get = await fetch(`${baseUrl}/api/terminals/${encodeURIComponent(terminalId)}`, { headers: bearerHeaders() });
      assert.equal(get.status, 200);
      const getPayload = await get.json() as any;
      assert.equal(getPayload.terminal.id, terminalId);
      assert.equal(getPayload.terminal.sessionId, undefined);

      const close = await fetch(`${baseUrl}/api/terminals/${encodeURIComponent(terminalId)}`, {
        method: 'DELETE',
        headers: bearerHeaders(),
      });
      assert.equal(close.status, 200);
      terminalId = '';
    });
  } finally {
    if (terminalId) {
      await closeTerminal(terminalId, 'test-cleanup').catch((): void => undefined);
    }
    await fs.remove(cwd).catch((): void => undefined);
  }
});
