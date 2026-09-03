import type { NodeTargetService, WebUiNodeTarget } from '../nodeTargets'
import { formatNodeTargetLabel, getNodeTargetAvailability, preserveSelectedNodeTarget } from '../nodeTargets'

type NodeTargetSelectProps = {
  value: string
  nodes: readonly WebUiNodeTarget[]
  requiredService: NodeTargetService
  onChange: (nodeId: string) => void
  disabled?: boolean
}

export default function NodeTargetSelect({ value, nodes, requiredService, onChange, disabled = false }: NodeTargetSelectProps) {
  const options = preserveSelectedNodeTarget(nodes, value)
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-sm text-fw-text-strong disabled:bg-fw-surface-sunken disabled:text-fw-text disabled:opacity-100 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong dark:disabled:bg-fw-canvas dark:disabled:text-fw-text"
    >
      {options.map((node) => {
        const availability = getNodeTargetAvailability(node, requiredService)
        return (
          <option key={node.id} value={node.id} disabled={!availability.available}>
            {formatNodeTargetLabel(node, requiredService)}
          </option>
        )
      })}
    </select>
  )
}