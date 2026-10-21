import type { Message } from './components/chatShared'
import { mergeHistoryMessages } from './chatHistoryState'

export type HistoryMode = 'active' | 'continuous'
export const CONTINUOUS_HISTORY_PAGE_SIZE = 100
export const CONTINUOUS_HISTORY_WINDOW_SIZE = 200

export function isRawHistoryMessage(message: Message): boolean {
  return !message.__meta?.contextBlock && !message.__meta?.temporary && !message.__meta?.optimistic
    && Number.isSafeInteger(message.__meta?.seq)
}

/** New live rows need the same durable image proof as rows loaded from Archive. */
function withArchiveImageProof(message: Message): Message {
  let changed = false
  const parts = message.parts.map(part => {
    const ref = part.inlineDataRef
    if (!ref?.blobId || /[?&]archiveSeq=/.test(ref.apiPath || '')) return part
    changed = true
    const apiPath = ref.apiPath || `/blobs/${encodeURIComponent(ref.blobId)}`
    return { ...part, inlineDataRef: { ...ref, apiPath: `${apiPath}${apiPath.includes('?') ? '&' : '?'}archiveSeq=${message.__meta!.seq}` } }
  })
  return changed ? { ...message, parts } : message
}

/** Archive rows remain original even when active context is compacted or pruned. */
export function mergeContinuousHistory(loaded: Message[], incoming: Message[]): Message[] {
  return mergeHistoryMessages(loaded, incoming.filter(isRawHistoryMessage).map(withArchiveImageProof))
}

export type ContinuousContextRange = { start: number; end: number }
export type ContinuousContextDemand = { message: Message; sequences: number[] }

/** Only loaded originals lacking an active payload can need non-leaf membership. */
export function getContinuousContextDemand(active: Message[], loaded: Message[]): ContinuousContextDemand[] {
  const activeSeqs = new Set(active.filter(isRawHistoryMessage).map(message => message.__meta!.seq!))
  const candidates = loaded.filter(message => !activeSeqs.has(message.__meta!.seq!)).map(message => message.__meta!.seq!)
  return active.flatMap(message => {
    const block = message.__meta?.contextBlock
    if (block?.sourceKind !== 'block') return []
    const sequences = candidates.filter(seq => seq >= block.rawStartSeq! && seq <= block.rawEndSeq!)
    return sequences.length ? [{ message, sequences }] : []
  })
}

export function getContinuousContextDemandKey(demand: ContinuousContextDemand[]): string {
  return demand.map(({ message, sequences }) => `${message.__meta!.contextBlock!.id}:${sequences.join(',')}`).join(';')
}

/** Only message-backed leaves prove membership; higher-level envelopes can contain gaps. */
export async function resolveContinuousContextRanges(messages: Message[], sequences: number[], expandBlock: (id: number) => Promise<Message[]>): Promise<ContinuousContextRange[]> {
  const ranges = await Promise.all(messages.map(async message => {
    const block = message.__meta?.contextBlock
    if (!block) return []
    const candidates = sequences.filter(seq => seq >= block.rawStartSeq! && seq <= block.rawEndSeq!)
    if (!candidates.length) return []
    if (block.sourceKind === 'block') return resolveContinuousContextRanges(await expandBlock(block.id), candidates, expandBlock)
    return Number.isSafeInteger(block.rawStartSeq) && Number.isSafeInteger(block.rawEndSeq)
      && block.rawStartSeq! > 0 && block.rawEndSeq! >= block.rawStartSeq!
      ? [{ start: block.rawStartSeq!, end: block.rawEndSeq! }] : []
  }))
  return ranges.flat()
}

/** Active rows own their payload and absence; surviving CTX members supply older originals. */
export function projectContinuousHistory(loaded: Message[], active: Message[], resolvedBlocks: ReadonlyMap<number, ContinuousContextRange[]> = new Map()): Message[] {
  const activeBySeq = new Map(active.filter(isRawHistoryMessage).map(message => [message.__meta!.seq!, message]))
  const compactedRanges = active.flatMap(message => {
    const block = message.__meta?.contextBlock
    if (block?.sourceKind === 'block') return resolvedBlocks.get(block.id) || []
    return block && Number.isSafeInteger(block.rawStartSeq) && Number.isSafeInteger(block.rawEndSeq)
      && block.rawStartSeq! > 0 && block.rawEndSeq! >= block.rawStartSeq!
      ? [{ start: block.rawStartSeq!, end: block.rawEndSeq! }] : []
  }).sort((left, right) => left.start - right.start)
  let rangeIndex = 0
  return loaded.flatMap(original => {
    const seq = original.__meta!.seq!
    const current = activeBySeq.get(seq)
    if (current) return [current]
    while (rangeIndex < compactedRanges.length && compactedRanges[rangeIndex].end < seq) rangeIndex += 1
    return rangeIndex < compactedRanges.length && compactedRanges[rangeIndex].start <= seq ? [original] : []
  })
}

/** Published canonical deltas cannot replace originals or bridge an unloaded gap. */
export function appendContinuousCommits(loaded: Message[], committed: Message[]): Message[] {
  if (!loaded.length) return committed.filter(isRawHistoryMessage).map(withArchiveImageProof)
  const lastSeq = loaded.at(-1)?.__meta?.seq || 0
  const newer = committed.filter(message => isRawHistoryMessage(message) && (message.__meta?.seq || 0) > lastSeq)
    .sort((left, right) => left.__meta!.seq! - right.__meta!.seq!)
  const contiguous: Message[] = []
  let nextSeq = lastSeq + 1
  for (const message of newer) {
    if (message.__meta!.seq !== nextSeq) break
    contiguous.push(message)
    nextSeq += 1
  }
  return contiguous.length ? mergeContinuousHistory(loaded, contiguous) : loaded
}
