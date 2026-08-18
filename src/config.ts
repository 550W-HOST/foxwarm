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

export type QQBotMediaConfig = {
  /** Safe inline-image threshold; larger images fall back to generic files. */
  imageMaxBytes?: number;
  /** Bounded generic-file cap for inbound/fallback files; local QQ sends are additionally capped at 100 MiB. */
  fileMaxBytes?: number;
  maxTotalBytes?: number;
  maxAttachments?: number;
};

export type QQBotConfig = {
  enabled?: boolean;
  appId?: string;
  clientSecret?: string;
  /** Whether QQ group messages require an @mention before routing. */
  requireMention?: boolean;
  /** Number of prior QQ group messages retained as untrusted context. Defaults to 10. */
  groupContextLimit?: number;
  /** Fixed non-sliding ordinary-group batch window. Defaults to 5000; 0 disables batching. */
  groupBatchWindowMs?: number;
  allowedUsers?: string[];
  allowAllUsers?: boolean;
  guestAgent?: GuestAgentConfig;
  media?: QQBotMediaConfig;
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

export type AnyChannelConfig = TelegramConfig | MatrixConfig | WeWorkConfig | WeixinConfig | QQBotConfig | GenericChannelConfig;

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

export const DEFAULT_SESSION_WORKER_IDLE_SECONDS = 60;
export const MIN_SESSION_WORKER_IDLE_SECONDS = 1;
export const MAX_SESSION_WORKER_IDLE_SECONDS = 86_400;
export const DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS = 24;

export type SessionWorkersConfig = boolean | {
  enabled?: boolean;
  idleSeconds?: number;
};

export type NormalizedSessionWorkersConfig = {
  enabled: boolean;
  idleSeconds: number;
};

export type VectorMaintenanceConfig = {
  enabled?: boolean;
  retentionHours?: number;
} | boolean;

export type NormalizedVectorMaintenanceConfig = {
  enabled: boolean;
  retentionHours: number;
};

export type VectorConfig = false | {
  enabled?: boolean;
  baseUrl?: string;
};

export type NormalizedVectorConfig = {
  enabled: boolean;
  baseUrl?: string;
  source: 'disabled-default' | 'vector' | 'legacy-ollama';
};

function normalizeAbsoluteHttpUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`app config \`${field}\` must be a non-empty absolute http(s) URL.`);
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`app config \`${field}\` must be a non-empty absolute http(s) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error(`app config \`${field}\` must be a non-empty absolute http(s) URL.`);
  }
  return trimmed;
}

export function normalizeVectorConfig(
  vectorValue: unknown,
  legacyOllamaBaseUrl?: unknown,
): NormalizedVectorConfig {
  if (vectorValue === undefined) {
    if (typeof legacyOllamaBaseUrl !== 'string' || legacyOllamaBaseUrl.trim().length === 0) {
      return { enabled: false, source: 'disabled-default' };
    }
    const legacyRoot = normalizeAbsoluteHttpUrl(legacyOllamaBaseUrl, 'llm.ollamaBaseUrl');
    const parsed = new URL(legacyRoot);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (!pathname.endsWith('/v1')) {
      parsed.pathname = `${pathname || ''}/v1`;
    }
    return {
      enabled: true,
      baseUrl: parsed.toString().replace(/\/+$/, ''),
      source: 'legacy-ollama',
    };
  }
  if (vectorValue === false) {
    return { enabled: false, source: 'vector' };
  }
  if (!vectorValue || typeof vectorValue !== 'object' || Array.isArray(vectorValue)) {
    throw new Error('app config `vector` must be false or an object.');
  }
  const raw = vectorValue as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('app config `vector.enabled` must be a boolean.');
  }
  if (raw.enabled === false) {
    return {
      enabled: false,
      ...(raw.baseUrl === undefined ? {} : { baseUrl: normalizeAbsoluteHttpUrl(raw.baseUrl, 'vector.baseUrl') }),
      source: 'vector',
    };
  }
  return {
    enabled: true,
    baseUrl: normalizeAbsoluteHttpUrl(raw.baseUrl, 'vector.baseUrl'),
    source: 'vector',
  };
}

