/**
 * Centralized configuration constants
 */
import path from 'path';
import crypto from 'crypto';
import fs from 'fs-extra';
import yaml from 'js-yaml';

export type TelegramConfig = {
  enabled?: boolean;
  botToken?: string;
  allowedUsers?: string[];
  mainAttachUser?: string;
  guestAgent?: GuestAgentConfig;
};

export type MatrixConfig = {
  enabled?: boolean;
  homeserver?: string;
  accessToken?: string;
  botUserId?: string;
  allowedUsers?: string[];
  guestAgent?: GuestAgentConfig;
};

export type WeWorkConfig = {
  enabled?: boolean;
  webhookUrl?: string;
  token?: string;
  encodingAESKey?: string;
  listenPort?: number;
  listenPath?: string;
  selfName?: string;
  aibot?: {
    stream?: boolean;
    streamMaxContentBytes?: number;
    websocket?: {
      enabled?: boolean;
      botId?: string;
      secret?: string;
      url?: string;
      heartbeatMs?: number;
      reconnectMs?: number;
    };
  };
  allowedUsers?: string[];
  guestAgent?: GuestAgentConfig;
};

export type WeixinConfig = {
  enabled?: boolean;
  baseUrl?: string;
  token?: string;
  routeTag?: string;
  allowedUsers?: string[];
  allowAllUsers?: boolean;
  longPollTimeoutMs?: number;
  loginBotType?: string;
  guestAgent?: GuestAgentConfig;
};


export type GuestAgentConfig = {
  agentId: string;
  mode?: 'single' | 'inherited';
  isolated?: boolean;
  node?: string;
};

export type GenericChannelConfig = Record<string, any> & {
  type?: string;
  enabled?: boolean;
  allowedUsers?: string[];
  guestAgent?: GuestAgentConfig;
};

export type AnyChannelConfig = TelegramConfig | MatrixConfig | WeWorkConfig | WeixinConfig | GenericChannelConfig;

export type NormalizedChannelConfig<T extends AnyChannelConfig = AnyChannelConfig> = {
  id: string;
  type: string;
  config: T;
};

export type AsrServiceConfig = {
  enabled?: boolean;
  url?: string;
  key?: string;
};

export type AppConfig = {
  bot?: {
    name?: string;
    enableWebUI?: boolean;
    enableTrigger?: boolean;
    httpPort?: number;
    enableTUI?: boolean;
  };
  llm?: {
    ollamaBaseUrl?: string;
    contextLimit?: number;
    compactPercent?: number;
    compactBlockLevelMinTokens?: number;
    compactBlockLevelForceTokens?: number;
    compactBlockCandidateFraction?: number;
    compactBlockForceCompactFraction?: number;
    compactMessageForceCompactFraction?: number;
    maxOutput?: number;
    thinkingBudget?: number;
    openaiBaseUrl?: string;
    openaiApiKey?: string;
    anthropicBaseUrl?: string;
    anthropicApiKey?: string;
  };
  paths?: {
    agentsDir?: string;
    skillsDir?: string;
    mcpConfigPath?: string;
  };
  channels?: Record<string, AnyChannelConfig>;
  asrService?: AsrServiceConfig;
};

// Base directories
export const BASE_DIR = path.join(__dirname, '..');

function expandUserPath(value: string): string {
  if (value === '~') {
    return process.env.HOME || value;
  }

  if (value.startsWith('~/')) {
    const home = process.env.HOME;
    if (home) {
      return path.join(home, value.slice(2));
    }
  }

  return value;
}

function resolveBaseRelativePath(value: string): string {
  const expanded = expandUserPath(value.trim());
  return path.isAbsolute(expanded) ? expanded : path.resolve(BASE_DIR, expanded);
}

const DATA_DIR_FILE = path.join(BASE_DIR, 'data_dir');

function resolveDataRootDir(): string {
  const envValue = process.env.FOXWARM_DATA_DIR?.trim();
  if (envValue) {
    return resolveBaseRelativePath(envValue);
  }

  if (fs.existsSync(DATA_DIR_FILE)) {
    const fileValue = fs.readFileSync(DATA_DIR_FILE, 'utf8').trim();
    if (fileValue) {
      return resolveBaseRelativePath(fileValue);
    }
  }

  return BASE_DIR;
}

