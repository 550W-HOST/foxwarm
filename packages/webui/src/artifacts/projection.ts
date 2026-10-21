import { assistantArtifactReferences } from '../components/markdownRenderer'
import { parseArtifactReceipt, type ArtifactReceipt } from '../../../shared/src/artifacts/types'
import type { Message } from '../components/chatShared'
export interface ArtifactGroup { key: string; endIndex: number; artifacts: ArtifactReceipt[] }
/** Structured successful tool receipts only; never interpret prose or code fences. */
export function buildArtifactGroups(messages: readonly Message[], sessionId: string): ArtifactGroup[] {
  const groups: ArtifactGroup[] = [], seen = new Set<string>()
  let artifacts: ArtifactReceipt[] = [], embedded = new Set<string>()
  const flush = (endIndex: number) => { const standalone = artifacts.filter(a => !embedded.has(`${a.artifactId}:${a.revision}`)); if (standalone.length) groups.push({ key: `artifacts:${standalone[0].artifactId}:${standalone[0].revision}`, endIndex, artifacts: standalone }); artifacts = []; embedded = new Set() }
  messages.forEach((msg, index) => {
    if (msg.__meta?.contextBlock || msg.role === 'user' && !msg.parts.some(p => p.functionResponse) && msg.parts.some(p => p.text !== undefined || p.inlineData || p.inlineDataRef || p.system && !/^\s*<foxwarm-system\b/.test(p.system))) flush(index - 1)
    if (msg.role === 'model' && msg.modelVisible !== false && !msg.__meta?.contextBlock && !msg.__meta?.noticeType) { for (const p of msg.parts) if (p.text) for (const ref of assistantArtifactReferences(p.text)) embedded.add(`${ref.artifactId}:${ref.revision}`) }
    if (msg.role === 'model' || msg.__meta?.queuedPreview) return
    for (const p of msg.parts) {
      const r = p.functionResponse
      if (!r || r.response?.error || (r.response as any)?.isError || !['artifact', 'call_tool', 'run_script', 'continue_script'].includes(r.name.replace(/^functions\./, ''))) continue
      const pending: { value: unknown; depth: number }[] = [{ value: r.response, depth: 0 }]
      let count = 0
      while (pending.length && count++ < 512) {
        const { value, depth } = pending.pop()!
        if (!value || typeof value !== 'object' || depth > 8) continue
        const receipt = parseArtifactReceipt((value as any).artifact)
        if (receipt?.sessionId === sessionId) {
          const key = `${receipt.artifactId}:${receipt.revision}`
          if (!seen.has(key)) { seen.add(key); artifacts.push(receipt) }
        }
        for (const child of Object.values(value).slice(0, 128)) if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 })
      }
    }
  })
  flush(messages.length - 1)
  return groups
}
