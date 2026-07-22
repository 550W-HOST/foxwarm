export type VirtualProviderType = 'session-hash' | 'failover'

export type ProviderDraft = {
  id: string
  providerType: string
  isVirtual: boolean
  baseUrl: string
  apiKey: string
  models: string
  defaultModel: string
  targets: string
  failureThreshold: string
  cooldownMs: string
}

export type ProviderStatusDraft = Partial<Omit<ProviderDraft, 'targets' | 'failureThreshold' | 'cooldownMs'>> & {
  targets?: string[] | string
  failureThreshold?: number | string | null
  cooldownMs?: number | string | null
}

export type ModelsSetupRequest = {
  mode: 'form'
  defaultModel: string
  providers: Array<Record<string, unknown>>
}

export function isVirtualProviderType(providerType: string): providerType is VirtualProviderType {
  return providerType === 'session-hash' || providerType === 'failover'
}

export function makeDefaultProvider(index = 0): ProviderDraft {
  return {
    id: index === 0 ? 'openai' : `provider${index + 1}`,
    providerType: 'openai-completions',
    isVirtual: false,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: 'gpt-5.2-codex\ngpt-5.3-codex\ngpt-5.4\ngpt-5.5',
    defaultModel: 'gpt-5.2-codex',
    targets: '',
    failureThreshold: '',
    cooldownMs: '',
  }
}

export function splitModels(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
}

export function splitTargets(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function editableOptionalNumber(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

export function hydrateProviderDrafts(providers: ProviderStatusDraft[]): ProviderDraft[] {
  return providers.map((provider, index) => {
    const providerType = provider.providerType || 'openai-completions'
    const isVirtual = provider.isVirtual === true || isVirtualProviderType(providerType)
    const models = typeof provider.models === 'string' ? provider.models : ''
    const targets = Array.isArray(provider.targets)
      ? provider.targets.map((target) => String(target)).join('\n')
      : typeof provider.targets === 'string' ? provider.targets : ''
    return {
      id: provider.id || `provider${index + 1}`,
      providerType,
      isVirtual,
      baseUrl: isVirtual ? '' : provider.baseUrl || '',
      apiKey: isVirtual ? '' : provider.apiKey || '',
      models: isVirtual ? '' : models,
      defaultModel: isVirtual ? '' : provider.defaultModel || splitModels(models)[0] || '',
      targets: isVirtual ? targets : '',
      failureThreshold: providerType === 'failover' ? editableOptionalNumber(provider.failureThreshold) : '',
      cooldownMs: providerType === 'failover' ? editableOptionalNumber(provider.cooldownMs) : '',
    }
  })
}

export function changeProviderType(provider: ProviderDraft, providerType: string): ProviderDraft {
  const wasVirtual = isVirtualProviderType(provider.providerType)
  const isVirtual = isVirtualProviderType(providerType)
  if (!isVirtual && !wasVirtual) {
    return { ...provider, providerType, isVirtual: false }
  }
  if (isVirtual) {
    return {
      ...provider,
      providerType,
      isVirtual: true,
      baseUrl: '',
      apiKey: '',
      models: '',
      defaultModel: '',
      targets: wasVirtual ? provider.targets : '',
      failureThreshold: providerType === 'failover' && provider.providerType === 'failover' ? provider.failureThreshold : '',
      cooldownMs: providerType === 'failover' && provider.providerType === 'failover' ? provider.cooldownMs : '',
    }
  }
  return {
    ...provider,
    providerType,
    isVirtual: false,
    baseUrl: '',
    apiKey: '',
    models: '',
    defaultModel: '',
    targets: '',
    failureThreshold: '',
    cooldownMs: '',
  }
}

export function changeDefaultForProviderType(defaultModelKey: string, provider: ProviderDraft, providerType: string): string {
  const defaultKey = defaultModelKey.trim()
  const providerId = provider.id.trim()
  if (!providerId) return defaultModelKey
  if (isVirtualProviderType(providerType) && (defaultKey === providerId || defaultKey.startsWith(`${providerId}/`))) {
    return providerId
  }
  if (!isVirtualProviderType(providerType) && isVirtualProviderType(provider.providerType) && defaultKey === providerId) {
    return ''
  }
  return defaultModelKey
}

function parseOptionalPositiveInteger(value: string, field: string, providerId: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Provider \`${providerId}\` ${field} must be a positive integer.`)
  }
  return parsed
}

function previewOptionalPositiveInteger(value: string): number | undefined {
  const parsed = Number(value.trim())
  return value.trim() && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function validateExactDuplicates(targets: string[], providerId: string): void {
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target)) {
      throw new Error(`Provider \`${providerId}\` has duplicate target \`${target}\`.`)
    }
    seen.add(target)
  }
}

