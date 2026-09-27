export type FilterableModelOption = {
  key: string
  label: string
  isDefault?: boolean
  providerKey?: string | null
  modelId?: string | null
  providerType?: string | null
  isVirtual?: boolean
  targets?: string[]
}

export function formatModelLabel(option: FilterableModelOption, defaultModelKey?: string) {
  return `${option.label}${option.key === defaultModelKey || option.isDefault ? ' · default' : ''}`
}

export function filterModelOptions<T extends FilterableModelOption>(options: T[], query: string, defaultModelKey?: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return options
  return options.filter((option) => (
    formatModelLabel(option, defaultModelKey).toLowerCase().includes(normalizedQuery)
    || option.key.toLowerCase().includes(normalizedQuery)
  ))
}

/** Provider prefix of a model key (`provider/...`), or null when the key has no provider scope. */
export function modelProviderName(key: string | null | undefined): string | null {
  const trimmed = typeof key === 'string' ? key.trim() : ''
  const slash = trimmed.indexOf('/')
  return slash > 0 ? trimmed.slice(0, slash) : null
}

/** Readable fallback for a bare model key: the id without its provider prefix. */
export function modelKeyDisplayName(key: string | null | undefined): string {
  const trimmed = typeof key === 'string' ? key.trim() : ''
  if (!trimmed) return ''
  const slash = trimmed.indexOf('/')
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed
}

/** Configured display label for a model key, falling back to the id without its provider prefix. */
export function resolveModelDisplayName(
  key: string | null | undefined,
  options: Array<{ key: string; label: string }>,
): string {
  const trimmed = typeof key === 'string' ? key.trim() : ''
  if (!trimmed) return ''
  const option = options.find((candidate) => candidate.key === trimmed)
  if (!option) return modelKeyDisplayName(trimmed)
  return stripProviderPrefix(option.label?.trim() || trimmed, modelProviderName(trimmed))
}

/** Trigger label that qualifies only concrete model IDs duplicated across providers. */
export function resolveModelTriggerDisplayName(
  key: string | null | undefined,
  options: FilterableModelOption[],
): string {
  const trimmed = typeof key === 'string' ? key.trim() : ''
  if (!trimmed) return ''
  const option = options.find((candidate) => candidate.key === trimmed)
  if (!option || option.isVirtual) return resolveModelDisplayName(trimmed, options)
  const providerKey = option.providerKey?.trim() || ''
  const modelId = option.modelId?.trim() || ''
  const rawLabel = option.label?.trim() || ''
  const displayName = rawLabel && rawLabel !== option.key
    ? stripProviderPrefix(rawLabel, providerKey || modelProviderName(option.key))
    : (modelId || resolveModelDisplayName(trimmed, options))
  if (!providerKey || !modelId) return displayName
  const duplicatedAcrossProviders = options.some((candidate) => (
    candidate.key !== option.key
    && !candidate.isVirtual
    && candidate.modelId?.trim() === modelId
    && !!candidate.providerKey?.trim()
    && candidate.providerKey?.trim() !== providerKey
  ))
  return duplicatedAcrossProviders ? `${providerKey}/${displayName}` : displayName
}

/** Ordered virtual-routing summary for the model-option secondary label. */
export function formatVirtualModelDetail(option: FilterableModelOption): string | null {
  if (!option.isVirtual) return null
  const targets = (option.targets || []).map((target) => target.trim()).filter(Boolean)
  if (targets.length === 0) return null
  if (option.providerType === 'session-hash') {
    return targets.length === 1 ? targets[0] : `session-hash: ${targets.join(', ')}`
  }
  if (option.providerType === 'failover') return `failover: ${targets.join(', ')}`
  return null
}

/** Drop a redundant provider prefix from a label that already repeats it (e.g. `leaf/leaf-model`). */
export function stripProviderPrefix(label: string, provider: string | null): string {
  if (!provider) return label
  const prefix = `${provider}/`
  return label.startsWith(prefix) ? label.slice(prefix.length) : label
}

/** Group options by provider while preserving the original option order. */
export function groupModelOptionsByProvider<T extends { key: string }>(
  options: T[],
): Array<{ provider: string | null; options: T[] }> {
  const groups: Array<{ provider: string | null; options: T[] }> = []
  const byProvider = new Map<string | null, { provider: string | null; options: T[] }>()
  for (const option of options) {
    const provider = modelProviderName(option.key)
    let group = byProvider.get(provider)
    if (!group) {
      group = { provider, options: [] }
      byProvider.set(provider, group)
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}
