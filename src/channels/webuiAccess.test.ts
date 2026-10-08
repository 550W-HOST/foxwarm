import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { HttpServer, setHttpServer } from '../httpServer';
import { normalizeAccessConfig } from '../accessConfig';
import { WebUIChannel } from './webuiChannel';
import * as sessionManager from '../sessionManager';
import { initializeSessionRuntime, shutdownSessionRuntime } from '../sessionRuntime';

async function withWebUiServer(
  accessConfig: ReturnType<typeof normalizeAccessConfig>,
  run: (baseUrl: string, adminToken: string, webUiToken: string, mcpToken: string, calls: { count: number }) => Promise<void>,
): Promise<void> {
  const port = 34100 + Math.floor(Math.random() * 1000);
  const adminToken = `admin-${Math.random().toString(36).slice(2)}`;
  const webUiToken = 'synthetic-webui-token';
  const mcpToken = 'synthetic-mcp-token';
  const server = new HttpServer(port, adminToken);
  const calls = { count: 0 };
  setHttpServer(server);
  await server.start();
  const channel = new WebUIChannel({
    token: adminToken,
    accessConfig,
    enableTrigger: false,
    router: { handleMessage: async () => { calls.count += 1; } } as any,
  });
  await channel.start();
  try {
    await run(`http://127.0.0.1:${port}`, adminToken, webUiToken, mcpToken, calls);
  } finally {
    await channel.stop().catch(() => {});
    await server.stop().catch(() => {});
    setHttpServer(null);
  }
}

test('unified access config authenticates WebUI identities and keeps MCP-only identities separate', async () => {
  await sessionManager.loadSessions();
  await initializeSessionRuntime();
  const suffix = Math.random().toString(36).slice(2, 9);
  const bound = `access_webui_bound_${suffix}`;
  const unbound = `access_webui_unbound_${suffix}`;
  await sessionManager.createEmptySession(bound);
  await sessionManager.createEmptySession(unbound);
  const accessConfig = normalizeAccessConfig({ identities: {
    webui: { token: 'synthetic-webui-token', surfaces: { webui: { sessions: [bound] } } },
    mcp: { token: 'synthetic-mcp-token', surfaces: { mcp: {} } },
  } });
  try {
    await withWebUiServer(accessConfig, async (baseUrl, adminToken, webUiToken, mcpToken, calls) => {
      const webUiLogin = await fetch(`${baseUrl}/api/auth`, { signal: AbortSignal.timeout(5000),
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: webUiToken }),
      });
      assert.equal(webUiLogin.status, 200);
      assert.deepEqual((await webUiLogin.json() as any), {
        success: true,
        role: 'webui',
        identityId: 'webui',
        sessionIds: [bound],
        features: {
          chat: true, attachments: true, commands: false, terminal: false, workspace: false,
          setup: false, settings: false, sessionManagement: false, debug: false,
          modelSelection: false, sidebar: false,
        },
      });

      const mcpLogin = await fetch(`${baseUrl}/api/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mcpToken }),
      });
      assert.equal(mcpLogin.status, 401);

      const listed = await fetch(`${baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${webUiToken}` } });
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json() as any).sessions.map((session: any) => session.id), [bound]);

      const mcpHistory = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(bound)}/history`, {
        headers: { Authorization: `Bearer ${mcpToken}` },
      });
      assert.equal(mcpHistory.status, 401);

      const deniedHistory = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(unbound)}/history`, {
        headers: { Authorization: `Bearer ${webUiToken}` },
      });
      assert.equal(deniedHistory.status, 403);

      const accepted = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(bound)}/message`, {
        method: 'POST', headers: { Authorization: `Bearer ${webUiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello from unified webui identity' }),
      });
      assert.equal(accepted.status, 200);
      assert.equal(calls.count, 1);

      const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/webui/stream`, {
        headers: { Authorization: `Bearer ${webUiToken}` },
      });
      const frames: any[] = [];
      socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: false,
        sessionListIds: [], sessionIds: [bound] }));
      for (let attempt = 0; attempt < 100 && !frames.some(frame => frame.type === 'subscriptions-applied'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(frames.some(frame => frame.type === 'subscriptions-applied'), true);
      assert.equal(frames.some(frame => frame.type === 'session-state' && frame.sessionId === bound), true);
      socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 2, sessionListActive: false,
        sessionListIds: [], sessionIds: [unbound] }));
      for (let attempt = 0; attempt < 100 && !frames.some(frame => frame.type === 'protocol-error'); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(frames.some(frame => frame.type === 'protocol-error'), true);
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, 'close');
        socket.terminate();
        await closed;
      }

      const adminListed = await fetch(`${baseUrl}/api/sessions`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert.equal(adminListed.status, 200);
      const adminIds = new Set((await adminListed.json() as any).sessions.map((session: any) => session.id));
      assert.equal(adminIds.has(bound), true);
      assert.equal(adminIds.has(unbound), true);
    });
  } finally {
    await sessionManager.deleteSession(bound).catch(() => {});
    await sessionManager.deleteSession(unbound).catch(() => {});
    await shutdownSessionRuntime().catch(() => {});
  }
});