export const DATA_ROOT_DIR = resolveDataRootDir();
export const STATE_DIR = path.join(DATA_ROOT_DIR, 'state');
export const ARCHIVE_DB_PATH = path.join(STATE_DIR, 'archive-store.sqlite');
export const SESSION_ID_RESERVATIONS_LOG_PATH = path.join(STATE_DIR, 'session-id-reservations.jsonl');
export const SESSION_ID_MOVE_JOURNAL_PATH = path.join(STATE_DIR, 'session-id-move-pending.json');

const CONFIG_PATH_ENV = process.env.FOXWARM_CONFIG_PATH || process.env.CONFIG_PATH;
export const APP_CONFIG_PATH = CONFIG_PATH_ENV
  ? path.resolve(BASE_DIR, CONFIG_PATH_ENV)
  : path.join(STATE_DIR, 'config.yaml');

function cleanupUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cleanupUndefinedDeep(item)).filter(item => item !== undefined) as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [key, nested] of Object.entries(value as Record<string, any>)) {
      const cleaned = cleanupUndefinedDeep(nested);
      if (cleaned !== undefined) {
        if (typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
          continue;
        }
        result[key] = cleaned;
      }
    }
    return result as T;
  }

  return value;
}

export function readAppConfigFile(): AppConfig {

  if (!fs.existsSync(APP_CONFIG_PATH)) {
    return {};
  }

  const parsed = yaml.load(fs.readFileSync(APP_CONFIG_PATH, 'utf8')) as AppConfig | undefined;
  return parsed || {};
}

function loadAppConfig(): AppConfig {
  return readAppConfigFile();
}

export function writeAppConfigFile(config: AppConfig): void {
  fs.ensureDirSync(path.dirname(APP_CONFIG_PATH));
  fs.writeFileSync(
    APP_CONFIG_PATH,
    yaml.dump(cleanupUndefinedDeep(config), { noRefs: true, lineWidth: 120 }),
    'utf8'
  );
}

export function getNormalizedChannelConfigs(config: AppConfig = APP_CONFIG): NormalizedChannelConfig[] {
  const entries = Object.entries(config.channels || {});
  return entries.flatMap(([id, rawValue]) => {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      return [];
    }

    const rawType = typeof (rawValue as GenericChannelConfig).type === 'string'
      ? (rawValue as GenericChannelConfig).type!.trim()
      : '';
    const type = rawType || id;
    return [{
      id,
      type,
      config: rawValue as AnyChannelConfig,
    }];
  });
}

export function getChannelConfigById(channelId: string, config: AppConfig = APP_CONFIG): NormalizedChannelConfig | undefined {
  return getNormalizedChannelConfigs(config).find(entry => entry.id === channelId);
}

export function getChannelConfigsByType(type: string, config: AppConfig = APP_CONFIG): NormalizedChannelConfig[] {
  return getNormalizedChannelConfigs(config).filter(entry => entry.type === type);
}

export function getDefaultChannelConfigByType<T extends AnyChannelConfig = AnyChannelConfig>(type: string, config: AppConfig = APP_CONFIG): NormalizedChannelConfig<T> | undefined {
  const entries = getChannelConfigsByType(type, config) as NormalizedChannelConfig<T>[];
  return entries.find(entry => entry.id === type) || entries[0];
}

export function getDefaultChannelIdByType(type: string, config: AppConfig = APP_CONFIG): string {
  return getDefaultChannelConfigByType(type, config)?.id || type;
}

function resolvePathValue(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return resolveBaseRelativePath(value);
}

export const APP_CONFIG = loadAppConfig();
export const BOT_NAME = APP_CONFIG.bot?.name || 'foxwarm';
export const ENABLE_TUI = APP_CONFIG.bot?.enableTUI === true || process.argv.includes('--tui');
export const TELEGRAM_CONFIG: TelegramConfig = (getDefaultChannelConfigByType<TelegramConfig>('telegram', APP_CONFIG)?.config || {}) as TelegramConfig;
export const MATRIX_CONFIG: MatrixConfig = (getDefaultChannelConfigByType<MatrixConfig>('matrix', APP_CONFIG)?.config || {}) as MatrixConfig;
export const WEWORK_CONFIG: WeWorkConfig = (getDefaultChannelConfigByType<WeWorkConfig>('wework', APP_CONFIG)?.config || {}) as WeWorkConfig;
export const WEIXIN_CONFIG: WeixinConfig = (getDefaultChannelConfigByType<WeixinConfig>('weixin', APP_CONFIG)?.config || {}) as WeixinConfig;
export const ASR_SERVICE_CONFIG: AsrServiceConfig = APP_CONFIG.asrService || {};
export const OLLAMA_BASE_URL = APP_CONFIG.llm?.ollamaBaseUrl || 'http://localhost:11434';

