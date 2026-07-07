import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpServer, setHttpServer } from '../httpServer';
import * as sessionManager from '../sessionManager';
import { WebUIChannel } from './webuiChannel';
import type { Session } from '../types';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('WebUI sessions route treats bare wait as idle while preserving busy fields', async () => {
  const sessionId = makeSessionId('webui_runtime_state');
  const session = await sessionManager.getSession(sessionId);
  session.agent = 'main';
  session.history = [];
  session.persistentMemorySnapshot = '';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.busy = false;
  session.busyStartedAt = undefined;
  session.queue = [];
  session.meta = {
    lastMessageTime: Date.now(),
    wait: {
      id: 'webui-bare-wait',
      startedAt: Date.now() - 1000,
    },
  } as Session['meta'];
  await sessionManager.saveSession(sessionId);

  const port = 34200 + Math.floor(Math.random() * 500);
  const server = new HttpServer(port, 'runtime-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'runtime-token', enableTrigger: false, enableWebUI: true });
  await server.start();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Authorization: 'Bearer runtime-token' },
    });
    assert.equal(res.status, 200);
    const payload = await res.json() as any;
    const listed = payload.sessions.find((item: any) => item.id === sessionId);
    assert.ok(listed);
    assert.equal(listed.busy, false);
    assert.equal(listed.busyStartedAt, null);
    assert.equal(listed.queueLength, 0);
    assert.equal(listed.runtimeState.state, 'idle');
    assert.equal(listed.runtimeState.busy, false);
    assert.equal(listed.runtimeState.waiting, undefined);
  } finally {
    await server.stop();
    setHttpServer(null);
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});