export function normalizeSessionWorkersConfig(value: unknown): NormalizedSessionWorkersConfig {
  if (value === undefined || value === false) {
    return { enabled: false, idleSeconds: DEFAULT_SESSION_WORKER_IDLE_SECONDS };
  }
  if (value === true) {
    return { enabled: true, idleSeconds: DEFAULT_SESSION_WORKER_IDLE_SECONDS };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('app config `sessionWorkers` must be a boolean or object.');
  }

  const raw = value as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('app config `sessionWorkers.enabled` must be a boolean.');
  }
  const rawIdleSeconds = raw.idleSeconds;
  let idleSeconds = DEFAULT_SESSION_WORKER_IDLE_SECONDS;
  if (rawIdleSeconds !== undefined) {
    if (typeof rawIdleSeconds !== 'number') {
      throw new Error('app config `sessionWorkers.idleSeconds` must be a number.');
    }
    idleSeconds = rawIdleSeconds;
  }
  if (!Number.isInteger(idleSeconds)
    || idleSeconds < MIN_SESSION_WORKER_IDLE_SECONDS
    || idleSeconds > MAX_SESSION_WORKER_IDLE_SECONDS) {
    throw new Error(
      `app config \`sessionWorkers.idleSeconds\` must be an integer between ${MIN_SESSION_WORKER_IDLE_SECONDS} and ${MAX_SESSION_WORKER_IDLE_SECONDS}.`,
    );
  }

  return {
    // Supplying an object opts in unless it explicitly disables the worker.
    enabled: raw.enabled !== false,
    idleSeconds,
  };
}

export function normalizeDbWorkersEnabled(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== 'boolean') {
    throw new Error('app config `dbWorkers` must be a boolean.');
  }
  return value;
}

export function normalizeVectorMaintenanceConfig(value: unknown): NormalizedVectorMaintenanceConfig {
  if (value === undefined) {
    return { enabled: true, retentionHours: DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS };
  }
  if (value === false) {
    return { enabled: false, retentionHours: DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS };
  }
  if (value === true) {
    return { enabled: true, retentionHours: DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('app config `vectorMaintenance` must be a boolean or object.');
  }

  const raw = value as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('app config `vectorMaintenance.enabled` must be a boolean.');
  }
  const retentionHours = raw.retentionHours === undefined
    ? DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS
    : raw.retentionHours;
  if (typeof retentionHours !== 'number') {
    throw new Error('app config `vectorMaintenance.retentionHours` must be a number.');
  }
  if (!Number.isInteger(retentionHours) || retentionHours < 1) {
    throw new Error('app config `vectorMaintenance.retentionHours` must be a positive integer.');
  }

  return {
    enabled: raw.enabled !== false,
    retentionHours,
  };
}