export const AGENTS_DIR = resolvePathValue(APP_CONFIG.paths?.agentsDir, path.join(DATA_ROOT_DIR, 'agents'));
export const SKILLS_DIR = resolvePathValue(APP_CONFIG.paths?.skillsDir, path.join(BASE_DIR, 'skills'));
export const WORKSPACE_DIR = AGENTS_DIR; // Legacy alias for agent-folder

// State subdirectories
export const LOGS_DIR = path.join(STATE_DIR, 'logs');
export const SESSION_LOGS_DIR = path.join(LOGS_DIR, 'sessions');
export const DB_DIR = path.join(STATE_DIR, 'db');
export const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
export const SESSIONS_BLOB_DIR = path.join(STATE_DIR, 'sessions-blob');
export const IMAGE_BLOBS_DIR = path.join(STATE_DIR, 'image-blobs');
export const AGENTS_SYSTEM_PROMPT_PATH = path.join(AGENTS_DIR, '00_SYSTEM.md');
export const AGENTS_SYSTEM_PROMPT_TEMPLATE_PATH = path.join(BASE_DIR, 'templates', 'agents', '00_SYSTEM.md');
export const MAIN_AGENT_DIR = path.join(AGENTS_DIR, 'main');
export const MAIN_AGENT_MEMORY_DIR = path.join(MAIN_AGENT_DIR, 'memory');

// Files
export const TOKEN_FILE = path.join(STATE_DIR, 'token');
export const NODE_TOKEN_FILE = path.join(STATE_DIR, 'node_token');
export const NODES_FILE = path.join(STATE_DIR, 'nodes.json');
export const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
export const AGENTS_FILE = path.join(STATE_DIR, 'agents.json');
export const CHANNELS_FILE = path.join(STATE_DIR, 'channels.json');
export const TIMERS_FILE = path.join(STATE_DIR, 'timers.json');
export const ONBOOT_FILE = path.join(MAIN_AGENT_MEMORY_DIR, 'ONBOOT.md');
export const MCP_CONFIG_PATH = resolvePathValue(process.env.MCP_CONFIG_PATH || APP_CONFIG.paths?.mcpConfigPath, path.join(STATE_DIR, 'mcp.json'));

// Helper functions
export function getAgentDir(agentName: string = 'main'): string {
  return path.join(AGENTS_DIR, agentName);
}

export function getAgentMemoryDir(agentName: string = 'main'): string {
  return path.join(getAgentDir(agentName), 'memory');
}

export function getSkillDir(skillName: string): string {
  return path.join(SKILLS_DIR, skillName);
}

export function getSessionArchiveLogPath(sessionId: string): string {
  return path.join(SESSION_LOGS_DIR, `${sessionId}.jsonl`);
}

export function getSessionBlockArchiveLogPath(sessionId: string): string {
  return path.join(SESSION_LOGS_DIR, `${sessionId}.blocks.jsonl`);
}

