import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpServer, setHttpServer } from '../httpServer';
import { WebUIChannel } from './webuiChannel';
import * as sessionManager from '../sessionManager';

function missingSessionId(): string {
  return `trigger_missing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('trigger rejects an unavailable explicit target without creating or retargeting it', async () => {
  const token = 'trigger-test-token';
  const server = new HttpServer(0, token);
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token, enableTrigger: true, enableWebUI: false });
  await server.start();
  const port = ((server as any).httpServer.address() as { port: number }).port;
  const sessionId = missingSessionId();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'should not create', sessionId }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error || '', new RegExp(`Session \\"${sessionId}\\" is unavailable`));
    assert.equal(sessionManager.getAllSessions().has(sessionId), false);
  } finally {
    await server.stop();
    setHttpServer(null);
  }
});
