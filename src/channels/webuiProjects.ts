import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { randomUUID } from 'node:crypto';
import path from 'path';
import express from 'express';
import { HttpServer } from '../httpServer';
import { getAgentDir } from '../config';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { validateNodeSelection } from '../nodeExecution';
import { nodesManager } from '../nodes/manager';
import { ProjectStore, type ProjectTab, type ProjectTabType } from '../projectStore';

function string(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}
function id(value: unknown): string { return string(Array.isArray(value) ? value[0] : value, 'id', 128); }
function optionalBool(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('archived must be a boolean.');
  return value;
}
function normalizeRoot(value: string): string {
  if (value.includes('\0') || value.length > 4096 || !path.posix.isAbsolute(value) || value.includes('\\')) {
    throw new Error('Project directory must be an absolute POSIX path.');
  }
  return path.posix.normalize(value).replace(/\/$/, '') || '/';
}
async function resolveRoot(nodeId: string, requested: unknown): Promise<string> {
  let root: string;
  if (requested === undefined || requested === null || requested === '') {
    root = nodeId === 'master' ? getAgentDir('main') : await nodesManager.getDefaultCwdForProject(nodeId);
  } else {
    if (typeof requested !== 'string') throw new Error('Project directory must be a string.');
    root = requested;
  }
  root = normalizeRoot(root);
  if (nodeId === 'master') {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('Project path is not a directory.');
    await fs.access(root, fsConstants.R_OK | fsConstants.X_OK);
  } else {
    const stat = await nodesManager.requestNodeService(nodeId, 'vscode-fs', 'stat', { path: root });
    if (!stat || typeof stat.type !== 'number' || (stat.type & 2) !== 2) throw new Error('Project path is not a directory.');
    // Reading the directory verifies traversal/list access on the target Node.
    await nodesManager.requestNodeService(nodeId, 'vscode-fs', 'read-directory', { path: root });
  }
  return root;
}