export function getLegacySessionFrontierPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.frontier.json`);
}

export function getSessionArchiveImagesDir(sessionId: string): string {
  return path.join(SESSIONS_BLOB_DIR, `${sessionId}.images`);
}

// Server configuration
export const HTTP_PORT = APP_CONFIG.bot?.httpPort || 3001;
export const ENABLE_WEBUI = APP_CONFIG.bot?.enableWebUI !== false; // Default: enabled
export const ENABLE_TRIGGER = APP_CONFIG.bot?.enableTrigger !== false; // Default: enabled

// Legacy support
export const TRIGGER_PORT = HTTP_PORT; // For backward compatibility
export const WEBUI_PORT = HTTP_PORT; // For backward compatibility

// Context and compaction settings
export const CONTEXT_LIMIT = APP_CONFIG.llm?.contextLimit || 122880; // 120K tokens
export const COMPACT_PERCENT = APP_CONFIG.llm?.compactPercent || 0.3;
export const COMPACT_BLOCK_LEVEL_MIN_TOKENS = APP_CONFIG.llm?.compactBlockLevelMinTokens ?? 3000;
export const COMPACT_BLOCK_LEVEL_FORCE_TOKENS = APP_CONFIG.llm?.compactBlockLevelForceTokens ?? 5000;
export const COMPACT_BLOCK_CANDIDATE_FRACTION = APP_CONFIG.llm?.compactBlockCandidateFraction ?? 0.4;
export const COMPACT_BLOCK_FORCE_COMPACT_FRACTION = APP_CONFIG.llm?.compactBlockForceCompactFraction ?? 0.2;
export const COMPACT_MESSAGE_FORCE_COMPACT_FRACTION = APP_CONFIG.llm?.compactMessageForceCompactFraction ?? 0.2;

// TODO: move to models config
export const MAX_OUTPUT = APP_CONFIG.llm?.maxOutput || 16384;
export const THINKING_BUDGET = APP_CONFIG.llm?.thinkingBudget || 10000;

// Models configuration
export function resolveDataModelsConfigPath(dataRoot: string = DATA_ROOT_DIR): string {
  return path.join(dataRoot, 'state', 'models.yaml');
}

export const DEFAULT_MODELS_CONFIG_PATH = resolveDataModelsConfigPath();
export const MODELS_CONFIG_TEMPLATE_PATH = path.join(BASE_DIR, 'templates', 'models.example.yaml');

export type ModelConfigOverride = {
  contextLimit?: number;
  extraFields?: Record<string, any>;
  extraHeaders?: Record<string, any>;
};

export type ProviderModelListItem = string | ({ id: string } & ModelConfigOverride);

export type ProviderConfigEntry = {
  providerType?: string;
  provider?: string; // legacy alias
  models?: ProviderModelListItem[];
  model?: string | string[] | ProviderModelListItem[]; // legacy alias
  baseUrl?: string;
  apiKey?: string;
  contextLimit?: number;
  asyncCompact?: boolean;
  requestCompression?: 'gzip' | 'br';
  extraFields?: Record<string, any>;
  extraHeaders?: Record<string, any>;
  targets?: string[];
  failureThreshold?: number;
  cooldownMs?: number;
};

export type VirtualProviderType = 'session-hash' | 'failover';

export type VirtualModelRoutingConfig = {
  strategy: VirtualProviderType;
  targets: string[];
  failureThreshold: number;
  cooldownMs: number;
  fingerprint: string;
};

export type ModelConfigEntry = {
  providerKey: string;
  canonicalModelKey?: string;
  providerType?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  contextLimit?: number;
  asyncCompact?: boolean;
  requestCompression?: 'gzip' | 'br';
  extraFields?: Record<string, any>;
  extraHeaders?: Record<string, any>;
  virtualRouting?: VirtualModelRoutingConfig;
};

export type ModelsConfig = {
  default: string;
  models: Record<string, ModelConfigEntry>;
  displayModels: string[];
};

let warnedTemplateModelsFallback = false;

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneConfigValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function stableSerializeConfigValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerializeConfigValue(item)).join(',')}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerializeConfigValue((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function hashConfigValue(value: unknown): string {
  return crypto.createHash('sha256').update(stableSerializeConfigValue(value)).digest('hex');
}

function deepMergeObjects<T extends Record<string, any> | undefined>(base: T, override: T): T {
  if (!isPlainObject(base)) {
    return (isPlainObject(override) ? cloneConfigValue(override) : override) as T;
  }
  if (!isPlainObject(override)) {
    return cloneConfigValue(base) as T;
  }

  const result: Record<string, any> = cloneConfigValue(base);
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMergeObjects(baseValue, overrideValue);
    } else {
      result[key] = cloneConfigValue(overrideValue);
    }
  }

  return result as T;
}

function getProviderType(providerEntry: ProviderConfigEntry): string {
  return providerEntry.providerType || providerEntry.provider || 'openai';
}

export function isVirtualProviderType(providerType: unknown): providerType is VirtualProviderType {
  return providerType === 'session-hash' || providerType === 'failover';
}

export function isVirtualModelConfigEntry(entry: ModelConfigEntry | undefined): entry is ModelConfigEntry & { virtualRouting: VirtualModelRoutingConfig } {
  return !!entry?.virtualRouting && isVirtualProviderType(entry.providerType);
}

function normalizeProviderModelsField(providerKey: string, providerEntry: ProviderConfigEntry): ProviderModelListItem[] | undefined {
  const rawModels = providerEntry.models ?? providerEntry.model;

  if (rawModels === undefined || rawModels === null || rawModels === '') {
    return undefined;
  }

  if (typeof rawModels === 'string') {
    return [rawModels];
  }

  if (!Array.isArray(rawModels)) {
    throw new Error(
      `Provider \`${providerKey}\` has invalid models list: expected an array of model ids or objects with \`id\`; map/object form is not supported.`
    );
  }

  return rawModels.map((item, index) => {
    if (typeof item === 'string') {
      return item;
    }
    if (!isPlainObject(item)) {
      throw new Error(
        `Provider \`${providerKey}\` has invalid models[${index}] entry: expected string or object with \`id\`.`
      );
    }

    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      throw new Error(`Provider \`${providerKey}\` has invalid models[${index}] entry: object form requires a non-empty \`id\`.`);
    }

    return {
      ...item,
      id,
    } as ProviderModelListItem;
  });
}

