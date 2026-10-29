export const CONCRETE_PROVIDER_TYPES = [
  'openai-completions',
  'openai-responses',
  'openai-ws',
  'openai',
  'anthropic',
] as const

export const VIRTUAL_PROVIDER_TYPES = [
  'session-hash',
  'failover',
] as const

export const KNOWN_PROVIDER_TYPES = [
  ...CONCRETE_PROVIDER_TYPES,
  ...VIRTUAL_PROVIDER_TYPES,
] as const

export type ConcreteProviderType = typeof CONCRETE_PROVIDER_TYPES[number]

export function isConcreteProviderType(value: unknown): value is ConcreteProviderType {
  return typeof value === 'string' && (CONCRETE_PROVIDER_TYPES as readonly string[]).includes(value)
}

const knownProviderType = {
  anyOf: [
    { enum: KNOWN_PROVIDER_TYPES },
    { const: '' },
  ],
  description: 'Provider protocol or virtual routing strategy. Omit or leave empty to use the OpenAI protocol.',
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

const openaiImageGenerationOptions = {
  type: 'object',
  additionalProperties: true,
  description: 'Opt-in OpenAI Responses hosted image generation settings. Ignored by non-Responses providers.',
  properties: {
    enabled: { type: 'boolean', description: 'Enable the hosted image_generation tool for eligible Responses requests.' },
    model: { type: 'string', minLength: 1, description: 'Optional hosted image model override. Omitted uses the provider default.' },
    action: { enum: ['auto', 'generate', 'edit'], description: 'Hosted image action. Defaults to auto.' },
    size: { type: 'string', minLength: 1, description: 'Requested output size for the hosted image model.' },
    quality: { enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Requested output quality.' },
    background: { enum: ['auto', 'opaque', 'transparent'], description: 'Requested output background.' },
    outputFormat: { enum: ['png', 'jpeg', 'webp'], description: 'Requested output image format.' },
    outputCompression: { type: 'integer', minimum: 0, maximum: 100, description: 'Output compression percentage where the provider supports it.' },
  },
}

const openaiImageGenerationConfig = {
  oneOf: [
    { type: 'boolean' },
    openaiImageGenerationOptions,
  ],
  description: 'Opt-in OpenAI Responses hosted image generation settings. Use true/false for defaults or an object for tuning. Ignored by non-Responses providers.',
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

const modelDefaultProperties = {
  contextLimit: { ...positiveInteger, description: 'Context limit in tokens.' },
  maxOutput: { ...positiveInteger, description: 'Maximum output tokens requested from the provider. Provider-specific extraFields may override this value.' },
  providerImageOutputFormat: { enum: ['webp', 'jpeg'], description: 'Format used for optimized input images: webp, or jpeg with PNG for transparent images.' },
}

const pricing = {
  type: 'object',
  required: ['cached', 'input', 'output'],
  additionalProperties: false,
  description: 'Estimated USD prices per million tokens. Set all three rates on each model object, or on a concrete provider with no models. Saved usage costs are not recalculated after prices change.',
  properties: {
    cached: { type: 'number', minimum: 0, description: 'USD per million cached input tokens.' },
    input: { type: 'number', minimum: 0, description: 'USD per million uncached input tokens.' },
    output: { type: 'number', minimum: 0, description: 'USD per million output tokens, including reasoning.' },
  },
}

const modelOverrideProperties = {
  ...modelDefaultProperties,
  pricing,
  asyncCompact: { type: 'boolean', description: 'Whether background compaction may use this provider or model. Model entries override the provider default.' },
  disallowEmptyResponse: { type: 'boolean', description: 'Treat a completed response with no content and no tool calls as a retryable failure. Default false accepts it as a normal turn end. Model entries override the provider default.' },
  streamContentInactivityTimeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647, default: 60000, description: 'Streaming output inactivity timeout in milliseconds. Model overrides provider; default 60000. First-output timeout and explicit caller deadline remain independent. Safety buffering uses at least 600000.' },
  effort: modelEffortConfig,
  historyReasoningField: {
    enum: ['reasoning_content', 'reasoning'],
    description: 'Assistant-history reasoning field used by this Chat Completions provider/model. Defaults to reasoning_content.',
  },
  keepReasoningOnError: { type: 'boolean', description: 'Override the provider default for retaining completed encrypted reasoning after a failed normal Responses stream. False disables retention; this does not resume provider execution.' },
  extraFields: { type: 'object', additionalProperties: true, description: 'Provider-specific request fields.' },
  extraHeaders: { type: 'object', additionalProperties: true, description: 'Provider-specific HTTP headers. Values are passed through to the canonical backend loader.' },
  webSearch: openaiWebSearchConfig,
  imageGeneration: openaiImageGenerationConfig,
}

const modelItem = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['id'],
      not: { required: ['sameProviderAs'] },
      additionalProperties: true,
      properties: {
        id: { type: 'string', minLength: 1, description: 'Internal model identifier used for selection and history attribution.' },
        upstreamModelId: { type: 'string', pattern: '\\S', description: 'Optional model identifier sent to the upstream provider. Omitted uses id; internal selection and history keep id.' },
        sameModelAs: { type: 'string', pattern: '\\S', description: 'Compatible native history model: a whole local model ID or provider/model key. Takes precedence over sameProviderAs; keeps model settings and attribution separate.' },
        ...modelOverrideProperties,
      },
    },
  ],
}

