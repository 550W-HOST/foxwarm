import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Folder, FolderOpen, FileText, Plus, Save, RefreshCw, Crosshair, CornerDownRight, SquareTerminal } from 'lucide-react'
import type { Session } from './SessionListCore'
import { API_BASE_PATH } from '../config'

interface WorkspaceRoot {
  id: string
  nodeId: string
  path: string
}

interface WorkspaceEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

interface WorkspaceViewProps {
  sessionId: string
  session?: Session
  onBack?: () => void
  onSessionsChanged?: () => void
  onOpenTerminal?: (cwd?: string) => void
}

const ROOTS_STORAGE_KEY = 'foxwarm_workspace_roots_v1'

const makeNodeKey = (nodeId: string, entryPath: string) => `${nodeId}:${entryPath}`

function loadStoredRoots(): WorkspaceRoot[] {
  try {
    const raw = localStorage.getItem(ROOTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is WorkspaceRoot => (
      item && typeof item.id === 'string' && typeof item.nodeId === 'string' && typeof item.path === 'string'
    ))
  } catch {
    return []
  }
}

function formatTimestamp(value: number) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function formatSize(size: number) {
  if (!Number.isFinite(size) || size < 1024) return `${size || 0} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function WorkspaceTreeNode({
  nodeId,
  entry,
  depth,
  expandedKeys,
  loadingKeys,
  childrenMap,
  selectedPath,
  onToggle,
  onSelect,
}: {
  nodeId: string
  entry: WorkspaceEntry
  depth: number
  expandedKeys: Set<string>
  loadingKeys: Set<string>
  childrenMap: Map<string, WorkspaceEntry[]>
  selectedPath: string | null
  onToggle: (entry: WorkspaceEntry) => void
  onSelect: (entry: WorkspaceEntry) => void
}) {
  const nodeKey = makeNodeKey(nodeId, entry.path)
  const expanded = expandedKeys.has(nodeKey)
  const loading = loadingKeys.has(nodeKey)
  const children = childrenMap.get(nodeKey) || []
  const isSelected = selectedPath === entry.path

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-sm ${isSelected ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800'}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {entry.isDirectory ? (
          <button
            onClick={() => onToggle(entry)}
            className="rounded p-0.5 text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-5" />
        )}

        <button
          onClick={() => onSelect(entry)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={entry.path}
        >
          {entry.isDirectory ? (
            expanded ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />
          ) : (
            <FileText className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate">{entry.name || entry.path}</span>
          {loading && <RefreshCw className="h-3 w-3 animate-spin text-gray-400" />}
        </button>
      </div>

      {entry.isDirectory && expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <WorkspaceTreeNode
              key={`${nodeId}:${child.path}`}
              nodeId={nodeId}
              entry={child}
              depth={depth + 1}
              expandedKeys={expandedKeys}
              loadingKeys={loadingKeys}
              childrenMap={childrenMap}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function WorkspaceView({ sessionId, session, onBack, onSessionsChanged, onOpenTerminal }: WorkspaceViewProps) {
  const [roots, setRoots] = useState<WorkspaceRoot[]>(() => loadStoredRoots())
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set())
  const [childrenMap, setChildrenMap] = useState<Map<string, WorkspaceEntry[]>>(new Map())
  const [selectedNodeId, setSelectedNodeId] = useState<string>(session?.currentNode || 'master')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedIsDirectory, setSelectedIsDirectory] = useState<boolean>(true)
  const [editorPath, setEditorPath] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState<string>('')
  const [savedContent, setSavedContent] = useState<string>('')
  const [fileMeta, setFileMeta] = useState<{ size: number; modifiedAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isFileLoading, setIsFileLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [newRootPath, setNewRootPath] = useState('')
  const [newRootNodeId, setNewRootNodeId] = useState(session?.currentNode || 'master')

  useEffect(() => {
    localStorage.setItem(ROOTS_STORAGE_KEY, JSON.stringify(roots))
  }, [roots])

  useEffect(() => {
    if (!selectedRootId && roots.length > 0) {
      setSelectedRootId(roots[0].id)
    }
  }, [roots, selectedRootId])

  const selectedDirectoryPath = selectedIsDirectory
    ? selectedPath
    : (selectedPath ? selectedPath.split('/').slice(0, -1).join('/') || '/' : null)

  const isDirty = editorPath !== null && editorContent !== savedContent

  const ensureDirectoryLoaded = async (nodeId: string, dirPath: string) => {
    const key = makeNodeKey(nodeId, dirPath)
    if (childrenMap.has(key)) {
      return
    }

    setLoadingKeys(prev => new Set(prev).add(key))
    try {
      const res = await fetch(`${API_BASE_PATH}/fs/tree?nodeId=${encodeURIComponent(nodeId)}&path=${encodeURIComponent(dirPath)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load directory')
      }
      setChildrenMap(prev => {
        const next = new Map(prev)
        next.set(key, data.entries || [])
        return next
      })
    } finally {
      setLoadingKeys(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const openDirectory = async (nodeId: string, dirPath: string) => {
    setError(null)
    setSelectedNodeId(nodeId)
    setSelectedPath(dirPath)
    setSelectedIsDirectory(true)
    await ensureDirectoryLoaded(nodeId, dirPath)
  }

  const openFile = async (nodeId: string, filePath: string) => {
    if (isDirty && !window.confirm('You have unsaved changes. Discard them and open another file?')) {
      return
    }

    setError(null)
    setIsFileLoading(true)
    try {
      const res = await fetch(`${API_BASE_PATH}/fs/read?nodeId=${encodeURIComponent(nodeId)}&path=${encodeURIComponent(filePath)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to read file')
      }
      setSelectedNodeId(nodeId)
      setSelectedPath(filePath)
      setSelectedIsDirectory(false)
      setEditorPath(filePath)
      setEditorContent(data.content || '')
      setSavedContent(data.content || '')
      setFileMeta({ size: data.size || 0, modifiedAt: data.modifiedAt || 0 })
      const parentPath = filePath.split('/').slice(0, -1).join('/') || '/'
      await ensureDirectoryLoaded(nodeId, parentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsFileLoading(false)
    }
  }

  const handleToggleDirectory = async (nodeId: string, entry: WorkspaceEntry) => {
    const key = makeNodeKey(nodeId, entry.path)
    const nextExpanded = new Set(expandedKeys)
    if (nextExpanded.has(key)) {
      nextExpanded.delete(key)
      setExpandedKeys(nextExpanded)
      return
    }
    nextExpanded.add(key)
    setExpandedKeys(nextExpanded)
    try {
      await openDirectory(nodeId, entry.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const addRoot = async (nodeId: string, entryPath: string) => {
    const normalizedPath = entryPath.trim()
    if (!normalizedPath) return

    const existing = roots.find(root => root.nodeId === nodeId && root.path === normalizedPath)
    const root = existing || { id: `${Date.now()}_${Math.random().toString(16).slice(2)}`, nodeId, path: normalizedPath }
    if (!existing) {
      setRoots(prev => [root, ...prev])
    }
    setSelectedRootId(root.id)
    setSelectedNodeId(nodeId)
    setExpandedKeys(prev => {
      const next = new Set(prev)
      next.add(makeNodeKey(nodeId, normalizedPath))
      return next
    })
    await openDirectory(nodeId, normalizedPath)
  }

  const handleAddRoot = async (e: FormEvent) => {
    e.preventDefault()
    try {
      setError(null)
      await addRoot(newRootNodeId, newRootPath)
      setNewRootPath('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSelectEntry = async (nodeId: string, entry: WorkspaceEntry) => {
    try {
      if (entry.isDirectory) {
        await openDirectory(nodeId, entry.path)
      } else {
        await openFile(nodeId, entry.path)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSave = async () => {
    if (!editorPath) return
    setIsSaving(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/fs/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: selectedNodeId, path: editorPath, content: editorContent }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save file')
      }
      setSavedContent(editorContent)
      setFileMeta({ size: data.size || editorContent.length, modifiedAt: data.modifiedAt || Date.now() })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSaving(false)
    }
  }

  const handleOpenSessionCwd = async () => {
    const cwd = session?.cwd
    const nodeId = session?.currentNode || 'master'
    if (!cwd) {
      setError('Current session has no cwd yet.')
      return
    }
    try {
      setError(null)
      await addRoot(nodeId, cwd)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSetSessionCwd = async () => {
    const nextCwd = selectedIsDirectory ? selectedPath : selectedDirectoryPath
    if (!nextCwd) {
      setError('Select a directory first.')
      return
    }

    try {
      setError(null)
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/cwd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: nextCwd }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update session cwd')
      }
      onSessionsChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleOpenTerminalHere = () => {
    const nextCwd = selectedIsDirectory ? selectedPath : selectedDirectoryPath
    onOpenTerminal?.(nextCwd || session?.cwd || undefined)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-100 dark:bg-gray-900">
      <div className="border-b border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                onClick={onBack}
                className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                title="Back"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            )}
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Workspace</h2>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                Session {session?.displayName || sessionId}
                {session?.cwd && <span className="ml-2 font-mono text-[12px]">cwd {session.cwd}</span>}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleOpenTerminalHere}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <SquareTerminal className="h-4 w-4" />
              <span>Open terminal here</span>
            </button>
            <button
              onClick={handleOpenSessionCwd}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <Crosshair className="h-4 w-4" />
              <span>Open session cwd</span>
            </button>
            <button
              onClick={handleSetSessionCwd}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <CornerDownRight className="h-4 w-4" />
              <span>Set as session cwd</span>
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty || isSaving || !editorPath}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              <span>{isSaving ? 'Saving...' : 'Save file'}</span>
            </button>
          </div>
        </div>

        <form onSubmit={handleAddRoot} className="mt-4 flex flex-wrap gap-2">
          <select
            value={newRootNodeId}
            onChange={(e) => setNewRootNodeId(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="master">master</option>
          </select>
          <input
            value={newRootPath}
            onChange={(e) => setNewRootPath(e.target.value)}
            placeholder="Add workspace root path, e.g. /home/ldmbot/git/foxwarm"
            className="min-w-[280px] flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Plus className="h-4 w-4" />
            <span>Add root</span>
          </button>
        </form>

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200">
            {error}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[340px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="border-b border-gray-200 px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
            Roots
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {roots.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400">
                Add a root path to start browsing files.
              </div>
            ) : (
              roots.map((root) => {
                const rootKey = makeNodeKey(root.nodeId, root.path)
                const rootEntry: WorkspaceEntry = {
                  name: root.path,
                  path: root.path,
                  isDirectory: true,
                  size: 0,
                  modifiedAt: 0,
                }
                return (
                  <div key={root.id} className="mb-2 rounded-lg border border-gray-200 dark:border-gray-700">
                    <button
                      onClick={async () => {
                        setSelectedRootId(root.id)
                        setSelectedNodeId(root.nodeId)
                        setExpandedKeys(prev => {
                          const next = new Set(prev)
                          next.add(rootKey)
                          return next
                        })
                        await openDirectory(root.nodeId, root.path)
                      }}
                      className={`flex w-full items-center justify-between rounded-t-lg px-3 py-2 text-left text-sm ${selectedRootId === root.id ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-200' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/60'}`}
                    >
                      <span className="truncate font-mono">{root.path}</span>
                      <span className="ml-2 text-[11px] text-gray-400">{root.nodeId}</span>
                    </button>
                    <div className="border-t border-gray-200 py-1 dark:border-gray-700">
                      <WorkspaceTreeNode
                        nodeId={root.nodeId}
                        entry={rootEntry}
                        depth={0}
                        expandedKeys={expandedKeys}
                        loadingKeys={loadingKeys}
                        childrenMap={childrenMap}
                        selectedPath={selectedPath}
                        onToggle={async (entry) => {
                          await handleToggleDirectory(root.nodeId, entry)
                        }}
                        onSelect={async (entry) => {
                          await handleSelectEntry(root.nodeId, entry)
                        }}
                      />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
              <div className="text-sm font-medium text-gray-900 dark:text-white">Editor</div>
              <div className="mt-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400" title={selectedDirectoryPath || ''}>
                directory {selectedDirectoryPath || '—'}
              </div>
              <div className="truncate font-mono text-xs text-gray-500 dark:text-gray-400" title={editorPath || ''}>
                {editorPath || 'Select a file'}
              </div>
              {fileMeta && (
                <div className="mt-1 text-xs text-gray-400">
                  {formatSize(fileMeta.size)} · updated {formatTimestamp(fileMeta.modifiedAt)}
                  {isDirty && <span className="ml-2 text-amber-600 dark:text-amber-300">Unsaved changes</span>}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 p-4">
              {isFileLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">Loading file…</div>
              ) : editorPath ? (
                <textarea
                  value={editorContent}
                  onChange={(e) => setEditorContent(e.target.value)}
                  className="h-full w-full resize-none rounded-xl border border-gray-300 bg-white p-4 font-mono text-sm text-gray-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-blue-500 dark:focus:ring-blue-900"
                  spellCheck={false}
                />
              ) : (
                <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
                  Select a file from the workspace tree to open it here.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}