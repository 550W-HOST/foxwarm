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

const openaiWebSearchOptions = {
  type: 'object',
  additionalProperties: true,
  description: 'Opt-in OpenAI Responses hosted web search settings. Ignored by non-Responses providers.',
  properties: {
    enabled: { type: 'boolean', description: 'Enable the hosted web_search tool for eligible Responses requests.' },
    toolChoice: { enum: ['auto', 'required'], description: 'Responses tool-selection mode when hosted search is enabled.' },
    searchContextSize: { enum: ['low', 'medium', 'high'], description: 'Amount of search context requested from OpenAI.' },
    allowedDomains: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Optional domain filter for web search.' },
    userLocation: {
      type: 'object',
      additionalProperties: true,
      properties: {
        type: { const: 'approximate' },
        country: { type: 'string' },
        city: { type: 'string' },
        region: { type: 'string' },
        timezone: { type: 'string' },
      },
    },
  },
}

const openaiWebSearchConfig = {
  oneOf: [
    { type: 'boolean' },
    openaiWebSearchOptions,
  ],
  description: 'Opt-in OpenAI Responses hosted web search settings. Use true/false for defaults or an object for tuning. Ignored by non-Responses providers.',
}

const modelEffortConfig = {
  type: 'object',
  additionalProperties: true,
  description: 'First-class reasoning effort capabilities and default for this provider or model.',
  properties: {
    allowed: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
      description: 'Effort levels accepted for this provider/model. Model-level values replace the provider list.',
    },
    default: {
      enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      description: 'Effort used when a request does not select one. Defaults to high.',
    },
  },
}

