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
      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:bg-gray-50 disabled:text-gray-600 disabled:opacity-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-900 dark:disabled:text-gray-300"
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