// Pure, synchronous presentation helpers for the ChatComposer child-model area.
// They turn the server-provided `childModelDefault` / `effectiveChildModelKey` /
// `childPolicyChain` triple into explicit labels so the composer never has to
// blend "follow" and "default" into one ambiguous phrase.

export type ChildPolicyChainEntry = {
  level: 'session' | 'inherited'
  sessionId?: string | null
  modelKey?: string | null
  effort?: string | null
  childModelDefault?: string | null
  childEffortDefault?: string | null
  source?: 'explicit' | 'inherited' | 'follow-parent'
  supplies?: boolean
}

export type ChildModelComposerInput = {
  childModelDefault?: string | null
  effectiveChildModelKey?: string
  childModelPolicySource?: 'explicit' | 'follow-parent'
  childPolicyChain?: ChildPolicyChainEntry[]
  childEffortDefault?: string | null
  effectiveChildEffort?: string
  childAllowedEfforts?: string[]
  childStaleEffort?: string | null
  childFallbackLabel?: string
}

export type ChildModelComposerState = {
  /** `pinned` when a concrete child model is set, otherwise `follow`. */
  mode: 'pinned' | 'follow'
  source: 'explicit' | 'follow-parent'
  /** Compact chip label: the concrete key when pinned, else "Follow parent → target". */
  label: string
  /** Narrow-screen label, dropping the resolved target. */
  shortLabel: string
  /** Resolved model the follow state points at, when known. */
  target: string | null
  /** Compact single-line chain, root-first, marking the supplying hop. */
  chainLabel: string | null
  /** Multi-line chain for a tooltip, root-first. */
  chainTitle: string | null
  /** Stale child effort explanation: value, why unavailable, fallback used. */
  staleEffortLabel: string | null
}

const SUPPLY_MARKER = '•'
const HOP_MARKER = '·'
const MAX_HOP_ID_LENGTH = 24

function trimOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function shortHopName(entry: ChildPolicyChainEntry): string {
  if (entry.level === 'session') return 'this session'
  const id = trimOrNull(entry.sessionId)
  if (!id) return 'inherited'
  const lastSegment = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  const name = lastSegment || id
  return name.length > MAX_HOP_ID_LENGTH ? `${name.slice(0, MAX_HOP_ID_LENGTH - 1)}…` : name
}

function hopNode(entry: ChildPolicyChainEntry): string {
  const marker = entry.supplies ? SUPPLY_MARKER : HOP_MARKER
  // Show the child-policy value this hop contributes: its pinned child model
  // when set, otherwise the model the hop runs with.
  const model = trimOrNull(entry.childModelDefault) || trimOrNull(entry.modelKey) || 'follow'
  return `${marker} ${shortHopName(entry)} = ${model}`
}

function normalizeChain(chain: ChildPolicyChainEntry[]): ChildPolicyChainEntry[] {
  // Server order is session -> ancestors; display root -> session.
  return chain.filter(entry => entry && (entry.level === 'session' || entry.level === 'inherited')).slice().reverse()
}

export function buildChildModelComposerState(input: ChildModelComposerInput): ChildModelComposerState {
  const pinned = trimOrNull(input.childModelDefault)
  const target = trimOrNull(input.effectiveChildModelKey) || pinned
  const mode: ChildModelComposerState['mode'] = pinned ? 'pinned' : 'follow'
  const source: ChildModelComposerState['source'] = pinned ? 'explicit' : (input.childModelPolicySource || 'follow-parent')
  const label = pinned ? pinned : `Follow parent → ${target || 'model'}`

  const stale = trimOrNull(input.childStaleEffort)
  const fallback = trimOrNull(input.childFallbackLabel) || trimOrNull(input.effectiveChildEffort) || 'per-leaf default'
  const staleEffortLabel = stale
    ? `${stale} is unavailable for ${target || 'the target model'} (not in its allowed efforts); using ${fallback}`
    : null

  const chain = normalizeChain(input.childPolicyChain || [])
  return {
    mode,
    source,
    label,
    shortLabel: pinned ? pinned : 'Follow parent',
    target,
    chainLabel: chain.length ? chain.map(hopNode).join(' → ') : null,
    chainTitle: chain.length ? chain.map(hopNode).join('\n') : null,
    staleEffortLabel,
  }
}