export type AppConfig = {
  vector?: VectorConfig;
  sessionWorkers?: SessionWorkersConfig;
  dbWorkers?: boolean;
  vectorMaintenance?: VectorMaintenanceConfig;
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
export const CATALOG_DB_PATH = path.join(STATE_DIR, 'catalog.sqlite');
export const SESSION_RUNTIME_DB_PATH = path.join(STATE_DIR, 'session-runtime.sqlite');
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

export const VECTOR_CONFIG = normalizeVectorConfig(APP_CONFIG.vector, APP_CONFIG.llm?.ollamaBaseUrl);
export const VECTOR_ENABLED = VECTOR_CONFIG.enabled;
export const VECTOR_BASE_URL = VECTOR_CONFIG.baseUrl;
export const SESSION_WORKERS_CONFIG = normalizeSessionWorkersConfig(APP_CONFIG.sessionWorkers);
export const SESSION_WORKERS_ENABLED = SESSION_WORKERS_CONFIG.enabled;
export const SESSION_WORKER_IDLE_SECONDS = SESSION_WORKERS_CONFIG.idleSeconds;
export const DB_WORKERS_ENABLED = normalizeDbWorkersEnabled(APP_CONFIG.dbWorkers);
export const VECTOR_MAINTENANCE_CONFIG = normalizeVectorMaintenanceConfig(APP_CONFIG.vectorMaintenance);
export const BOT_NAME = APP_CONFIG.bot?.name || 'foxwarm';
export const ENABLE_TUI = APP_CONFIG.bot?.enableTUI === true || process.argv.includes('--tui');
export const TELEGRAM_CONFIG: TelegramConfig = (getDefaultChannelConfigByType<TelegramConfig>('telegram', APP_CONFIG)?.config || {}) as TelegramConfig;
export const MATRIX_CONFIG: MatrixConfig = (getDefaultChannelConfigByType<MatrixConfig>('matrix', APP_CONFIG)?.config || {}) as MatrixConfig;
export const WEWORK_CONFIG: WeWorkConfig = (getDefaultChannelConfigByType<WeWorkConfig>('wework', APP_CONFIG)?.config || {}) as WeWorkConfig;
export const WEIXIN_CONFIG: WeixinConfig = (getDefaultChannelConfigByType<WeixinConfig>('weixin', APP_CONFIG)?.config || {}) as WeixinConfig;
export const QQBOT_CONFIG: QQBotConfig = (getDefaultChannelConfigByType<QQBotConfig>('qqbot', APP_CONFIG)?.config || {}) as QQBotConfig;
export const ASR_SERVICE_CONFIG: AsrServiceConfig = APP_CONFIG.asrService || {};

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

// Models configuration
export function resolveDataModelsConfigPath(dataRoot: string = DATA_ROOT_DIR): string {
  return path.join(dataRoot, 'state', 'models.yaml');
}

export const DEFAULT_MODELS_CONFIG_PATH = resolveDataModelsConfigPath();
export const MODELS_CONFIG_TEMPLATE_PATH = path.join(BASE_DIR, 'templates', 'models.example.yaml');

export type OpenAIWebSearchUserLocation = {
  type?: 'approximate';
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
};

export type OpenAIWebSearchOptions = {
  /** Opt in to the hosted Responses API web search tool. */
  enabled?: boolean;
  /** Select automatic or required Responses tool use when search is enabled. */
  toolChoice?: 'auto' | 'required';
  searchContextSize?: 'low' | 'medium' | 'high';
  allowedDomains?: string[];
  userLocation?: OpenAIWebSearchUserLocation;
};

export type OpenAIWebSearchConfig = boolean | OpenAIWebSearchOptions;

export const MODEL_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];
export const DEFAULT_MODEL_EFFORT: ModelEffort = 'high';

export type ModelEffortConfig = {
  allowed?: ModelEffort[];
  default?: ModelEffort;
};

export type NormalizedModelEffortConfig = {
  allowed: ModelEffort[];
  /** Concrete entries always have a default. Virtual entries expose only the derived union. */
  default?: ModelEffort;
};

export type NormalizedOpenAIWebSearchConfig = Omit<OpenAIWebSearchOptions, 'enabled'> & {
  enabled: boolean;
};