function applyProviderDefaults(providerEntry: ProviderConfigEntry): ProviderConfigEntry {
  const providerType = getProviderType(providerEntry);

  if (providerType === 'anthropic') {
    return {
      ...providerEntry,
      providerType,
      baseUrl: providerEntry.baseUrl || APP_CONFIG.llm?.anthropicBaseUrl || 'https://api.anthropic.com',
      apiKey: providerEntry.apiKey || APP_CONFIG.llm?.anthropicApiKey,
    };
  }

  if (providerType === 'openai' || providerType === 'openai-responses' || providerType === 'openai-completions') {
    return {
      ...providerEntry,
      providerType,
      baseUrl: providerEntry.baseUrl || APP_CONFIG.llm?.openaiBaseUrl || 'https://api.openai.com/v1',
      apiKey: providerEntry.apiKey || APP_CONFIG.llm?.openaiApiKey,
    };
  }

  return {
    ...providerEntry,
    providerType,
  };
}

function buildResolvedModelEntry(providerKey: string, providerEntry: ProviderConfigEntry, modelId: string, modelOverride?: ModelConfigOverride): ModelConfigEntry {
  const resolvedProviderEntry = applyProviderDefaults(providerEntry);
  return {
    providerKey,
    canonicalModelKey: modelId ? `${providerKey}/${modelId}` : providerKey,
    providerType: resolvedProviderEntry.providerType,
    model: modelId,
    baseUrl: resolvedProviderEntry.baseUrl,
    apiKey: resolvedProviderEntry.apiKey,
    contextLimit: modelOverride?.contextLimit ?? resolvedProviderEntry.contextLimit,
    asyncCompact: resolvedProviderEntry.asyncCompact,
    requestCompression: resolvedProviderEntry.requestCompression,
    extraHeaders: {
      ...(resolvedProviderEntry.extraHeaders || {}),
      ...(modelOverride?.extraHeaders || {}),
    },
    extraFields: deepMergeObjects(
      resolvedProviderEntry.extraFields || {},
      modelOverride?.extraFields || {},
    ) || {},
  };
}

