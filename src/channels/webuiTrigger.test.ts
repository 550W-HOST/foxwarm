import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpServer, setHttpServer } from '../httpServer';
import { WebUIChannel } from './webuiChannel';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';

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
  const originalGetSessionCatalog = sessionManager.getSessionCatalog;
  const originalQueueEvent = sessionRuntime.queueEvent;
  const queued: Array<{ sessionId: string; text: string; type: string }> = [];

  try {
    const postTrigger = async (body: Record<string, string>) => fetch(`http://127.0.0.1:${port}/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const response = await postTrigger({ text: 'should not create', sessionId });
    assert.equal(response.status, 400);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error || '', new RegExp(`Session \\"${sessionId}\\" is unavailable`));
    assert.equal(sessionManager.getAllSessions().has(sessionId), false);

    (sessionManager as any).getSessionCatalog = (requestedId: string) => requestedId === 'main'
      ? undefined
      : originalGetSessionCatalog(requestedId);
    const omittedResponse = await postTrigger({ text: 'main must remain absent' });
    assert.equal(omittedResponse.status, 400);
    const omittedPayload = await omittedResponse.json() as { error?: string };
    assert.match(omittedPayload.error || '', /Session "main" is unavailable/);
    assert.equal(sessionManager.getAllSessions().has('main'), false);

    const existingSession = await sessionManager.getSession(missingSessionId());
    (sessionRuntime as any).queueEvent = async (targetSessionId: string, text: string, type: string) => {
      queued.push({ sessionId: targetSessionId, text, type });
    };
    const existingResponse = await postTrigger({ text: 'queue this', sessionId: existingSession.id });
    assert.equal(existingResponse.status, 200);
    assert.deepEqual(queued, [{ sessionId: existingSession.id, text: 'queue this', type: 'trigger' }]);
    await sessionManager.deleteSession(existingSession.id);
  } finally {
    (sessionManager as any).getSessionCatalog = originalGetSessionCatalog;
    (sessionRuntime as any).queueEvent = originalQueueEvent;
    await server.stop();
    setHttpServer(null);
  }
});