export function registerWebUiProjectRoutes(server: HttpServer, options?: { store?: ProjectStore; onSessionCreated?: () => void }): void {
  const store = options?.store || new ProjectStore();
  const creating = new Map<string, Promise<ProjectTab>>();
  const route = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', routePath: string, fn: (req: express.Request) => Promise<unknown>) => {
    server.addRoute({ method, path: routePath, handler: async (req, res) => {
      try { res.json(await fn(req)); }
      catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        const status = typeof error?.statusCode === 'number' ? error.statusCode : /not found/i.test(message) ? 404 : /already|conflict/i.test(message) ? 409 : 400;
        res.status(status).json({ error: message });
      }
    } });
  };
  route('GET', '/api/projects', async req => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.min(100000, Math.max(0, Number(req.query.offset) || 0));
    const projects = store.list(Math.floor(limit), Math.floor(offset));
    return { projects, nextOffset: projects.length === limit ? offset + limit : null };
  });
  route('POST', '/api/projects/resolve-directory', async req => {
    const nodeId = string(req.body?.nodeId, 'nodeId', 256);
    return { nodeId, rootPath: await resolveRoot(nodeId, req.body?.rootPath) };
  });
  route('POST', '/api/projects', async req => {
    const nodeId = string(req.body?.nodeId, 'nodeId', 256);
    const rootPath = await resolveRoot(nodeId, req.body?.rootPath);
    const name = req.body?.name ? string(req.body.name, 'name') : path.posix.basename(rootPath) || nodeId;
    return { project: store.createProject(name, nodeId, rootPath) };
  });
  route('PATCH', '/api/projects/:id', async req => {
    const name = req.body?.name === undefined ? undefined : string(req.body.name, 'name');
    return { project: store.updateProject(id(req.params.id), { name, archived: optionalBool(req.body?.archived) }) };
  });
  route('POST', '/api/projects/:id/sessions', async req => {
    const title = req.body?.title ? string(req.body.title, 'title') : 'New session';
    return { session: store.createSession(id(req.params.id), title) };
  });
  route('PATCH', '/api/project-sessions/:id', async req => {
    const title = req.body?.title === undefined ? undefined : string(req.body.title, 'title');
    return { session: store.updateSession(id(req.params.id), { title, archived: optionalBool(req.body?.archived) }) };
  });
  route('POST', '/api/project-sessions/:id/tabs', async req => {
    const session = store.getSession(id(req.params.id));
    if (!session || session.archived) throw new Error('Workspace session not found or archived.');
    const project = store.getProject(session.projectId);
    if (!project || project.archived) throw new Error('Project not found or archived.');
    const type = req.body?.type as ProjectTabType;
    if (!['agent', 'terminal', 'code'].includes(type)) throw new Error('Invalid tab type.');
    const title = req.body?.title ? string(req.body.title, 'title') : ({ agent: 'Agent', terminal: 'Terminal', code: 'Code' } as const)[type];
    const requestId = req.body?.requestId === undefined ? (type === 'agent' ? randomUUID() : undefined) : string(req.body.requestId, 'requestId', 128);
    const existingSessionId = type === 'agent' && req.body?.existingSessionId !== undefined
      ? string(req.body.existingSessionId, 'existingSessionId', 512) : undefined;
    const existingSession = existingSessionId ? await sessionRuntime.getSession(existingSessionId) : null;
    if (existingSessionId && !existingSession) throw new Error('Existing Agent session not found.');
    if (existingSession && ((existingSession.currentNode || 'master') !== project.nodeId || existingSession.cwd !== project.rootPath)) {
      throw new Error('Existing Agent session must already use the project node and directory.');
    }
    const previouslyReserved = requestId ? store.findTabByRequestId(requestId) : undefined;
    const agentId = type === 'agent' ? (existingSession?.agent || (req.body?.agentId ? string(req.body.agentId, 'agentId', 128) : previouslyReserved?.agentId || 'main')) : undefined;
    if (agentId) {
      sessionManager.validateAgentName(agentId);
      const bound = sessionManager.getAgentIsolationNode(agentId);
      if (bound && bound !== project.nodeId) throw new Error(`Agent is bound to node ${bound}; choose a project on that node.`);
    }
    if (existingSession) {
      return { tab: store.linkExistingAgent(session.id, title, requestId, existingSession.id, agentId!) };
    }
    const tab = store.createTab(session.id, type, title, requestId, agentId);
    if (type !== 'agent' || tab.state === 'ready') return { tab };
    const expectedRuntimeId = `${agentId === 'main' ? '' : `${agentId}/`}project_${tab.id.replace(/-/g, '')}`;
    if (tab.resourceId && tab.resourceId !== expectedRuntimeId) throw new Error('Request ID was already used with a different Agent.');
    let pending = creating.get(tab.id);
    if (!pending) {
      pending = (async () => {
        const sessionName = `project_${tab.id.replace(/-/g, '')}`;
        const runtimeId = agentId === 'main' ? sessionName : `${agentId}/${sessionName}`;
        if (tab.resourceId && tab.resourceId !== runtimeId) throw new Error('Request ID was already used with a different Agent.');
        store.updateTab(tab.id, { resourceId: runtimeId });
        if (!sessionManager.getSessionCatalog(runtimeId)) {
          await resolveRoot(project.nodeId, project.rootPath);
          // The first committed Session image already has the complete target;
          // other entry points cannot observe and run it on a fallback directory.
          await sessionManager.createSessionInAgent({ agentName: agentId!, sessionName, currentNode: project.nodeId, cwd: project.rootPath });
        }
        await validateNodeSelection(runtimeId, project.nodeId);
        const runtime = await sessionRuntime.getSession(runtimeId);
        if (!runtime || runtime.currentNode !== project.nodeId || runtime.cwd !== project.rootPath) {
          throw new Error('Agent session target changed during creation; it was not rebound.');
        }
        const ready = store.updateTab(tab.id, { state: 'ready' });
        options?.onSessionCreated?.();
        return ready;
      })().finally(() => creating.delete(tab.id));
      creating.set(tab.id, pending);
    }
    return { tab: await pending };
  });
  route('PATCH', '/api/project-tabs/:id', async req => {
    const tabId = id(req.params.id);
    const tab = store.getTab(tabId);
    if (!tab) throw new Error('Tab not found.');
    const title = req.body?.title === undefined ? undefined : string(req.body.title, 'title');
    const resourceId = req.body?.resourceId === undefined ? undefined : string(req.body.resourceId, 'resourceId', 512);
    if (tab.type === 'agent' && resourceId && resourceId !== tab.resourceId) throw new Error('Agent tab ownership cannot be changed.');
    return { tab: store.updateTab(tabId, { title, resourceId }) };
  });
  route('DELETE', '/api/project-tabs/:id', async req => {
    const tabId = id(req.params.id);
    if (creating.has(tabId)) throw new Error('Tab creation is in progress.');
    if (!store.deleteTab(tabId)) throw new Error('Tab not found.');
    return { success: true };
  });
}