export function validateProviderDrafts(providers: ProviderDraft[]): void {
  const providerIds = new Set<string>()
  let usableCount = 0
  for (const provider of providers) {
    const id = provider.id.trim()
    if (!id) throw new Error('Every provider requires a provider id.')
    if (providerIds.has(id)) throw new Error(`Provider id \`${id}\` is duplicated.`)
    providerIds.add(id)
    usableCount += 1

    if (!isVirtualProviderType(provider.providerType)) {
      if (splitModels(provider.models).length === 0) {
        throw new Error(`Provider \`${id}\` requires at least one model id.`)
      }
      continue
    }

    const targets = splitTargets(provider.targets)
    validateExactDuplicates(targets, id)
    const minimumTargets = provider.providerType === 'failover' ? 2 : 1
    if (targets.length < minimumTargets) {
      throw new Error(`Provider \`${id}\` (${provider.providerType}) requires at least ${minimumTargets} target${minimumTargets === 1 ? '' : 's'}.`)
    }
    if (provider.providerType === 'failover') {
      parseOptionalPositiveInteger(provider.failureThreshold, 'failureThreshold', id)
      parseOptionalPositiveInteger(provider.cooldownMs, 'cooldownMs', id)
    }
  }
  if (usableCount === 0) throw new Error('At least one provider is required.')
}

function defaultModelFor(providers: ProviderDraft[], requestedDefault: string): string {
  const explicit = requestedDefault.trim()
  if (explicit) return explicit
  const first = providers.find((provider) => provider.id.trim())
  if (!first) return ''
  const id = first.id.trim()
  if (isVirtualProviderType(first.providerType)) return id
  const model = first.defaultModel.trim() || splitModels(first.models)[0] || ''
  return model ? `${id}/${model}` : id
}

function toStructuredProvider(provider: ProviderDraft): Record<string, unknown> {
  const id = provider.id.trim()
  const providerType = provider.providerType.trim() || 'openai-completions'
  if (isVirtualProviderType(providerType)) {
    const result: Record<string, unknown> = {
      id,
      providerType,
      isVirtual: true,
      targets: splitTargets(provider.targets),
    }
    if (providerType === 'failover') {
      const failureThreshold = parseOptionalPositiveInteger(provider.failureThreshold, 'failureThreshold', id)
      const cooldownMs = parseOptionalPositiveInteger(provider.cooldownMs, 'cooldownMs', id)
      if (failureThreshold !== undefined) result.failureThreshold = failureThreshold
      if (cooldownMs !== undefined) result.cooldownMs = cooldownMs
    }
    return result
  }
  return {
    id,
    providerType,
    isVirtual: false,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    models: provider.models,
    defaultModel: provider.defaultModel,
  }
}

export function buildStructuredSetupRequest(providers: ProviderDraft[], defaultModelKey: string): ModelsSetupRequest {
  validateProviderDrafts(providers)
  return {
    mode: 'form',
    defaultModel: defaultModelFor(providers, defaultModelKey),
    providers: providers.map(toStructuredProvider),
  }
}

function yamlQuote(value: string): string {
  return JSON.stringify(value)
}

export function buildModelsYaml(providers: ProviderDraft[], defaultModelKey: string): string {
  const lines = [`default: ${yamlQuote(defaultModelFor(providers, defaultModelKey))}`, 'providers:']
  for (const provider of providers) {
    const id = provider.id.trim()
    const providerType = provider.providerType.trim() || 'openai-completions'
    lines.push(`  ${id}:`)
    lines.push(`    providerType: ${yamlQuote(providerType)}`)
    if (isVirtualProviderType(providerType)) {
      lines.push('    targets:')
      for (const target of splitTargets(provider.targets)) lines.push(`      - ${yamlQuote(target)}`)
      if (providerType === 'failover') {
        const failureThreshold = previewOptionalPositiveInteger(provider.failureThreshold)
        const cooldownMs = previewOptionalPositiveInteger(provider.cooldownMs)
        if (failureThreshold !== undefined) lines.push(`    failureThreshold: ${failureThreshold}`)
        if (cooldownMs !== undefined) lines.push(`    cooldownMs: ${cooldownMs}`)
      }
      continue
    }
    if (provider.baseUrl.trim()) lines.push(`    baseUrl: ${yamlQuote(provider.baseUrl.trim())}`)
    if (provider.apiKey.trim()) lines.push(`    apiKey: ${yamlQuote(provider.apiKey.trim())}`)
    lines.push('    models:')
    for (const model of splitModels(provider.models)) lines.push(`      - ${yamlQuote(model)}`)
  }
  return `${lines.join('\n')}\n`
}

export function canTestProvider(provider: ProviderDraft | undefined): boolean {
  return !!provider && !isVirtualProviderType(provider.providerType)
}

export function buildConcreteTestRequest(provider: ProviderDraft): Record<string, unknown> {
  if (!canTestProvider(provider)) throw new Error('Virtual providers are tested after saving through normal model selection.')
  const testModel = provider.defaultModel || splitModels(provider.models)[0]
  return {
    providerKey: provider.id,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    models: provider.models,
    defaultModel: testModel,
    testModel,
  }
}
