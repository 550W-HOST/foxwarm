export const MODELS_YAML_MODEL_URI = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
export const APP_CONFIG_YAML_MODEL_URI = 'inmemory://foxwarm/setup/foxwarm-config.yaml'

export const KNOWN_PROVIDER_TYPES = [
  'openai-completions',
  'openai-responses',
  'openai',
  'anthropic',
  'session-hash',
  'failover',
] as const

const knownProviderType = {
  anyOf: [
    { enum: KNOWN_PROVIDER_TYPES },
    { type: 'string' },
  ],
  description: 'Provider protocol or virtual routing strategy. Known Foxwarm values are suggested; custom provider types remain valid.',
}

const effectiveProviderTypeIs = (providerType: string) => ({
  anyOf: [
    {
      required: ['providerType'],
      properties: { providerType: { const: providerType } },
    },
    {
      required: ['provider'],
      properties: { provider: { const: providerType } },
      anyOf: [
        { not: { required: ['providerType'] } },
        { properties: { providerType: { enum: ['', null, false] } } },
      ],
    },
  ],
})

const positiveInteger = {
  type: 'integer',
  minimum: 1,
}

const modelOverrideProperties = {
  contextLimit: { type: 'integer', minimum: 1, description: 'Context window size in tokens.' },
  extraFields: { type: 'object', additionalProperties: true, description: 'Provider-specific request fields.' },
  extraHeaders: { type: 'object', additionalProperties: true, description: 'Provider-specific HTTP headers. Values are passed through to the canonical backend loader.' },
}

const modelItem = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['id'],
      additionalProperties: true,
      properties: {
        id: { type: 'string', minLength: 1, description: 'Provider model identifier.' },
        ...modelOverrideProperties,
      },
    },
  ],
}

const providerEntry = {
  type: 'object',
  additionalProperties: true,
  properties: {
    providerType: knownProviderType,
    provider: { ...knownProviderType, deprecated: true, description: 'Legacy spelling for providerType. Prefer providerType.' },
    baseUrl: { type: 'string', description: 'Provider API base URL.' },
    apiKey: { type: 'string', description: 'Provider credential. Keep this file private.' },
    models: { type: 'array', items: modelItem, description: 'Preferred provider model list.' },
    model: {
      deprecated: true,
      description: 'Legacy spelling for models. Prefer models.',
      anyOf: [
        { type: 'string' },
        { type: 'array', items: modelItem },
      ],
    },
    contextLimit: modelOverrideProperties.contextLimit,
    asyncCompact: { type: 'boolean', description: 'Whether background compaction may use this provider.' },
    requestCompression: { enum: ['gzip', 'br'], description: 'Optional request-body compression.' },
    extraFields: modelOverrideProperties.extraFields,
    extraHeaders: modelOverrideProperties.extraHeaders,
    targets: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, description: 'Concrete model keys used by a virtual provider.' },
    failureThreshold: { ...positiveInteger, description: 'Consecutive failures before a non-final failover target cools down.' },
    cooldownMs: { ...positiveInteger, description: 'Failover cooldown duration in milliseconds.' },
  },
  allOf: [
    {
      if: effectiveProviderTypeIs('session-hash'),
      then: {
        required: ['targets'],
        properties: { targets: { minItems: 1 } },
        not: { anyOf: ['models', 'model', 'baseUrl', 'apiKey', 'requestCompression', 'extraFields', 'extraHeaders', 'contextLimit', 'asyncCompact', 'failureThreshold', 'cooldownMs'].map((field) => ({ required: [field] })) },
      },
    },
    {
      if: effectiveProviderTypeIs('failover'),
      then: {
        required: ['targets'],
        properties: { targets: { minItems: 2 } },
        not: { anyOf: ['models', 'model', 'baseUrl', 'apiKey', 'requestCompression', 'extraFields', 'extraHeaders', 'contextLimit', 'asyncCompact'].map((field) => ({ required: [field] })) },
      },
    },
    {
      if: { not: { anyOf: [effectiveProviderTypeIs('session-hash'), effectiveProviderTypeIs('failover')] } },
      then: {
        not: { anyOf: ['targets', 'failureThreshold', 'cooldownMs'].map((field) => ({ required: [field] })) },
      },
    },
  ],
}

