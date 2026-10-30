import { API_BASE_PATH } from './config'

export type ProjectTabType = 'agent' | 'terminal' | 'code'
export interface ProjectTab {
  id: string
  workspaceSessionId: string
  type: ProjectTabType
  title: string
  resourceId?: string
  createdAt: number
  state: 'pending' | 'ready'
  requestId?: string
}
export interface ProjectSession {
  id: string
  projectId: string
  title: string
  createdAt: number
  archived: boolean
  tabs: ProjectTab[]
}
export interface Project {
  id: string
  name: string
  nodeId: string
  rootPath: string
  createdAt: number
  archived: boolean
  sessions: ProjectSession[]
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_PATH}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Request failed (${response.status})`)
  return result as T
}
const id = (value: string) => encodeURIComponent(value)
export const projectApi = {
  list: (offset = 0) => request<{ projects: Project[]; nextOffset: number | null }>(`/projects?offset=${offset}`),
  resolveDirectory: (nodeId: string, rootPath?: string) => request<{ nodeId: string; rootPath: string }>('/projects/resolve-directory', 'POST', { nodeId, rootPath }),
  create: (body: { name?: string; nodeId: string; rootPath?: string }) => request<{ project: Project }>('/projects', 'POST', body),
  update: (projectId: string, body: { name?: string; archived?: boolean }) => request<{ project: Project }>(`/projects/${id(projectId)}`, 'PATCH', body),
  createSession: (projectId: string, title?: string) => request<{ session: ProjectSession }>(`/projects/${id(projectId)}/sessions`, 'POST', { title }),
  updateSession: (sessionId: string, body: { title?: string; archived?: boolean }) => request<{ session: ProjectSession }>(`/project-sessions/${id(sessionId)}`, 'PATCH', body),
  createTab: (sessionId: string, body: { type: ProjectTabType; title?: string; agentId?: string; requestId?: string; existingSessionId?: string }) => request<{ tab: ProjectTab }>(`/project-sessions/${id(sessionId)}/tabs`, 'POST', body),
  updateTab: (tabId: string, body: { title?: string; resourceId?: string }) => request<{ tab: ProjectTab }>(`/project-tabs/${id(tabId)}`, 'PATCH', body),
  deleteTab: (tabId: string) => request<{ success: boolean }>(`/project-tabs/${id(tabId)}`, 'DELETE'),
  directories: (nodeId: string, path: string) => request<{ entries: { name: string; type: number }[] }>(`/vscode-web/fs/read-directory?${new URLSearchParams({ nodeId, path })}`),
}
