import { Brain } from 'lucide-react'
import type { ReasoningBadgeInfo } from './reasoningParts'

export default function ReasoningTokenBadge({ badges }: { badges?: readonly ReasoningBadgeInfo[] }) {
  if (!badges?.length) return null
  return <span data-reasoning-handoff className="inline-flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-fw-text-muted">
    {badges.map((badge, index) => {
      const label = badge.reasoningTokens === undefined ? 'Reasoning' : `Reasoning: ${badge.reasoningTokens} tokens`
      return <span key={index} role="img" className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10px] tabular-nums" title={label} aria-label={label}>
        <Brain aria-hidden="true" size={11} />
        {badge.reasoningTokens !== undefined && <span data-reasoning-tokens>{badge.reasoningTokens} tokens</span>}
      </span>
    })}
  </span>
}