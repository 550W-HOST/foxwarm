import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Download, FileText, Save, SquareTerminal } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import { MAX_INLINE_FILE_BYTES, buildWorkspaceDownloadUrl, formatSize, formatTimestamp, triggerBrowserDownload } from './workspaceShared'

const MonacoFileEditor = lazy(() => import('./MonacoFileEditor'))

interface FileEditorViewProps {
  nodeId: string
  filePath: string
  onBack?: () => void
  onOpenTerminal?: (cwd?: string) => void
  onOpenFileTab?: (nodeId: string, path: string) => void
}

interface BlockedFileState {
  path: string
  size: number
  maxSize: number
}

export default function FileEditorView({ nodeId, filePath, onBack, onOpenTerminal, onOpenFileTab }: FileEditorViewProps) {
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [meta, setMeta] = useState<{ size: number; modifiedAt: number } | null>(null)
  const [blockedFile, setBlockedFile] = useState<BlockedFileState | null>(null)

  const directoryPath = useMemo(() => {
    const parts = filePath.split('/')
    parts.pop()
    return parts.join('/') || '/'
  }, [filePath])

  const dirty = content !== savedContent

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setBlockedFile(null)

    const load = async () => {
      try {
        const res = await fetch(`${API_BASE_PATH}/fs/read?nodeId=${encodeURIComponent(nodeId)}&path=${encodeURIComponent(filePath)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const nextError = new Error(data.error || 'Failed to read file') as Error & { code?: string; size?: number; maxSize?: number; path?: string }
          nextError.code = data.code
          nextError.size = data.size
          nextError.maxSize = data.maxSize
          nextError.path = data.path
          throw nextError
        }
        if (!cancelled) {
          setContent(data.content || '')
          setSavedContent(data.content || '')
          setMeta({ size: data.size || 0, modifiedAt: data.modifiedAt || 0 })
          setBlockedFile(null)
        }
      } catch (err) {
        if (!cancelled) {
          const detailed = err as Error & { code?: string; size?: number; maxSize?: number; path?: string }
          if (detailed.code === 'FILE_TOO_LARGE') {
            setBlockedFile({
              path: detailed.path || filePath,
              size: detailed.size || 0,
              maxSize: detailed.maxSize || MAX_INLINE_FILE_BYTES,
            })
            setError(null)
            setMeta(detailed.size ? { size: detailed.size, modifiedAt: 0 } : null)
          } else {
            setError(err instanceof Error ? err.message : String(err))
            setBlockedFile(null)
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [filePath, nodeId])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/fs/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId, path: filePath, content }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save file')
      }
      setSavedContent(content)
      setMeta({ size: data.size || content.length, modifiedAt: data.modifiedAt || Date.now() })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
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
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">File</h2>
              <div className="truncate font-mono text-xs text-gray-500 dark:text-gray-400" title={filePath}>{filePath}</div>
              <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                node {nodeId} · directory {directoryPath}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onOpenFileTab && (
              <button
                onClick={() => onOpenFileTab(nodeId, filePath)}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                title="Open file tab"
              >
                <FileText className="h-4 w-4" />
                <span className="hidden md:inline">Open file tab</span>
              </button>
            )}
            <button
              onClick={() => onOpenTerminal?.(directoryPath)}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              title="Open terminal"
            >
              <SquareTerminal className="h-4 w-4" />
              <span className="hidden md:inline">Open terminal</span>
            </button>
            <button
              onClick={() => triggerBrowserDownload(buildWorkspaceDownloadUrl(filePath))}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              title="Download file"
            >
              <Download className="h-4 w-4" />
              <span className="hidden md:inline">Download file</span>
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Save file"
            >
              <Save className="h-4 w-4" />
              <span className="hidden md:inline">{saving ? 'Saving...' : 'Save file'}</span>
            </button>
          </div>
        </div>

        {meta && (
          <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
            {formatSize(meta.size)} · updated {formatTimestamp(meta.modifiedAt)}
            {dirty && <span className="ml-2 text-amber-600 dark:text-amber-300">Unsaved changes</span>}
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-200">
            {error}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
            Loading file…
          </div>
        ) : blockedFile ? (
          <div className="flex h-full items-center justify-center p-4">
            <div className="w-full max-w-xl rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-100">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                <div className="space-y-3">
                  <div>
                    <div className="font-semibold">File too large to open in the editor</div>
                    <div className="mt-1 text-sm opacity-90">
                      <span className="font-mono">{blockedFile.path}</span> is {formatSize(blockedFile.size)}, which exceeds the {formatSize(blockedFile.maxSize)} inline viewing limit. Please download it to inspect locally.
                    </div>
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={() => triggerBrowserDownload(buildWorkspaceDownloadUrl(blockedFile.path))}
                      className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400"
                    >
                      <Download className="h-4 w-4" />
                      <span>Download file</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <Suspense fallback={<div className="flex h-full items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">Loading editor…</div>}>
            <MonacoFileEditor value={content} onChange={setContent} filePath={filePath} />
          </Suspense>
        )}
      </div>
    </div>
  )
}