export function normalizeOpenAIWebSearchConfig(value: unknown): NormalizedOpenAIWebSearchConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === true || value === false) {
    return { enabled: value };
  }
  if (!isPlainObject(value)) {
    throw new Error('models config `webSearch` must be a boolean or object.');
  }

  const raw = value as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('models config `webSearch.enabled` must be a boolean.');
  }

  const normalized: NormalizedOpenAIWebSearchConfig = {
    enabled: raw.enabled !== false,
  };
  if (raw.toolChoice !== undefined) {
    if (raw.toolChoice !== 'auto' && raw.toolChoice !== 'required') {
      throw new Error('models config `webSearch.toolChoice` must be `auto` or `required`.');
    }
    normalized.toolChoice = raw.toolChoice;
  }
  if (raw.searchContextSize !== undefined) {
    if (raw.searchContextSize !== 'low' && raw.searchContextSize !== 'medium' && raw.searchContextSize !== 'high') {
      throw new Error('models config `webSearch.searchContextSize` must be `low`, `medium`, or `high`.');
    }
    normalized.searchContextSize = raw.searchContextSize;
  }
  if (raw.allowedDomains !== undefined) {
    if (!Array.isArray(raw.allowedDomains)) {
      throw new Error('models config `webSearch.allowedDomains` must be an array of strings.');
    }
    const allowedDomains = raw.allowedDomains.map((domain, index) => {
      if (typeof domain !== 'string' || domain.trim().length === 0) {
        throw new Error(`models config \`webSearch.allowedDomains[${index}]\` must be a non-empty string.`);
      }
      return domain.trim();
    });
    normalized.allowedDomains = allowedDomains;
  }
  if (raw.userLocation !== undefined) {
    if (!isPlainObject(raw.userLocation)) {
      throw new Error('models config `webSearch.userLocation` must be an object.');
    }
    const rawLocation = raw.userLocation as Record<string, unknown>;
    if (rawLocation.type !== undefined && rawLocation.type !== 'approximate') {
      throw new Error('models config `webSearch.userLocation.type` must be `approximate`.');
    }
    const userLocation: OpenAIWebSearchUserLocation = {};
    if (rawLocation.type !== undefined) userLocation.type = 'approximate';
    for (const key of ['country', 'city', 'region', 'timezone'] as const) {
      const locationValue = rawLocation[key];
      if (locationValue !== undefined) {
        if (typeof locationValue !== 'string') {
          throw new Error(`models config \`webSearch.userLocation.${key}\` must be a string.`);
        }
        userLocation[key] = locationValue.trim();
      }
    }
    normalized.userLocation = userLocation;
  }

  return normalized;
}

function mergeOpenAIWebSearchConfig(
  baseValue: OpenAIWebSearchConfig | undefined,
  overrideValue: OpenAIWebSearchConfig | undefined,
): NormalizedOpenAIWebSearchConfig | undefined {
  const base = normalizeOpenAIWebSearchConfig(baseValue);
  if (overrideValue === undefined) {
    return base;
  }
  const override = normalizeOpenAIWebSearchConfig(overrideValue)!;
  return {
    ...(base || {}),
    ...override,
  };
}

export type ModelConfigOverride = {
  contextLimit?: number;
  effort?: ModelEffortConfig;
  extraFields?: Record<string, any>;
  extraHeaders?: Record<string, any>;
  webSearch?: OpenAIWebSearchConfig;
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
  effort?: ModelEffortConfig;
  asyncCompact?: boolean;
  requestCompression?: 'gzip' | 'br';
  extraFields?: Record<string, any>;
  extraHeaders?: Record<string, any>;
  webSearch?: OpenAIWebSearchConfig;
  targets?: string[];
  failureThreshold?: number;
  cooldownMs?: number;
};

export type ProviderConfigValue = ProviderConfigEntry | string;

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
  effort?: NormalizedModelEffortConfig;
  asyncCompact?: boolean;
  requestCompression?: 'gzip' | 'br';
  extraFields?: Record<string, any>;
  extraHeaders?: Record<string, any>;
  webSearch?: NormalizedOpenAIWebSearchConfig;
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

function normalizeEffortValue(value: unknown, label: string): ModelEffort {
  if (typeof value !== 'string' || !MODEL_EFFORTS.includes(value as ModelEffort)) {
    throw new Error(`${label} must be one of: ${MODEL_EFFORTS.join(', ')}.`);
  }
  return value as ModelEffort;
}

function normalizeEffortAllowed(value: unknown, label: string): ModelEffort[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  const allowed = value.map((item, index) => normalizeEffortValue(item, `${label}[${index}]`));
  if (new Set(allowed).size !== allowed.length) {
    throw new Error(`${label} must not contain duplicate values.`);
  }
  const selected = new Set(allowed);
  return MODEL_EFFORTS.filter(effort => selected.has(effort));
}

