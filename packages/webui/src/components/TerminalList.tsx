import { X } from 'lucide-react'
import { formatTerminalAge, terminalShellName, type TerminalRegistryRecord } from '../terminalRegistry'

export interface TerminalListOptions {
  /** Running terminals across Nodes; null until the first list arrives. */
  terminals: readonly TerminalRegistryRecord[] | null
  /** Terminals shown by a tab of this window. */
  openTerminalIds: ReadonlySet<string>
  onOpen: (terminal: TerminalRegistryRecord) => void
  onKill: (terminal: TerminalRegistryRecord) => void
  onRefresh: () => void
}

/** Running terminals with open and kill actions. Controls stay visible for touch use. */
export default function TerminalList({ terminals, openTerminalIds, onOpen, onKill }: Omit<TerminalListOptions, 'onRefresh'>) {
  const now = Date.now()
  return (
    <section aria-label="Running terminals" data-terminal-list>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-fw-text-muted">
        Running terminals{terminals && terminals.length > 0 ? ` · ${terminals.length}` : ''}
      </h3>
      {terminals === null ? (
        <div className="py-1 text-sm text-fw-text-muted">Loading…</div>
      ) : terminals.length === 0 ? (
        <div className="py-1 text-sm text-fw-text-muted">No running terminals</div>
      ) : (
        <ul className="-mx-1 max-h-64 space-y-0.5 overflow-y-auto">
          {terminals.map((terminal) => {
            const open = openTerminalIds.has(terminal.id)
            const details = [
              terminal.nodeId,
              terminal.pid > 0 ? `pid ${terminal.pid}` : '',
              terminalShellName(terminal.shell),
              formatTerminalAge(terminal.createdAt, now),
            ].filter(Boolean).join(' · ')
            return (
              <li key={terminal.id} data-terminal-row={terminal.id} className="flex items-center gap-0.5 rounded-lg hover:bg-fw-hover">
                <button
                  type="button"
                  onClick={() => onOpen(terminal)}
                  title={`${terminal.cwd} · ${terminal.nodeId}`}
                  className="foxwarm-terminal-list-open flex min-w-0 flex-1 flex-col justify-center rounded-lg px-2 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring/40"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {/* Long paths keep their last segments visible. */}
                    <span dir="rtl" className="min-w-0 truncate text-sm text-fw-text-strong">{`\u200E${terminal.cwd}\u200E`}</span>
                    {open && <span className="shrink-0 rounded bg-fw-accent-surface px-1.5 py-px text-[10px] font-medium text-fw-accent dark:bg-fw-accent-surface-strong/40">Open</span>}
                  </span>
                  <span className="truncate text-xs text-fw-text-muted">{details}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onKill(terminal)}
                  title="Kill terminal"
                  aria-label="Kill terminal"
                  className="foxwarm-terminal-list-kill inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fw-text-muted hover:bg-fw-selected hover:text-fw-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring/40"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
