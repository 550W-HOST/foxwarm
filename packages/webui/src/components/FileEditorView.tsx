import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CornerDownRight, Save, SquareTerminal } from 'lucide-react'
import type { Session } from './SessionListCore'
import { API_BASE_PATH } from '../config'

interface FileEditorViewProps {
  sessionId: string
  session?: Session
  nodeId: string
  filePath: string
  onBack?: () => void
  onSessionsChanged?: () => void
  onOpenTerminal?: (cwd?: string) => void
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

export default function FileEditorView({ sessionId, session, nodeId, filePath, onBack, onSessionsChanged, onOpenTerminal }: FileEditorViewProps) {
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [meta, setMeta] = useState<{ size: number; modifiedAt: number } | null>(null)

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

    const load = async () => {
      try {
        const res = await fetch(`${API_BASE_PATH}/fs/read?nodeId=${encodeURIComponent(nodeId)}&path=${encodeURIComponent(filePath)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.error || 'Failed to read file')
        }
        if (!cancelled) {
          setContent(data.content || '')
          setSavedContent(data.content || '')
          setMeta({ size: data.size || 0, modifiedAt: data.modifiedAt || 0 })
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
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

  const handleSetSessionCwd = async () => {
    try {
      setError(null)
      const res = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/cwd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: directoryPath }),
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
                node {nodeId} · directory {directoryPath} · session {session?.displayName || sessionId}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => onOpenTerminal?.(directoryPath)}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <SquareTerminal className="h-4 w-4" />
              <span>Open terminal here</span>
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
              disabled={saving || !dirty}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              <span>{saving ? 'Saving...' : 'Save file'}</span>
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
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="h-full w-full resize-none rounded-xl border border-gray-300 bg-white p-4 font-mono text-sm text-gray-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-blue-500 dark:focus:ring-blue-900"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  )
}