export function normalizeModelEffortConfig(
  value: unknown,
  inherited?: NormalizedModelEffortConfig,
  label = 'models config `effort`',
): NormalizedModelEffortConfig {
  if (value !== undefined && !isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const raw = (value || {}) as Record<string, unknown>;
  const allowed = raw.allowed === undefined
    ? [...(inherited?.allowed || MODEL_EFFORTS)]
    : normalizeEffortAllowed(raw.allowed, `${label}.allowed`);
  const defaultEffort = raw.default === undefined
    ? (inherited?.default || DEFAULT_MODEL_EFFORT)
    : normalizeEffortValue(raw.default, `${label}.default`);
  if (!allowed.includes(defaultEffort)) {
    throw new Error(`${label}.default \`${defaultEffort}\` must be included in ${label}.allowed.`);
  }
  return { allowed, default: defaultEffort };
}

export function getConcreteModelEffortConfig(entry: Pick<ModelConfigEntry, 'effort'>): Required<NormalizedModelEffortConfig> {
  const normalized = normalizeModelEffortConfig(entry.effort);
  return { allowed: normalized.allowed, default: normalized.default || DEFAULT_MODEL_EFFORT };
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
  const providerEffort = normalizeModelEffortConfig(
    resolvedProviderEntry.effort,
    undefined,
    `Provider \`${providerKey}\` effort`,
  );
  const effort = normalizeModelEffortConfig(
    modelOverride?.effort,
    providerEffort,
    `Model \`${providerKey}/${modelId}\` effort`,
  );
  const webSearch = mergeOpenAIWebSearchConfig(
    resolvedProviderEntry.webSearch,
    modelOverride?.webSearch,
  );
  return {
    providerKey,
    canonicalModelKey: modelId ? `${providerKey}/${modelId}` : providerKey,
    providerType: resolvedProviderEntry.providerType,
    model: modelId,
    baseUrl: resolvedProviderEntry.baseUrl,
    apiKey: resolvedProviderEntry.apiKey,
    contextLimit: modelOverride?.contextLimit ?? resolvedProviderEntry.contextLimit,
    effort,
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
    ...(webSearch && Object.keys(webSearch).length > 0 ? { webSearch } : {}),
  };
}

export function expandModelsConfig(rawProviderEntries: Record<string, ProviderConfigValue>) {
  const models: Record<string, ModelConfigEntry> = {};
  const canonicalConcreteKeyByLookupKey = new Map<string, string>();
  const displayModels: string[] = [];

  const virtualEntries: Array<[string, ProviderConfigEntry, VirtualProviderType]> = [];

  for (const [providerKey, rawProviderEntry] of Object.entries(rawProviderEntries || {})) {
    if (typeof rawProviderEntry === 'string') {
      const target = rawProviderEntry.trim();
      if (!target) {
        throw new Error(`Provider alias \`${providerKey}\` must target a non-empty concrete model key.`);
      }
      virtualEntries.push([providerKey, { providerType: 'session-hash', targets: [target] }, 'session-hash']);
      continue;
    }
    if (!isPlainObject(rawProviderEntry)) {
      throw new Error(`Provider \`${providerKey}\` must be a plain object or non-empty alias string.`);
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
    'effort',
    'asyncCompact',
    'webSearch',
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
    const allowedEffortSet = new Set<ModelEffort>();
    for (const entry of leafEntries) {
      for (const effort of getConcreteModelEffortConfig(entry).allowed) allowedEffortSet.add(effort);
    }
    const allowedEfforts = MODEL_EFFORTS.filter(effort => allowedEffortSet.has(effort));
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
          effort: getConcreteModelEffortConfig(entry),
          apiKeyHash: hashConfigValue(entry.apiKey || ''),
          extraFieldsHash: hashConfigValue(entry.extraFields || {}),
          extraHeadersHash: hashConfigValue(entry.extraHeaders || {}),
          webSearchHash: hashConfigValue(entry.webSearch || {}),
        };
      }),
    });

    models[virtualKey] = {
      providerKey: virtualKey,
      canonicalModelKey: virtualKey,
      providerType,
      model: '',
      contextLimit,
      effort: { allowed: allowedEfforts },
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
