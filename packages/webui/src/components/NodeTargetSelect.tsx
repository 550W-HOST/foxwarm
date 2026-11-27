import type { NodeTargetService, WebUiNodeTarget } from '../nodeTargets'
import { formatNodeTargetLabel, getNodeTargetAvailability, preserveSelectedNodeTarget } from '../nodeTargets'
import Select from './Select'

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
    <Select
      aria-label="Node"
      value={value}
      onChange={onChange}
      disabled={disabled}
      className="w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-sm text-fw-text-strong disabled:bg-fw-surface-sunken disabled:text-fw-text disabled:opacity-100 dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong dark:disabled:bg-fw-canvas dark:disabled:text-fw-text"
      options={options.map((node) => ({
        value: node.id,
        label: formatNodeTargetLabel(node, requiredService),
        disabled: !getNodeTargetAvailability(node, requiredService).available,
      }))}
    />
  )
}