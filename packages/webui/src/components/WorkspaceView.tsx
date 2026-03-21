import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Save, SquareTerminal, X } from 'lucide-react'
import { API_BASE_PATH } from '../config'

interface WorkspaceEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

interface WorkspaceTabState {
  openedFiles: string[]
  activeFilePath: string | null
  expandedKeys: string[]
  selectedPath: string | null
}

interface WorkspaceViewProps {
  initialNodeId?: string
  initialPath?: string
  onBack?: () => void
  onOpenTerminal?: (cwd?: string) => void
  onOpenFile?: (nodeId: string, path: string) => void
}

const WORKSPACE_STATE_PREFIX = 'foxwarm_workspace_tab_state_v1:'

const makeNodeKey = (nodeId: string, entryPath: string) => `${nodeId}:${entryPath}`

function formatTimestamp(value: number) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function formatSize(size: number) {
  if (!Number.isFinite(size) || size < 1024) return `${size || 0} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function getWorkspaceStorageKey(nodeId: string, rootPath: string) {
  return `${WORKSPACE_STATE_PREFIX}${nodeId}:${rootPath}`
}

function loadWorkspaceState(nodeId: string, rootPath: string): WorkspaceTabState {
  try {
    const raw = localStorage.getItem(getWorkspaceStorageKey(nodeId, rootPath))
    if (!raw) {
      return {
        openedFiles: [],
        activeFilePath: null,
        expandedKeys: [makeNodeKey(nodeId, rootPath)],
        selectedPath: rootPath,
      }
    }

    const parsed = JSON.parse(raw)
    return {
      openedFiles: Array.isArray(parsed?.openedFiles) ? parsed.openedFiles.filter((item: unknown): item is string => typeof item === 'string') : [],
      activeFilePath: typeof parsed?.activeFilePath === 'string' ? parsed.activeFilePath : null,
      expandedKeys: Array.isArray(parsed?.expandedKeys) ? parsed.expandedKeys.filter((item: unknown): item is string => typeof item === 'string') : [makeNodeKey(nodeId, rootPath)],
      selectedPath: typeof parsed?.selectedPath === 'string' ? parsed.selectedPath : rootPath,
    }
  } catch {
    return {
      openedFiles: [],
      activeFilePath: null,
      expandedKeys: [makeNodeKey(nodeId, rootPath)],
      selectedPath: rootPath,
    }
  }
}

function getParentPath(filePath: string) {
  const parts = filePath.split('/')
  parts.pop()
  return parts.join('/') || '/'
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
        onClick={() => onSelect(entry)}
        className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-sm ${isSelected ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800'}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {entry.isDirectory ? (
          <button
            onClick={(event) => {
              event.stopPropagation()
              onToggle(entry)
            }}
            className="rounded p-0.5 text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-5" />
        )}

        <div
          className="flex w-full min-w-0 flex-1 items-center gap-2 text-left"
          title={entry.path}
        >
          {entry.isDirectory ? (
            expanded ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />
          ) : (
            <FileText className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate">{entry.name || entry.path}</span>
          {loading && <ChevronRight className="h-3 w-3 animate-pulse text-gray-400" />}
        </div>
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

export default function WorkspaceView({ initialNodeId, initialPath, onBack, onOpenTerminal, onOpenFile }: WorkspaceViewProps) {
  const rootNodeId = initialNodeId || 'master'
  const rootPath = initialPath || '/'
  const storageKey = useMemo(() => getWorkspaceStorageKey(rootNodeId, rootPath), [rootNodeId, rootPath])
  const initialState = useMemo(() => loadWorkspaceState(rootNodeId, rootPath), [rootNodeId, rootPath])

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set(initialState.expandedKeys))
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set())
  const [childrenMap, setChildrenMap] = useState<Map<string, WorkspaceEntry[]>>(new Map())
  const [selectedPath, setSelectedPath] = useState<string | null>(initialState.selectedPath)
  const [selectedIsDirectory, setSelectedIsDirectory] = useState<boolean>(() => initialState.selectedPath ? initialState.selectedPath === rootPath : true)
  const [openedFiles, setOpenedFiles] = useState<string[]>(initialState.openedFiles)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(initialState.activeFilePath)
  const [editorContent, setEditorContent] = useState<string>('')
  const [savedContent, setSavedContent] = useState<string>('')
  const [fileMeta, setFileMeta] = useState<{ size: number; modifiedAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isFileLoading, setIsFileLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const selectedDirectoryPath = selectedIsDirectory
    ? selectedPath
    : (selectedPath ? getParentPath(selectedPath) : rootPath)

  const isDirty = activeFilePath !== null && editorContent !== savedContent

  useEffect(() => {
    const restored = loadWorkspaceState(rootNodeId, rootPath)
    setExpandedKeys(new Set(restored.expandedKeys.length > 0 ? restored.expandedKeys : [makeNodeKey(rootNodeId, rootPath)]))
    setSelectedPath(restored.selectedPath || rootPath)
    setSelectedIsDirectory(!restored.activeFilePath)
    setOpenedFiles(restored.openedFiles)
    setActiveFilePath(restored.activeFilePath)
    setEditorContent('')
    setSavedContent('')
    setFileMeta(null)
    setError(null)
  }, [rootNodeId, rootPath])

  useEffect(() => {
    const payload: WorkspaceTabState = {
      openedFiles,
      activeFilePath,
      expandedKeys: Array.from(expandedKeys),
      selectedPath,
    }
    localStorage.setItem(storageKey, JSON.stringify(payload))
  }, [activeFilePath, expandedKeys, openedFiles, selectedPath, storageKey])

  const ensureDirectoryLoaded = async (dirPath: string) => {
    const key = makeNodeKey(rootNodeId, dirPath)
    if (childrenMap.has(key)) {
      return
    }

    setLoadingKeys((prev) => new Set(prev).add(key))
    try {
      const res = await fetch(`${API_BASE_PATH}/fs/tree?nodeId=${encodeURIComponent(rootNodeId)}&path=${encodeURIComponent(dirPath)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to load directory')
      }
      setChildrenMap((prev) => {
        const next = new Map(prev)
        next.set(key, data.entries || [])
        return next
      })
    } finally {
      setLoadingKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  useEffect(() => {
    void ensureDirectoryLoaded(rootPath)
  }, [rootPath])

  useEffect(() => {
    if (!activeFilePath) {
      setEditorContent('')
      setSavedContent('')
      setFileMeta(null)
      return
    }

    let cancelled = false
    setIsFileLoading(true)
    setError(null)

    const load = async () => {
      try {
        const res = await fetch(`${API_BASE_PATH}/fs/read?nodeId=${encodeURIComponent(rootNodeId)}&path=${encodeURIComponent(activeFilePath)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.error || 'Failed to read file')
        }
        if (!cancelled) {
          setEditorContent(data.content || '')
          setSavedContent(data.content || '')
          setFileMeta({ size: data.size || 0, modifiedAt: data.modifiedAt || 0 })
          setSelectedPath(activeFilePath)
          setSelectedIsDirectory(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) {
          setIsFileLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [activeFilePath, rootNodeId])

  const openDirectory = async (dirPath: string) => {
    setError(null)
    setSelectedPath(dirPath)
    setSelectedIsDirectory(true)
    setExpandedKeys((prev) => new Set(prev).add(makeNodeKey(rootNodeId, dirPath)))
    await ensureDirectoryLoaded(dirPath)
  }

  const openFileInWorkspace = async (filePath: string) => {
    if (isDirty && activeFilePath && activeFilePath !== filePath && !window.confirm('You have unsaved changes. Discard them and open another file?')) {
      return
    }

    setOpenedFiles((prev) => prev.includes(filePath) ? prev : [...prev, filePath])
    setActiveFilePath(filePath)
    setSelectedPath(filePath)
    setSelectedIsDirectory(false)
    await ensureDirectoryLoaded(getParentPath(filePath))
  }

  const handleToggleDirectory = async (entry: WorkspaceEntry) => {
    const key = makeNodeKey(rootNodeId, entry.path)
    const nextExpanded = new Set(expandedKeys)
    if (nextExpanded.has(key)) {
      nextExpanded.delete(key)
      setExpandedKeys(nextExpanded)
      return
    }
    nextExpanded.add(key)
    setExpandedKeys(nextExpanded)
    await openDirectory(entry.path)
  }

  const handleSelectEntry = async (entry: WorkspaceEntry) => {
    try {
      if (entry.isDirectory) {
        await openDirectory(entry.path)
      } else {
        await openFileInWorkspace(entry.path)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCloseOpenedFile = (filePath: string) => {
    setOpenedFiles((prev) => {
      const next = prev.filter((item) => item !== filePath)
      if (activeFilePath === filePath) {
        const currentIndex = prev.indexOf(filePath)
        const fallback = next[Math.max(0, currentIndex - 1)] || next[currentIndex] || null
        setActiveFilePath(fallback)
        setSelectedPath(fallback || rootPath)
        setSelectedIsDirectory(!fallback)
      }
      return next
    })
  }

  const handleSave = async () => {
    if (!activeFilePath) return
    setIsSaving(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/fs/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: rootNodeId, path: activeFilePath, content: editorContent }),
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

  const handleOpenTerminalHere = () => {
    const nextCwd = selectedIsDirectory ? selectedPath : selectedDirectoryPath
    onOpenTerminal?.(nextCwd || rootPath)
  }

  const rootEntry: WorkspaceEntry = {
    name: rootPath,
    path: rootPath,
    isDirectory: true,
    size: 0,
    modifiedAt: 0,
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
                node {rootNodeId} · root <span className="font-mono text-[12px]">{rootPath}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {activeFilePath && onOpenFile && (
              <button
                onClick={() => onOpenFile(rootNodeId, activeFilePath)}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                title="Open file tab"
              >
                <FileText className="h-4 w-4" />
                <span className="hidden md:inline">Open file tab</span>
              </button>
            )}
            <button
              onClick={handleOpenTerminalHere}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              title="Open terminal"
            >
              <SquareTerminal className="h-4 w-4" />
              <span className="hidden md:inline">Open terminal</span>
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty || isSaving || !activeFilePath}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Save file"
            >
              <Save className="h-4 w-4" />
              <span className="hidden md:inline">{isSaving ? 'Saving...' : 'Save file'}</span>
            </button>
          </div>
        </div>

      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[360px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="shrink-0 border-b border-gray-200 dark:border-gray-700">
            <div className="border-b border-gray-200 px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
              Opened files
            </div>
            <div className="max-h-[40vh] overflow-y-auto p-2">
              {openedFiles.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400">
                  Open files from the root tree below.
                </div>
              ) : (
                openedFiles.map((filePath) => {
                  const active = filePath === activeFilePath
                  return (
                    <div
                      key={filePath}
                      onClick={() => {
                        setActiveFilePath(filePath)
                        setSelectedPath(filePath)
                        setSelectedIsDirectory(false)
                      }}
                      className={`mb-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${active ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700/60'}`}
                    >
                      <div
                        className="flex w-full min-w-0 flex-1 items-center gap-2 text-left"
                        title={filePath}
                      >
                        <FileText className="h-4 w-4 shrink-0" />
                        <span className="truncate">{filePath.split('/').pop() || filePath}</span>
                      </div>
                      <button
                        onClick={(event) => {
                          event.stopPropagation()
                          handleCloseOpenedFile(filePath)
                        }}
                        className="rounded p-0.5 text-gray-400 hover:bg-black/5 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
                        title="Close file"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-gray-200 px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
              Root tree
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <div className="rounded-lg border border-gray-200 dark:border-gray-700">
                <WorkspaceTreeNode
                  nodeId={rootNodeId}
                  entry={rootEntry}
                  depth={0}
                  expandedKeys={expandedKeys}
                  loadingKeys={loadingKeys}
                  childrenMap={childrenMap}
                  selectedPath={selectedPath}
                  onToggle={handleToggleDirectory}
                  onSelect={handleSelectEntry}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
            <div className="truncate font-mono text-xs text-gray-500 dark:text-gray-400" title={activeFilePath || ''}>
              {activeFilePath || 'Select a file from the root tree or opened files list'}
            </div>
            {fileMeta && (
              <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                {formatSize(fileMeta.size)} · updated {formatTimestamp(fileMeta.modifiedAt)}
                {isDirty && <span className="ml-2 text-amber-600 dark:text-amber-300">Unsaved changes</span>}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 p-4">
            {error ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-red-200 bg-red-50 px-6 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200">
                {error}
              </div>
            ) : isFileLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">Loading file…</div>
            ) : activeFilePath ? (
              <textarea
                value={editorContent}
                onChange={(event) => setEditorContent(event.target.value)}
                className="h-full w-full resize-none rounded-xl border border-gray-300 bg-white p-4 font-mono text-sm text-gray-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-blue-500 dark:focus:ring-blue-900"
                spellCheck={false}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
                Select a file from the root tree or opened files list to edit it here.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}