export function expandModelsConfig(rawProviderEntries: Record<string, ProviderConfigEntry>) {
  const models: Record<string, ModelConfigEntry> = {};
  const canonicalConcreteKeyByLookupKey = new Map<string, string>();
  const displayModels: string[] = [];

  const virtualEntries: Array<[string, ProviderConfigEntry, VirtualProviderType]> = [];

  for (const [providerKey, rawProviderEntry] of Object.entries(rawProviderEntries || {})) {
    if (!isPlainObject(rawProviderEntry)) {
      throw new Error(`Provider \`${providerKey}\` must be a plain object.`);
    }
    const providerEntry = rawProviderEntry as ProviderConfigEntry;
    const providerType = getProviderType(providerEntry);
    if (isVirtualProviderType(providerType)) {
      virtualEntries.push([providerKey, providerEntry, providerType]);
      continue;
    }

    for (const field of ['targets', 'failureThreshold', 'cooldownMs'] as const) {
      if (Object.prototype.hasOwnProperty.call(providerEntry, field)) {
        throw new Error(`Concrete provider \`${providerKey}\` (${providerType}) forbids routing field \`${field}\`.`);
      }
    }

    const normalizedModels = normalizeProviderModelsField(providerKey, providerEntry);

    // Allow empty/undefined (some providers has default model)
    if (!normalizedModels || normalizedModels.length === 0) {
      models[providerKey] = buildResolvedModelEntry(providerKey, providerEntry, '');
      canonicalConcreteKeyByLookupKey.set(providerKey, providerKey);
      displayModels.push(providerKey);
      continue;
    }

    if (normalizedModels.length === 1) {
      const onlyModel = normalizedModels[0];
      const modelId = typeof onlyModel === 'string' ? onlyModel : onlyModel.id;
      const modelOverride = typeof onlyModel === 'string' ? undefined : onlyModel;
      const resolvedEntry = buildResolvedModelEntry(providerKey, providerEntry, modelId, modelOverride);
      const qualifiedModelKey = `${providerKey}/${modelId}`;
      models[providerKey] = resolvedEntry;
      models[qualifiedModelKey] = { ...resolvedEntry };
      canonicalConcreteKeyByLookupKey.set(providerKey, qualifiedModelKey);
      canonicalConcreteKeyByLookupKey.set(qualifiedModelKey, qualifiedModelKey);
      displayModels.push(providerKey);
    } else {
      for (const rawModel of normalizedModels) {
        const modelId = typeof rawModel === 'string' ? rawModel : rawModel.id;
        const modelOverride = typeof rawModel === 'string' ? undefined : rawModel;
        const modelKey = `${providerKey}/${modelId}`;
        models[modelKey] = buildResolvedModelEntry(providerKey, providerEntry, modelId, modelOverride);
        canonicalConcreteKeyByLookupKey.set(modelKey, modelKey);
        displayModels.push(modelKey);
      }
    }
  }

  const rawVirtualKeys = new Set(virtualEntries.map(([providerKey]) => providerKey));
  const forbiddenVirtualFields: Array<keyof ProviderConfigEntry> = [
    'models',
    'model',
    'baseUrl',
    'apiKey',
    'requestCompression',
    'extraFields',
    'extraHeaders',
    'contextLimit',
    'asyncCompact',
  ];

  for (const [virtualKey, providerEntry, providerType] of virtualEntries) {
    for (const field of forbiddenVirtualFields) {
      if (Object.prototype.hasOwnProperty.call(providerEntry, field)) {
        throw new Error(`Virtual provider \`${virtualKey}\` (${providerType}) forbids field \`${field}\`.`);
      }
    }

    if (providerType === 'session-hash') {
      for (const field of ['failureThreshold', 'cooldownMs'] as const) {
        if (Object.prototype.hasOwnProperty.call(providerEntry, field)) {
          throw new Error(`Virtual provider \`${virtualKey}\` (session-hash) forbids failover field \`${field}\`.`);
        }
      }
    }

    if (!Array.isArray(providerEntry.targets)) {
      throw new Error(`Virtual provider \`${virtualKey}\` requires a \`targets\` array of concrete model ids.`);
    }

    const minimumTargets = providerType === 'failover' ? 2 : 1;
    if (providerEntry.targets.length < minimumTargets) {
      throw new Error(`Virtual provider \`${virtualKey}\` (${providerType}) requires at least ${minimumTargets} target${minimumTargets === 1 ? '' : 's'}.`);
    }

    const targets: string[] = [];
    const seenCanonicalTargets = new Set<string>();
    const leafEntries: ModelConfigEntry[] = [];
    for (const [index, rawTarget] of providerEntry.targets.entries()) {
      const target = typeof rawTarget === 'string' ? rawTarget.trim() : '';
      if (!target) {
        throw new Error(`Virtual provider \`${virtualKey}\` has an invalid empty targets[${index}] value.`);
      }
      if (target === virtualKey) {
        throw new Error(`Virtual provider \`${virtualKey}\` cannot target itself.`);
      }
      if (rawVirtualKeys.has(target)) {
        throw new Error(`Virtual provider \`${virtualKey}\` target \`${target}\` is virtual; nested virtual routing is not supported.`);
      }

      const targetEntry = models[target];
      if (!targetEntry) {
        throw new Error(`Virtual provider \`${virtualKey}\` has unknown concrete target \`${target}\`.`);
      }
      const canonicalTarget = canonicalConcreteKeyByLookupKey.get(target);
      if (!canonicalTarget || !models[canonicalTarget]) {
        throw new Error(`Virtual provider \`${virtualKey}\` could not canonicalize concrete target \`${target}\`.`);
      }
      if (seenCanonicalTargets.has(canonicalTarget)) {
        throw new Error(`Virtual provider \`${virtualKey}\` has duplicate canonical target \`${canonicalTarget}\`.`);
      }
      seenCanonicalTargets.add(canonicalTarget);
      targets.push(canonicalTarget);
      leafEntries.push(targetEntry);
    }

    const failureThreshold = providerEntry.failureThreshold ?? 5;
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new Error(`Virtual provider \`${virtualKey}\` failureThreshold must be a positive integer.`);
    }
    const cooldownMs = providerEntry.cooldownMs ?? 600_000;
    if (!Number.isInteger(cooldownMs) || cooldownMs < 1) {
      throw new Error(`Virtual provider \`${virtualKey}\` cooldownMs must be a positive integer.`);
    }

    const contextLimit = Math.min(...leafEntries.map(entry => entry.contextLimit || CONTEXT_LIMIT));
    const asyncCompact = leafEntries.every(entry => entry.asyncCompact !== false);
    const fingerprint = hashConfigValue({
      strategy: providerType,
      targets,
      failureThreshold,
      cooldownMs,
      leaves: targets.map((target, index) => {
        const entry = leafEntries[index];
        return {
          target,
          providerType: entry.providerType || 'openai',
          model: entry.model,
          baseUrl: entry.baseUrl || null,
          requestCompression: entry.requestCompression || null,
          contextLimit: entry.contextLimit ?? CONTEXT_LIMIT,
          asyncCompact: entry.asyncCompact !== false,
          apiKeyHash: hashConfigValue(entry.apiKey || ''),
          extraFieldsHash: hashConfigValue(entry.extraFields || {}),
          extraHeadersHash: hashConfigValue(entry.extraHeaders || {}),
        };
      }),
    });

    models[virtualKey] = {
      providerKey: virtualKey,
      canonicalModelKey: virtualKey,
      providerType,
      model: '',
      contextLimit,
      asyncCompact,
      virtualRouting: {
        strategy: providerType,
        targets,
        failureThreshold,
        cooldownMs,
        fingerprint,
      },
    };
    displayModels.push(virtualKey);
  }

  const orderedDisplayModels = Object.keys(rawProviderEntries || {}).flatMap(providerKey =>
    displayModels.filter(modelKey => models[modelKey]?.providerKey === providerKey)
  );
  return { models, displayModels: orderedDisplayModels };
}

