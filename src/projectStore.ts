import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { STATE_DIR } from './config';

export type ProjectTabType = 'agent' | 'terminal' | 'code';
export type ProjectTab = { id: string; workspaceSessionId: string; type: ProjectTabType; title: string; resourceId?: string; createdAt: number; state: 'pending' | 'ready'; requestId?: string; agentId?: string };
export type WorkspaceSession = { id: string; projectId: string; title: string; createdAt: number; archived: boolean; tabs: ProjectTab[] };
export type Project = { id: string; name: string; nodeId: string; rootPath: string; createdAt: number; archived: boolean; sessions: WorkspaceSession[] };

// Main owns this separate database. Runtime Session JSON remains authoritative
// for conversations, and no writes are made to the Session catalog.
export class ProjectStore {
  private db: DatabaseSync;

  constructor(filePath = path.join(STATE_DIR, 'projects.sqlite')) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    if (filePath !== ':memory:') fs.chmodSync(filePath, 0o600);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version !== 0 && version !== 1 && version !== 2) throw new Error(`Unsupported project database version: ${version}.`);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, node_id TEXT NOT NULL, root_path TEXT NOT NULL,
        created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        UNIQUE(node_id, root_path)
      );
      CREATE TABLE IF NOT EXISTS work_sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
        created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS work_sessions_project_idx ON work_sessions(project_id, created_at, id);
      CREATE TABLE IF NOT EXISTS work_tabs (
        id TEXT PRIMARY KEY, work_session_id TEXT NOT NULL REFERENCES work_sessions(id), type TEXT NOT NULL,
        title TEXT NOT NULL, resource_id TEXT, request_id TEXT UNIQUE, agent_id TEXT, created_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'ready'
      );
      CREATE INDEX IF NOT EXISTS work_tabs_session_idx ON work_tabs(work_session_id, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS work_tabs_agent_resource_idx ON work_tabs(resource_id) WHERE type='agent' AND resource_id IS NOT NULL;
    `);
    const columns = this.db.prepare('PRAGMA table_info(work_tabs)').all() as Array<{name:string}>;
    if (!columns.some(column => column.name === 'agent_id')) this.db.exec('ALTER TABLE work_tabs ADD COLUMN agent_id TEXT');
    this.db.exec('PRAGMA user_version=2');
  }

  close(): void { this.db.close(); }

  private tab(row: any): ProjectTab {
    return { id: row.id, workspaceSessionId: row.work_session_id, type: row.type, title: row.title,
      ...(row.resource_id ? { resourceId: row.resource_id } : {}), createdAt: row.created_at,
      state: row.state, ...(row.request_id ? { requestId: row.request_id } : {}), ...(row.agent_id ? { agentId: row.agent_id } : {}) };
  }
  private session(row: any): WorkspaceSession {
    const tabs = this.db.prepare('SELECT * FROM work_tabs WHERE work_session_id=? ORDER BY created_at,id LIMIT 1000').all(row.id).map(x => this.tab(x));
    return { id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at, archived: !!row.archived, tabs };
  }
  private project(row: any): Project {
    const sessions = this.db.prepare('SELECT * FROM work_sessions WHERE project_id=? ORDER BY created_at,id LIMIT 1000').all(row.id).map(x => this.session(x));
    return { id: row.id, name: row.name, nodeId: row.node_id, rootPath: row.root_path, createdAt: row.created_at, archived: !!row.archived, sessions };
  }
  list(limit = 100, offset = 0): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at,id LIMIT ? OFFSET ?').all(limit, offset).map(row => this.project(row));
  }
  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return row ? this.project(row) : undefined;
  }
  getSession(id: string): WorkspaceSession | undefined {
    const row = this.db.prepare('SELECT * FROM work_sessions WHERE id=?').get(id);
    return row ? this.session(row) : undefined;
  }
  getTab(id: string): ProjectTab | undefined {
    const row = this.db.prepare('SELECT * FROM work_tabs WHERE id=?').get(id);
    return row ? this.tab(row) : undefined;
  }
  createProject(name: string, nodeId: string, rootPath: string): Project {
    const existing = this.db.prepare('SELECT id FROM projects WHERE node_id=? AND root_path=?').get(nodeId, rootPath) as {id:string} | undefined;
    if (existing) {
      this.db.prepare('UPDATE projects SET archived=0 WHERE id=?').run(existing.id);
      return this.getProject(existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO projects(id,name,node_id,root_path,created_at) VALUES(?,?,?,?,?)').run(id, name, nodeId, rootPath, Date.now());
    return this.getProject(id)!;
  }
  updateProject(id: string, patch: { name?: string; archived?: boolean }): Project {
    const existing = this.getProject(id);
    if (!existing) throw new Error('Project not found.');
    this.db.prepare('UPDATE projects SET name=?, archived=? WHERE id=?').run(patch.name ?? existing.name, Number(patch.archived ?? existing.archived), id);
    return this.getProject(id)!;
  }
  createSession(projectId: string, title: string): WorkspaceSession {
    const project = this.getProject(projectId);
    if (!project || project.archived) throw new Error('Project not found or archived.');
    const id = randomUUID();
    this.db.prepare('INSERT INTO work_sessions(id,project_id,title,created_at) VALUES(?,?,?,?)').run(id, projectId, title, Date.now());
    return this.getSession(id)!;
  }
  updateSession(id: string, patch: { title?: string; archived?: boolean }): WorkspaceSession {
    const existing = this.getSession(id);
    if (!existing) throw new Error('Workspace session not found.');
    this.db.prepare('UPDATE work_sessions SET title=?, archived=? WHERE id=?').run(patch.title ?? existing.title, Number(patch.archived ?? existing.archived), id);
    return this.getSession(id)!;
  }
  findTabByRequestId(requestId: string): ProjectTab | undefined {
    const row = this.db.prepare('SELECT * FROM work_tabs WHERE request_id=?').get(requestId);
    return row ? this.tab(row) : undefined;
  }
  createTab(workSessionId: string, type: ProjectTabType, title: string, requestId?: string, agentId?: string): ProjectTab {
    const session = this.getSession(workSessionId);
    if (!session || session.archived) throw new Error('Workspace session not found or archived.');
    const project = this.getProject(session.projectId);
    if (!project || project.archived) throw new Error('Project not found or archived.');
    if (requestId) {
      const found = this.db.prepare('SELECT * FROM work_tabs WHERE request_id=?').get(requestId);
      if (found) {
        const existing = this.tab(found);
        if (existing.workspaceSessionId !== workSessionId || existing.type !== type || (agentId && existing.agentId && existing.agentId !== agentId)) throw new Error('Request ID already belongs to another tab.');
        return existing;
      }
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO work_tabs(id,work_session_id,type,title,request_id,agent_id,created_at,state) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, workSessionId, type, title, requestId || null, agentId || null, Date.now(), type === 'agent' ? 'pending' : 'ready');
    return this.getTab(id)!;
  }
  linkExistingAgent(workSessionId: string, title: string, requestId: string | undefined, resourceId: string, agentId: string): ProjectTab {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const tab = this.createTab(workSessionId, 'agent', title, requestId, agentId);
      if (tab.resourceId && tab.resourceId !== resourceId) throw new Error('Request ID was already used with a different Agent session.');
      const owner = this.db.prepare("SELECT id FROM work_tabs WHERE type='agent' AND resource_id=? AND id<>?").get(resourceId, tab.id);
      if (owner) throw new Error('Agent session already belongs to another workspace.');
      const linked = this.updateTab(tab.id, { resourceId, state: 'ready' });
      this.db.exec('COMMIT');
      return linked;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  updateTab(id: string, patch: { title?: string; resourceId?: string; state?: 'pending' | 'ready' }): ProjectTab {
    const existing = this.getTab(id);
    if (!existing) throw new Error('Tab not found.');
    this.db.prepare('UPDATE work_tabs SET title=?,resource_id=?,state=? WHERE id=?')
      .run(patch.title ?? existing.title, patch.resourceId ?? existing.resourceId ?? null, patch.state ?? existing.state, id);
    return this.getTab(id)!;
  }
  deleteTab(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM work_tabs WHERE id=?').run(id).changes) > 0;
  }
}