const modelOverrideProperties = {
  contextLimit: { type: 'integer', minimum: 1, description: 'Context window size in tokens.' },
  effort: modelEffortConfig,
  extraFields: { type: 'object', additionalProperties: true, description: 'Provider-specific request fields.' },
  extraHeaders: { type: 'object', additionalProperties: true, description: 'Provider-specific HTTP headers. Values are passed through to the canonical backend loader.' },
  webSearch: openaiWebSearchConfig,
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

const providerObjectEntry = {
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
    effort: modelEffortConfig,
    asyncCompact: { type: 'boolean', description: 'Whether background compaction may use this provider.' },
    requestCompression: { enum: ['gzip', 'br'], description: 'Optional request-body compression.' },
    extraFields: modelOverrideProperties.extraFields,
    extraHeaders: modelOverrideProperties.extraHeaders,
    webSearch: modelOverrideProperties.webSearch,
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
        not: { anyOf: ['models', 'model', 'baseUrl', 'apiKey', 'requestCompression', 'extraFields', 'extraHeaders', 'webSearch', 'contextLimit', 'effort', 'asyncCompact', 'failureThreshold', 'cooldownMs'].map((field) => ({ required: [field] })) },
      },
    },
    {
      if: effectiveProviderTypeIs('failover'),
      then: {
        required: ['targets'],
        properties: { targets: { minItems: 2 } },
        not: { anyOf: ['models', 'model', 'baseUrl', 'apiKey', 'requestCompression', 'extraFields', 'extraHeaders', 'webSearch', 'contextLimit', 'effort', 'asyncCompact'].map((field) => ({ required: [field] })) },
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

const providerEntry = {
  oneOf: [
    {
      type: 'string',
      pattern: '\\S',
      description: 'Alias shorthand for a single-target session-hash virtual provider.',
    },
    providerObjectEntry,
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
        { enum: ['telegram', 'matrix', 'wework', 'weixin', 'qqbot'] },
        { type: 'string' },
      ],
      description: 'Known managed channel type or a custom channel type.',
    },
    enabled: { type: 'boolean' },
    appId: { type: 'string' },
    clientSecret: { type: 'string' },
    requireMention: { type: 'boolean', description: 'Require @mention in QQ groups; defaults to true.' },
    groupContextLimit: { type: 'integer', minimum: 0, maximum: 50, description: 'Prior QQ group messages retained as untrusted context; defaults to 10.' },
    groupBatchWindowMs: {
      anyOf: [
        { const: 0 },
        { type: 'integer', minimum: 250, maximum: 30000 },
      ],
      description: 'Fixed non-sliding ordinary QQ group batch window in milliseconds; defaults to 5000 and 0 disables batching.',
    },
    media: {
      type: 'object',
      additionalProperties: true,
      properties: {
        imageMaxBytes: { type: 'integer', minimum: 1, maximum: 20971520, description: 'Safe inline-image threshold; larger images fall back to generic files.' },
        fileMaxBytes: { type: 'integer', minimum: 1, maximum: 209715200, description: 'Bounded inbound/fallback generic-file cap; local QQ sends are additionally capped at 100 MiB.' },
        maxTotalBytes: { type: 'integer', minimum: 1, maximum: 209715200 },
        maxAttachments: { type: 'integer', minimum: 1, maximum: 16 },
      },
    },
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
    nodeProviders: {
      type: 'object',
      propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
      additionalProperties: {
        oneOf: [
          {
            type: 'object', additionalProperties: false, required: ['type', 'command'],
            properties: {
              type: { const: 'executable', description: 'Trusted one-shot executable Node provider adapter.' },
              command: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S(?:.*\\S)?$' },
              args: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 4096 } },
              timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 90 },
            },
          },
          {
            type: 'object', additionalProperties: false,
            required: ['type', 'command', 'image', 'allowedWorktreeRoots'],
            properties: {
              type: { const: 'docker-worktree', description: 'Trusted resident Linux Docker provider for one existing Git worktree.' },
              command: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S(?:.*\\S)?$', description: 'Fixed Docker launcher command, for example docker or sudo.' },
              args: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 4096 }, description: 'Fixed launcher arguments, for example ["-n", "docker"].' },
              image: { type: 'string', minLength: 1, maxLength: 4096 },
              allowedWorktreeRoots: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 4096 } },
              networkModes: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['none', 'bridge'] }, default: ['none'] },
              stateDir: { type: 'string', minLength: 1, maxLength: 4096 },
              memory: { type: 'string', pattern: '^[1-9]\\d*[kKmMgG]$', default: '2g' },
              cpus: { type: 'number', exclusiveMinimum: 0, maximum: 64, default: 2 },
              pidsLimit: { type: 'integer', minimum: 16, maximum: 65536, default: 256 },
              tmpfsSize: { type: 'string', pattern: '^[1-9]\\d*[kKmMgG]$', default: '256m' },
            },
          },
        ],
      },
      description: 'Startup-only trusted Node providers. Requires restart.',
    },
    vector: {
      oneOf: [
        { const: false },
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            baseUrl: { type: 'string', pattern: '^https?://' },
          },
        },
      ],
      description: 'Optional semantic vector search. Omission or false disables it; an object enables it unless enabled is false and requires an OpenAI-compatible API base URL such as http://host:port/v1. Requires restart.',
    },
    sessionWorkers: {
      oneOf: [
        { type: 'boolean' },
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            idleSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
          },
        },
      ],
      description: 'Optional per-session process mode. Supplying an object enables it unless enabled is false. Requires restart.',
    },
    dbWorkers: {
      type: 'boolean',
      description: 'Run the LanceDB/vector owner in a child process. Defaults to true and requires restart.',
    },
    vectorMaintenance: {
      oneOf: [
        { type: 'boolean' },
        {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            retentionHours: { type: 'integer', minimum: 1 },
          },
        },
      ],
      description: 'Automatic LanceDB maintenance. Use true/false for default retention or an object to tune retentionHours. Requires restart.',
    },
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
        ollamaBaseUrl: { type: 'string', description: 'Legacy vector endpoint root. Prefer top-level vector.baseUrl.' },
        contextLimit: { type: 'integer', minimum: 1 },
        compactKeepPercent: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.3 },
        compactThresholdPercent: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.85 },
        compactBlockLevelMinTokens: { type: 'integer', minimum: 1 },
        compactBlockLevelForceTokens: { type: 'integer', minimum: 1 },
        compactBlockCandidateFraction: { type: 'number', minimum: 0, maximum: 1 },
        compactBlockForceCompactFraction: { type: 'number', minimum: 0, maximum: 1 },
        compactMessageForceCompactFraction: { type: 'number', minimum: 0, maximum: 1 },
        maxOutput: { type: 'integer', minimum: 1, default: 32768, description: 'Maximum provider output tokens. Defaults to 32768.' },
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
