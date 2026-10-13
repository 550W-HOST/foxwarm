import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Server } from 'lucide-react'
import { API_BASE_PATH } from '../config'

type NodeOption = { id: string; label: string; selectable: boolean; reason: string | null }

export default function NodePicker({ sessionId, currentNode = 'master', disabled, onChangeNode }: {
  sessionId: string
  currentNode?: string
  disabled: boolean
  onChangeNode: (nodeId: string, signal: AbortSignal) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [nodes, setNodes] = useState<NodeOption[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockedReason, setLockedReason] = useState<string | null>(null)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({ position: 'fixed' })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<AbortController | null>(null)
  const wasOpenRef = useRef(false)
  const remote = currentNode !== 'master'

  const positionPopup = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(320, Math.max(0, window.innerWidth - 16))
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    const above = Math.max(0, rect.top - 16)
    const below = Math.max(0, window.innerHeight - rect.bottom - 16)
    const openAbove = above >= 180 || above >= below
    const maxHeight = Math.min(360, openAbove ? above : below)
    setPopupStyle({
      position: 'fixed', left, width, maxHeight,
      ...(openAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
    })
  }, [])

  useLayoutEffect(() => {
    if (open) positionPopup()
  }, [open, currentNode, positionPopup])

  useEffect(() => () => pendingRef.current?.abort(), [])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/nodes`, { signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load nodes.')
        if (controller.signal.aborted) return
        setNodes(data.nodes)
        setLockedReason(data.lockedReason)
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load nodes.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [open, sessionId])

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!buttonRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    }
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', positionPopup)
    window.addEventListener('scroll', positionPopup, true)
    const observer = new ResizeObserver(positionPopup)
    const anchor = buttonRef.current?.closest('.foxwarm-chat-root') || buttonRef.current
    if (anchor) observer.observe(anchor)
    return () => {
      observer.disconnect()
      document.removeEventListener('mousedown', outside, true)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', positionPopup)
      window.removeEventListener('scroll', positionPopup, true)
    }
  }, [open, positionPopup])

  useEffect(() => {
    if (open) popupRef.current?.focus({ preventScroll: true })
    else if (wasOpenRef.current) buttonRef.current?.focus({ preventScroll: true })
    wasOpenRef.current = open
  }, [open])

  const selectNode = async (nodeId: string) => {
    if (disabled || pendingRef.current || nodeId === currentNode) return
    const controller = new AbortController()
    pendingRef.current = controller
    setSaving(true)
    setError(null)
    try {
      await onChangeNode(nodeId, controller.signal)
      if (!controller.signal.aborted) setOpen(false)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not switch node.')
    } finally {
      pendingRef.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  const options = nodes.some(node => node.id === currentNode) || loading ? nodes : [
    ...nodes, { id: currentNode, label: currentNode, selectable: false, reason: 'Unavailable' },
  ]

  return (
    <div className={`foxwarm-node-picker-root flex ${remote ? 'min-w-10 max-w-[10rem] shrink' : 'w-8 shrink-0'}`}>
      <button
        ref={buttonRef}
        type="button"
        className={`foxwarm-node-picker-trigger inline-flex h-8 min-w-0 items-center rounded-lg text-[13px] text-fw-text-muted transition hover:bg-fw-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring disabled:opacity-50 dark:hover:bg-fw-hover ${remote ? 'gap-1.5 px-2.5' : 'w-8 justify-center'}`}
        disabled={disabled || saving}
        aria-label={`Execution node: ${currentNode}`}
        title={`Execution node: ${currentNode}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setNodes([])
            setLoading(true)
            setError(null)
            setLockedReason(null)
            positionPopup()
          }
          setOpen(value => !value)
        }}
      >
        <Server size={14} strokeWidth={2} className={`shrink-0 ${remote ? 'text-fw-accent' : ''}`} aria-hidden="true" />
        {remote && <span className="truncate">{currentNode}</span>}
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          tabIndex={-1}
          role="dialog"
          aria-label="Execution node"
          data-node-picker-popup="true"
          style={popupStyle}
          className="z-50 flex flex-col overflow-hidden rounded-lg border border-fw-border bg-fw-surface text-sm text-fw-text shadow-lg outline-none dark:bg-fw-canvas"
        >
          <div className="shrink-0 border-b border-fw-border px-3 py-2 font-medium">Execution node</div>
          {loading && <div className="px-3 py-2 text-fw-text-muted">Loading nodes...</div>}
          {lockedReason && <div className="px-3 py-2 text-fw-text-muted">{lockedReason}</div>}
          {error && <div role="alert" className="px-3 py-2 text-fw-danger">{error}</div>}
          <div className="min-h-0 overflow-y-auto">
            {options.map(node => (
              <button
                key={node.id}
                type="button"
                data-node-option={node.id}
                aria-pressed={node.id === currentNode}
                disabled={disabled || saving || !node.selectable}
                title={node.reason || node.label}
                onClick={() => void selectNode(node.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-fw-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fw-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check size={14} className={`shrink-0 text-fw-accent ${node.id === currentNode ? '' : 'invisible'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{node.id}</span>
                  {(node.reason || node.label !== node.id) && <span className="block truncate text-xs text-fw-text-muted">{node.reason || node.label}</span>}
                </span>
              </button>
            ))}
          </div>
          {saving && <div role="status" className="shrink-0 px-3 py-2 text-fw-text-muted">Switching node...</div>}
        </div>, document.body,
      )}
    </div>
  )
}
