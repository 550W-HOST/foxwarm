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