export const MODELS_CONFIG_SCHEMA = {
  $id: 'https://foxwarm.dev/schemas/models-config.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Foxwarm models configuration',
  type: 'object',
  additionalProperties: true,
  properties: {
    default: { type: 'string', minLength: 1, description: 'Default concrete or virtual model key.' },
    providers: {
      type: 'object',
      minProperties: 1,
      additionalProperties: providerEntry,
      description: 'Preferred provider map.',
    },
    models: {
      type: 'object',
      minProperties: 1,
      additionalProperties: providerEntry,
      deprecated: true,
      description: 'Legacy root spelling for providers. Prefer providers.',
    },
  },
  anyOf: [{ required: ['providers'] }, { required: ['models'] }],
}

const guestAgent = {
  type: 'object',
  additionalProperties: true,
  required: ['agentId'],
  properties: {
    agentId: { type: 'string' },
    mode: { enum: ['single', 'inherited'] },
    isolated: { type: 'boolean' },
    node: { type: 'string' },
  },
}

const channelEntry = {
  type: 'object',
  additionalProperties: true,
  properties: {
    type: {
      anyOf: [
        { enum: ['telegram', 'matrix', 'wework', 'weixin'] },
        { type: 'string' },
      ],
      description: 'Known managed channel type or a custom channel type.',
    },
    enabled: { type: 'boolean' },
    allowedUsers: { type: 'array', items: { type: 'string' } },
    guestAgent,
    botToken: { type: 'string' },
    mainAttachUser: { type: 'string' },
    homeserver: { type: 'string' },
    accessToken: { type: 'string' },
    botUserId: { type: 'string' },
    webhookUrl: { type: 'string' },
    token: { type: 'string' },
    encodingAESKey: { type: 'string' },
    listenPort: { type: 'integer', minimum: 1, maximum: 65535 },
    listenPath: { type: 'string' },
    selfName: { type: 'string' },
    baseUrl: { type: 'string' },
    routeTag: { type: 'string' },
    allowAllUsers: { type: 'boolean' },
    longPollTimeoutMs: { type: 'integer', minimum: 1 },
    loginBotType: { type: 'string' },
    aibot: {
      type: 'object',
      additionalProperties: true,
      properties: {
        stream: { type: 'boolean' },
        streamMaxContentBytes: { type: 'integer', minimum: 1 },
        websocket: {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            botId: { type: 'string' },
            secret: { type: 'string' },
            url: { type: 'string' },
            heartbeatMs: { type: 'integer', minimum: 1 },
            reconnectMs: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
}

export const APP_CONFIG_SCHEMA = {
  $id: 'https://foxwarm.dev/schemas/app-config.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Foxwarm application configuration',
  type: 'object',
  additionalProperties: true,
  properties: {
    bot: {
      type: 'object',
      additionalProperties: true,
      properties: {
        name: { type: 'string' },
        enableWebUI: { type: 'boolean' },
        enableTrigger: { type: 'boolean' },
        httpPort: { type: 'integer', minimum: 1, maximum: 65535 },
        enableTUI: { type: 'boolean' },
      },
    },
    llm: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ollamaBaseUrl: { type: 'string' },
        contextLimit: { type: 'integer', minimum: 1 },
        compactPercent: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        compactBlockLevelMinTokens: { type: 'integer', minimum: 1 },
        compactBlockLevelForceTokens: { type: 'integer', minimum: 1 },
        compactBlockCandidateFraction: { type: 'number', minimum: 0, maximum: 1 },
        compactBlockForceCompactFraction: { type: 'number', minimum: 0, maximum: 1 },
        compactMessageForceCompactFraction: { type: 'number', minimum: 0, maximum: 1 },
        maxOutput: { type: 'integer', minimum: 1 },
        thinkingBudget: { type: 'integer', minimum: 0 },
        openaiBaseUrl: { type: 'string' },
        openaiApiKey: { type: 'string' },
        anthropicBaseUrl: { type: 'string' },
        anthropicApiKey: { type: 'string' },
      },
    },
    paths: {
      type: 'object',
      additionalProperties: true,
      properties: {
        agentsDir: { type: 'string' },
        skillsDir: { type: 'string' },
        mcpConfigPath: { type: 'string' },
      },
    },
    channels: {
      type: 'object',
      additionalProperties: channelEntry,
    },
    asrService: {
      type: 'object',
      additionalProperties: true,
      properties: {
        enabled: { type: 'boolean' },
        url: { type: 'string' },
        key: { type: 'string' },
      },
    },
  },
}

export const YAML_CONFIG_SCHEMAS = [
  { uri: MODELS_CONFIG_SCHEMA.$id, fileMatch: ['**/foxwarm-models.yaml'], schema: MODELS_CONFIG_SCHEMA },
  { uri: APP_CONFIG_SCHEMA.$id, fileMatch: ['**/foxwarm-config.yaml'], schema: APP_CONFIG_SCHEMA },
]