export function getActiveModelsConfigPath(): string {
  return DEFAULT_MODELS_CONFIG_PATH;
}

export function getModelsConfigReadPath(
  activePath: string = getActiveModelsConfigPath(),
  templatePath: string = MODELS_CONFIG_TEMPLATE_PATH,
): string {
  if (fs.existsSync(activePath)) {
    return activePath;
  }

  if (fs.existsSync(templatePath)) {
    if (!warnedTemplateModelsFallback) {
      warnedTemplateModelsFallback = true;
      console.warn(
        `[config] state/models.yaml not found; falling back to template models config: ${templatePath}`
      );
    }
    return templatePath;
  }

  return activePath;
}

export function loadModelsConfig(): ModelsConfig {
  const resolvedPath = getModelsConfigReadPath();

  try {
    const rawText = fs.readFileSync(resolvedPath, 'utf8');
    const config = yaml.load(rawText) as any;
    return loadModelsConfigFromObject(config);
  } catch (e) {
    throw new Error(
      `Loading models config (${resolvedPath}) error: ${e}. ` +
      `Create ${getActiveModelsConfigPath()} from ${MODELS_CONFIG_TEMPLATE_PATH}.`
    );
  }
}

export function loadModelsConfigFromObject(config: any): ModelsConfig {
  const rawProviderEntries = config?.providers ?? config?.models;
  if (!isPlainObject(rawProviderEntries)) {
    throw new Error('Expected root `providers` (preferred) or legacy `models` object in models config');
  }

  const expanded = expandModelsConfig(rawProviderEntries);
  const defaultKey = expanded.models[config?.default] ? config.default : (expanded.displayModels[0] || config?.default);
  return { default: defaultKey, models: expanded.models, displayModels: expanded.displayModels };
}

export function resolveModelConfig(sessionModel?: string) {
  const modelsConfig = loadModelsConfig();
  const defaultKey = modelsConfig.default;
  const currentKey = sessionModel && modelsConfig.models[sessionModel] ? sessionModel : defaultKey;
  const modelEntry = modelsConfig.models[currentKey] || modelsConfig.models[defaultKey];
  const contextLimit = modelEntry?.contextLimit || CONTEXT_LIMIT;

  return { modelsConfig, defaultKey, currentKey, modelEntry, contextLimit };
}
