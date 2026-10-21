import { Brain } from 'lucide-react'
import type { ReasoningBadgeInfo } from './reasoningParts'

export default function ReasoningTokenBadge({ badges }: { badges?: readonly ReasoningBadgeInfo[] }) {
  if (!badges?.length) return null
  let reasoningTokens: number | undefined
  for (const badge of badges) {
    if (badge.reasoningTokens !== undefined) reasoningTokens = (reasoningTokens ?? 0) + badge.reasoningTokens
  }
  const label = reasoningTokens === undefined ? 'Reasoning' : `Reasoning: ${reasoningTokens} tokens`
  return <span data-reasoning-handoff className="inline-flex shrink-0 items-center justify-end text-fw-text-muted">
    <span role="img" className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10px] tabular-nums" title={label} aria-label={label}>
      <Brain aria-hidden="true" size={11} />
      {reasoningTokens !== undefined && <span data-reasoning-tokens>{reasoningTokens} tokens</span>}
    </span>
  </span>
}
