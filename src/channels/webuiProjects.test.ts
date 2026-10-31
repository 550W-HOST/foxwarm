import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { HttpServer } from '../httpServer';
import { ProjectStore } from '../projectStore';
import { registerWebUiProjectRoutes } from './webuiProjects';
import { getAgentDir } from '../config';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { nodesManager } from '../nodes/manager';
import { WebSocket } from 'ws';

test('project directory validation, resource grouping, authentication, idempotency and restart persistence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-project-test-'));
  const dbPath = path.join(root, 'projects.sqlite');
  const directory = path.join(root, 'a project');
  await fs.ensureDir(directory);
  await fs.ensureDir(getAgentDir('main'));
  await sessionManager.loadSessions();
  await sessionRuntime.initializeSessionRuntime();
  const store = new ProjectStore(dbPath);
  const server = new HttpServer(0, 'synthetic-project-token');
  registerWebUiProjectRoutes(server, { store });
  await server.start();
  const origin = `http://127.0.0.1:${(server as any).httpServer.address().port}`;
  const headers = { Authorization: 'Bearer synthetic-project-token', 'Content-Type': 'application/json' };
  const call = (route: string, method = 'GET', body?: object) => fetch(origin + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const requests: any[] = [];
  const fakeNode = {
    readyState: WebSocket.OPEN,
    close() {},
    send(raw: string) {
      const request = JSON.parse(raw);
      requests.push(request);
      if (request.type === 'tool_call') queueMicrotask(() => nodesManager.handleToolResponse(request.callId, { output: '/opt/foxwarm-node/foxwarm-node' }, 'fake-worker'));
      if (request.type === 'node_service_request') queueMicrotask(() => nodesManager.handleNodeServiceResponse('fake-worker', request.requestId,
        request.operation === 'stat' ? { type: 2, ctime: 0, mtime: 0, size: 0 } : { entries: [] }));
    },
  };
  nodesManager.registerNodeWithTools(fakeNode as any, {} as any, 'cli-node', {
    tools: [{ name: 'get_default_cwd', description: 'Working directory' }], services: { 'vscode-fs': 1 },
  }, 'fake-worker');
  try {
    assert.equal((await fetch(origin + '/api/projects')).status, 401);
    assert.equal((await call('/api/projects', 'POST', { nodeId: 'master', rootPath: 'relative' })).status, 400);
    assert.equal((await call('/api/projects', 'POST', { nodeId: 'missing-node', rootPath: directory })).status, 503);
    assert.equal((await call('/api/projects', 'POST', { nodeId: 'master', rootPath: path.join(root, 'missing') })).status, 400);
    const first = await (await call('/api/projects', 'POST', { nodeId: 'master', rootPath: `${directory}/../a project/.`, name: 'Example' })).json() as any;
    assert.equal(first.project.rootPath, directory);
    const duplicate = await (await call('/api/projects', 'POST', { nodeId: 'master', rootPath: directory })).json() as any;
    assert.equal(duplicate.project.id, first.project.id);
    const second = store.createProject('Other host', 'other-node', directory);
    assert.notEqual(second.id, first.project.id);
    const remoteResponse = await call('/api/projects', 'POST', { nodeId: 'fake-worker' });
    assert.equal(remoteResponse.status, 200);
    const remoteProject = (await remoteResponse.json() as any).project;
    assert.equal(remoteProject.rootPath, '/opt/foxwarm-node/foxwarm-node');
    assert.ok(requests.some(request => request.type === 'tool_call' && request.tool === 'get_default_cwd'));
    assert.ok(requests.some(request => request.type === 'node_service_request' && request.operation === 'stat' && request.args.path === remoteProject.rootPath));
    const remoteWork = (await (await call(`/api/projects/${remoteProject.id}/sessions`, 'POST', { title: 'Remote' })).json() as any).session;
    const remoteTabResponse = await call(`/api/project-sessions/${remoteWork.id}/tabs`, 'POST', { type: 'agent', requestId: 'remote-agent' });
    const remoteTab = await remoteTabResponse.json() as any;
    assert.equal(remoteTabResponse.status, 200, JSON.stringify(remoteTab));
    const remoteSession = await sessionRuntime.getSession(remoteTab.tab.resourceId);
    assert.equal(remoteSession?.currentNode, 'fake-worker');
    assert.equal(remoteSession?.cwd, remoteProject.rootPath);
    const session = (await (await call(`/api/projects/${first.project.id}/sessions`, 'POST', { title: 'Build' })).json() as any).session;
    const terminal = (await (await call(`/api/project-sessions/${session.id}/tabs`, 'POST', { type: 'terminal', requestId: 'retry-1' })).json() as any).tab;
    const repeated = (await (await call(`/api/project-sessions/${session.id}/tabs`, 'POST', { type: 'terminal', requestId: 'retry-1' })).json() as any).tab;
    assert.equal(terminal.id, repeated.id);
    assert.equal((await call(`/api/project-sessions/${session.id}/tabs`, 'POST', { type: 'code', requestId: 'retry-1' })).status, 409);
    const agentUrl = `/api/project-sessions/${session.id}/tabs`;
    const concurrent = await Promise.all([
      call(agentUrl, 'POST', { type: 'agent', requestId: 'agent-retry' }),
      call(agentUrl, 'POST', { type: 'agent', requestId: 'agent-retry' }),
    ]);
    assert.deepEqual(concurrent.map(response => response.status), [200, 200]);
    const agents = await Promise.all(concurrent.map(response => response.json() as Promise<any>));
    assert.equal(agents[0].tab.id, agents[1].tab.id);
    assert.equal(agents[0].tab.resourceId, agents[1].tab.resourceId);
    const runtime = await sessionRuntime.getSession(agents[0].tab.resourceId);
    assert.equal(runtime?.currentNode, 'master');
    assert.equal(runtime?.cwd, directory);
    const otherAgent = await (await call(agentUrl, 'POST', { type: 'agent', requestId: 'agent-second' })).json() as any;
    assert.notEqual(otherAgent.tab.resourceId, agents[0].tab.resourceId);
    const secondSession = (await (await call(`/api/projects/${first.project.id}/sessions`, 'POST', { title: 'Other' })).json() as any).session;
    assert.equal((await call(`/api/project-sessions/${secondSession.id}/tabs`, 'POST', { type: 'agent', requestId: 'already-linked', existingSessionId: agents[0].tab.resourceId })).status, 409);
    assert.equal(store.getSession(secondSession.id)?.tabs.length, 0, 'failed existing association rolls back the reservation');
    const movedDirectory = path.join(root, 'temporarily-unavailable');
    await fs.move(directory, movedDirectory);
    assert.equal((await call(agentUrl, 'POST', { type: 'agent', requestId: 'failed-then-retry' })).status, 400);
    const pending = store.findTabByRequestId('failed-then-retry')!;
    assert.equal(pending.state, 'pending');
    assert.equal(sessionManager.getSessionCatalog(pending.resourceId!), undefined, 'failure before creation does not create a Session');
    await fs.move(movedDirectory, directory);
    const recovered = await (await call(agentUrl, 'POST', { type: 'agent', requestId: 'failed-then-retry' })).json() as any;
    assert.equal(recovered.tab.id, pending.id);
    assert.equal(recovered.tab.resourceId, pending.resourceId);
    assert.equal(recovered.tab.state, 'ready');
    assert.equal((await call(`/api/projects/${first.project.id}`, 'PATCH', { archived: true })).status, 200);
    assert.equal((await call(`/api/projects/${first.project.id}/sessions`, 'POST', {})).status, 404);
    assert.ok(store.getProject(first.project.id)?.sessions[0].tabs.some(tab => tab.id === terminal.id));
  } finally {
    nodesManager.unregisterNode('fake-worker');
    await server.stop();
    store.close();
  }
  const reopened = new ProjectStore(dbPath);
  assert.equal(reopened.list().length, 3);
  assert.equal(reopened.list().find(item => item.nodeId === 'master')?.sessions.find(item => item.title === 'Build')?.tabs.length, 4);
  reopened.close();
  await fs.remove(root);
});