const modelListContainsHistoryReasoningField = {
  type: 'array',
  contains: {
    type: 'object',
    required: ['historyReasoningField'],
  },
}

const providerObjectEntry = {
  type: 'object',
  additionalProperties: true,
  not: { anyOf: ['upstreamModelId', 'sameModelAs'].map((field) => ({ required: [field] })) },
  properties: {
    providerType: knownProviderType,
    provider: { ...knownProviderType, deprecated: true, description: 'Legacy spelling for providerType. Prefer providerType.' },
    baseUrl: { type: 'string', description: 'Provider API base URL.' },
    apiKey: { type: 'string', description: 'Provider credential. Keep this file private.' },
    sameProviderAs: { type: 'string', pattern: '\\S', description: 'Concrete provider whose same internal model IDs have compatible native history. Does not inherit connection settings, tools or prices.' },
    models: { type: 'array', items: modelItem, description: 'Preferred provider model list.' },
    model: {
      deprecated: true,
      description: 'Legacy spelling for models. Prefer models.',
      anyOf: [
        { type: 'string' },
        { type: 'array', items: modelItem },
      ],
    },
    ...modelDefaultProperties,
    pricing,
    streamContentInactivityTimeoutMs: modelOverrideProperties.streamContentInactivityTimeoutMs,
    effort: modelEffortConfig,
    historyReasoningField: modelOverrideProperties.historyReasoningField,
    asyncCompact: modelOverrideProperties.asyncCompact,
    requestCompression: { enum: ['gzip', 'br'], description: 'Optional request-body compression.' },
    disallowEmptyResponse: modelOverrideProperties.disallowEmptyResponse,
    keepReasoningOnError: { type: 'boolean', default: false, description: 'Provider default for retaining completed encrypted reasoning after a failed normal Responses stream. Model entries may override it; this does not resume provider execution.' },
    extraFields: modelOverrideProperties.extraFields,
    extraHeaders: modelOverrideProperties.extraHeaders,
    webSearch: modelOverrideProperties.webSearch,
    imageGeneration: modelOverrideProperties.imageGeneration,
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
        not: { anyOf: ['models', 'model', 'baseUrl', 'apiKey', 'requestCompression', 'extraFields', 'extraHeaders', 'webSearch', 'imageGeneration', 'contextLimit', 'maxOutput', 'providerImageOutputFormat', 'pricing', 'streamContentInactivityTimeoutMs', 'effort', 'historyReasoningField', 'asyncCompact', 'disallowEmptyResponse', 'keepReasoningOnError', 'sameProviderAs', 'failureThreshold', 'cooldownMs'].map((field) => ({ required: [field] })) },
      },
    },
    {
      if: effectiveProviderTypeIs('failover'),
      then: {
        required: ['targets'],
        properties: { targets: { minItems: 2 } },
        not: { anyOf: ['models', 'model', 'baseUrl', 'apiKey', 'requestCompression', 'extraFields', 'extraHeaders', 'webSearch', 'imageGeneration', 'contextLimit', 'maxOutput', 'providerImageOutputFormat', 'pricing', 'streamContentInactivityTimeoutMs', 'effort', 'historyReasoningField', 'asyncCompact', 'disallowEmptyResponse', 'keepReasoningOnError', 'sameProviderAs'].map((field) => ({ required: [field] })) },
      },
    },
    {
      if: { not: { anyOf: [effectiveProviderTypeIs('session-hash'), effectiveProviderTypeIs('failover')] } },
      then: {
        not: { anyOf: ['targets', 'failureThreshold', 'cooldownMs'].map((field) => ({ required: [field] })) },
      },
    },
    {
      if: { not: effectiveProviderTypeIs('openai-completions') },
      then: {
        not: {
          anyOf: [
            { required: ['historyReasoningField'] },
            { required: ['models'], properties: { models: modelListContainsHistoryReasoningField } },
            { required: ['model'], properties: { model: modelListContainsHistoryReasoningField } },
          ],
        },
      },
    },
    {
      if: {
        anyOf: [
          { required: ['models'], properties: { models: { type: 'array', minItems: 1 } } },
          { required: ['model'], properties: { model: { anyOf: [{ type: 'array', minItems: 1 }, { type: 'string', minLength: 1 }] } } },
        ],
      },
      then: { not: { required: ['pricing'] } },
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
    defaults: {
      type: 'object',
      additionalProperties: false,
      description: 'Default model settings. Concrete providers and model entries may override these values.',
      properties: modelDefaultProperties,
    },
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

const channelCommonProperties = {
  type: {
    anyOf: [
      { enum: ['telegram', 'matrix', 'wework', 'weixin', 'qqbot'] },
      { type: 'string' },
    ],
    description: 'Known managed channel type or a custom channel type.',
  },
  enabled: { type: 'boolean' },
  channelProgress: {
    oneOf: [
      { const: false },
      {
        type: 'object',
        additionalProperties: false,
        required: ['intervalMs'],
        properties: {
          intervalMs: { type: 'integer', minimum: 30000, maximum: 1800000 },
        },
      },
    ],
    description: 'Best-effort ordinary-text tool progress. Omission or false disables it.',
  },
  allowedUsers: { type: 'array', items: { type: 'string' } },
  guestAgent,
}

const channelPropertiesByType = {
  telegram: {
    botToken: { type: 'string' },
    mainAttachUser: { type: 'string' },
  },
  matrix: {
    homeserver: { type: 'string' },
    accessToken: { type: 'string' },
    botUserId: { type: 'string' },
  },
  wework: {
    webhookUrl: { type: 'string' },
    token: { type: 'string' },
    encodingAESKey: { type: 'string' },
    listenPort: { type: 'integer', minimum: 1, maximum: 65535 },
    listenPath: { type: 'string' },
    selfName: { type: 'string' },
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
  weixin: {
    baseUrl: { type: 'string' },
    token: { type: 'string' },
    routeTag: { type: 'string' },
    allowAllUsers: { type: 'boolean' },
    longPollTimeoutMs: { type: 'integer', minimum: 1 },
    loginBotType: { type: 'string' },
  },
  qqbot: {
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
    allowAllUsers: { type: 'boolean' },
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
  },
} as const

type KnownChannelType = keyof typeof channelPropertiesByType

const channelTypeCondition = (channelType: KnownChannelType) => ({
  required: ['type'],
  properties: {
    type: { type: 'string', pattern: `^\\s*${channelType}\\s*$` },
  },
})

const channelEntry = {
  type: 'object',
  additionalProperties: true,
  properties: channelCommonProperties,
  allOf: (Object.keys(channelPropertiesByType) as KnownChannelType[]).map((channelType) => ({
    if: channelTypeCondition(channelType),
    then: { properties: channelPropertiesByType[channelType] },
  })),
}

const channelEntryWithKeyFallback = (channelType: KnownChannelType) => ({
  ...channelEntry,
  allOf: [
    ...channelEntry.allOf,
    {
      if: {
        anyOf: [
          { not: { required: ['type'] } },
          { required: ['type'], properties: { type: { type: 'string', pattern: '^\\s*$' } } },
        ],
      },
      then: { properties: channelPropertiesByType[channelType] },
    },
  ],
})

export const APP_CONFIG_SCHEMA = {
  $id: 'https://foxwarm.dev/schemas/app-config.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Foxwarm application configuration',
  type: 'object',
  additionalProperties: true,
  properties: {
    url: { type: 'string', pattern: '^https?://', description: 'Public HTTP(S) base URL used in Node setup instructions. May include a deployment path; requires restart.' },
    access: {
      type: 'object',
      additionalProperties: false,
      properties: {
        identities: {
          type: 'object',
          maxProperties: 64,
          propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            required: ['token', 'surfaces'],
            properties: {
              token: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[A-Za-z0-9._~+/-]+={0,2}$' },
              surfaces: {
                type: 'object',
                additionalProperties: false,
                minProperties: 1,
                properties: {
                  webui: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['sessions'],
                    properties: {
                      sessions: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 512 } },
                    },
                  },
                  mcp: { type: 'object', additionalProperties: false, maxProperties: 0 },
                },
              },
            },
          },
        },
      },
      description: 'Startup-only shared WebUI and inbound MCP identities. Declare each surface explicitly and restart after changes.',
    },
    agentTree: {
      type: 'object', additionalProperties: false,
      properties: {
        maxDepth: { type: 'integer', minimum: 0, maximum: 2147483647, default: 16 },
        maxChildren: { type: 'integer', minimum: 0, maximum: 2147483647, default: 128 },
      },
      description: 'Admission limits for Agent creator trees. Roots have depth zero; children are counted directly.',
    },
    nodeTree: {
      type: 'object', additionalProperties: false,
      properties: {
        maxDepth: { type: 'integer', minimum: 0, maximum: 2147483647, default: 16 },
        maxChildren: { type: 'integer', minimum: 0, maximum: 2147483647, default: 256 },
      },
      description: 'Admission limits for Node authorization forests. Roots have depth zero; children are counted directly.',
    },
    nodeProviders: {
      type: 'object',
      propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['type', 'command'],
        properties: {
          type: { const: 'executable', description: 'Trusted one-shot executable Node provider adapter.' },
          command: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S(?:.*\\S)?$' },
          args: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 4096 } },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 90 },
          parentNode: { type: 'string', pattern: '^(?:[A-Za-z0-9._:-]{1,128}|[A-Za-z0-9][A-Za-z0-9._:-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$' },
        },
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
            lexicalIndex: { type: 'boolean', default: false },
            hybridSearch: { type: 'boolean', default: false },
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
    handoffConfirmation: {
      type: 'boolean',
      default: false,
      description: 'Require structured handoff recall and confirmation for send_to_session and create_child_session. Defaults to false and requires restart.',
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
        contextLimit: { ...modelDefaultProperties.contextLimit, deprecated: true, description: 'Legacy fallback. Prefer defaults in models.yaml.' },
        compactKeepPercent: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.3 },
        compactThresholdPercent: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.85 },
        compactBlockLevelMinTokens: { type: 'integer', minimum: 1 },
        compactBlockLevelForceTokens: { type: 'integer', minimum: 1 },
        compactBlockCandidateFraction: { type: 'number', minimum: 0, maximum: 1 },
        compactBlockForceCompactFraction: { type: 'number', minimum: 0, maximum: 1 },
        compactMessageForceCompactFraction: { type: 'number', minimum: 0, maximum: 1 },
        maxOutput: { ...modelDefaultProperties.maxOutput, default: 32768, deprecated: true, description: 'Legacy fallback. Prefer defaults in models.yaml.' },
        providerImageOutputFormat: { ...modelDefaultProperties.providerImageOutputFormat, default: 'webp', deprecated: true, description: 'Legacy fallback. Prefer defaults in models.yaml.' },
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
      patternProperties: Object.fromEntries(
        (Object.keys(channelPropertiesByType) as KnownChannelType[]).map((channelType) => [
          `^${channelType}$`,
          channelEntryWithKeyFallback(channelType),
        ]),
      ),
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
