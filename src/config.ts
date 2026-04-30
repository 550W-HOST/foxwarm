/**
 * Centralized configuration constants
 */
import path from 'path';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import dotenv from 'dotenv';

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
    modelsConfigPath?: string;
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

const CONFIG_PATH_ENV = process.env.FOXWARM_CONFIG_PATH || process.env.CONFIG_PATH;
export const APP_CONFIG_PATH = CONFIG_PATH_ENV
  ? path.resolve(BASE_DIR, CONFIG_PATH_ENV)
  : path.join(STATE_DIR, 'config.yaml');

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true';
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map(v => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

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

function buildConfigFromLegacyEnv(source: Record<string, string | undefined>): AppConfig {
  const telegramAllowed = parseList(source.TELEGRAM_ALLOWED_USERS) || (source.ALLOWED_USER_ID ? [source.ALLOWED_USER_ID] : undefined);
  const matrixAllowed = parseList(source.MATRIX_ALLOWED_USERS);
  const weworkAllowed = parseList(source.WEWORK_ALLOWED_USERS);
  const weixinAllowed = parseList(source.WEIXIN_ALLOWED_USERS);

  const config: AppConfig = {
    bot: {
      name: source.BOT_NAME,
      enableWebUI: parseBoolean(source.ENABLE_WEBUI),
      enableTrigger: parseBoolean(source.ENABLE_TRIGGER),
      httpPort: parseNumber(source.HTTP_PORT || source.WEBUI_PORT),
      enableTUI: parseBoolean(source.ENABLE_TUI),
    },
    llm: {
      ollamaBaseUrl: source.OLLAMA_BASE_URL,
      contextLimit: parseNumber(source.CONTEXT_LIMIT),
      compactPercent: parseNumber(source.COMPACT_PERCENT),
      maxOutput: parseNumber(source.MAX_OUTPUT),
      thinkingBudget: parseNumber(source.THINKING_BUDGET),
      openaiBaseUrl: source.OPENAI_BASE_URL,
      openaiApiKey: source.OPENAI_API_KEY,
      anthropicBaseUrl: source.ANTHROPIC_BASE_URL,
      anthropicApiKey: source.ANTHROPIC_API_KEY,
    },
    paths: {
      agentsDir: source.AGENTS_DIR,
      skillsDir: source.SKILLS_DIR,
      modelsConfigPath: source.MODELS_CONFIG_PATH,
      mcpConfigPath: source.MCP_CONFIG_PATH,
    },
    channels: {
      telegram: {
        enabled: source.TELEGRAM_BOT_TOKEN ? true : undefined,
        botToken: source.TELEGRAM_BOT_TOKEN,
        allowedUsers: telegramAllowed,
        mainAttachUser: source.ALLOWED_USER_ID,
      },
      matrix: {
        enabled: (source.MATRIX_HOMESERVER && source.MATRIX_ACCESS_TOKEN && source.MATRIX_USER_ID) ? true : undefined,
        homeserver: source.MATRIX_HOMESERVER,
        accessToken: source.MATRIX_ACCESS_TOKEN,
        botUserId: source.MATRIX_USER_ID,
        allowedUsers: matrixAllowed,
      },
      wework: {
        enabled: source.WEWORK_WEBHOOK_URL ? true : undefined,
        webhookUrl: source.WEWORK_WEBHOOK_URL,
        token: source.WEWORK_TOKEN,
        encodingAESKey: source.WEWORK_ENCODING_AES_KEY,
        listenPort: parseNumber(source.WEWORK_LISTEN_PORT),
        listenPath: source.WEWORK_LISTEN_PATH,
        allowedUsers: weworkAllowed,
      },
      weixin: {
        enabled: source.WEIXIN_TOKEN ? true : undefined,
        baseUrl: source.WEIXIN_BASE_URL,
        token: source.WEIXIN_TOKEN,
        routeTag: source.WEIXIN_ROUTE_TAG,
        allowedUsers: weixinAllowed,
        allowAllUsers: parseBoolean(source.WEIXIN_ALLOW_ALL_USERS),
        longPollTimeoutMs: parseNumber(source.WEIXIN_LONG_POLL_TIMEOUT_MS),
        loginBotType: source.WEIXIN_LOGIN_BOT_TYPE,
      },
    },
    asrService: {
      enabled: parseBoolean(source.ENABLE_ASR_SERVICE),
      url: source.ASR_SERVICE_URL,
      key: source.ASR_SERVICE_KEY,
    },
  };

  return cleanupUndefinedDeep(config);
}

function migrateLegacyEnvIfNeeded(): void {
  const legacyEnvPath = path.join(BASE_DIR, '.env');

  if (fs.existsSync(APP_CONFIG_PATH)) {
    if (fs.existsSync(legacyEnvPath)) {
      console.warn(
        `[config] Legacy .env business config at ${legacyEnvPath} is ignored because ${APP_CONFIG_PATH} already exists.`
      );
    }
    return;
  }

  let source: Record<string, string | undefined> | null = null;

  if (fs.existsSync(legacyEnvPath)) {
    source = dotenv.parse(fs.readFileSync(legacyEnvPath, 'utf8')) as Record<string, string>;
  }

  if (!source) {
    return;
  }

  const migrated = buildConfigFromLegacyEnv(source);
  fs.ensureDirSync(path.dirname(APP_CONFIG_PATH));
  fs.writeFileSync(APP_CONFIG_PATH, yaml.dump(migrated, { noRefs: true, lineWidth: 120 }), 'utf8');
}

export function readAppConfigFile(): AppConfig {
  migrateLegacyEnvIfNeeded();

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
export const PERSISTENT_MEMORY_DIR = path.join(STATE_DIR, 'persistent_memory'); // Legacy path for migration
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

export function getSkillMemoryDir(skillName: string): string {
  return path.join(getSkillDir(skillName), 'memory');
}

export function getSessionArchiveLogPath(sessionId: string): string {
  return path.join(SESSION_LOGS_DIR, `${sessionId}.jsonl`);
}

export function getSessionBlockArchiveLogPath(sessionId: string): string {
  return path.join(SESSION_LOGS_DIR, `${sessionId}.blocks.jsonl`);
}

export function getSessionFrontierPath(sessionId: string): string {
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

// TODO: move to models config
export const MAX_OUTPUT = APP_CONFIG.llm?.maxOutput || 16384;
export const THINKING_BUDGET = APP_CONFIG.llm?.thinkingBudget || 10000;

// Models configuration
export const DEFAULT_MODELS_CONFIG_PATH = path.join(STATE_DIR, 'models.yaml');
export const MODELS_CONFIG_TEMPLATE_PATH = path.join(BASE_DIR, 'templates', 'models.example.yaml');
export const MODELS_CONFIG_PATH = resolvePathValue(process.env.MODELS_CONFIG_PATH || APP_CONFIG.paths?.modelsConfigPath, DEFAULT_MODELS_CONFIG_PATH);

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
};

export type ModelConfigEntry = {
  providerKey: string;
  providerType?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  contextLimit?: number;
  asyncCompact?: boolean;
  requestCompression?: 'gzip' | 'br';
  extraFields?: Record<string, any>;
  extraHeaders?: Record<string, any>;
};

export type ModelsConfig = {
  default: string;
  models: Record<string, ModelConfigEntry>;
  displayModels: string[];
};

let warnedTemplateModelsFallback = false;

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneConfigValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
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
  const displayModels: string[] = [];

  for (const [providerKey, providerEntry] of Object.entries(rawProviderEntries || {})) {
    const normalizedModels = normalizeProviderModelsField(providerKey, providerEntry);

    // Allow empty/undefined (some providers has default model)
    if (!normalizedModels || normalizedModels.length === 0) {
      models[providerKey] = buildResolvedModelEntry(providerKey, providerEntry, '');
      displayModels.push(providerKey);
      continue;
    }

    if (normalizedModels.length === 1) {
      const onlyModel = normalizedModels[0];
      const modelId = typeof onlyModel === 'string' ? onlyModel : onlyModel.id;
      const modelOverride = typeof onlyModel === 'string' ? undefined : onlyModel;
      const resolvedEntry = buildResolvedModelEntry(providerKey, providerEntry, modelId, modelOverride);
      models[providerKey] = resolvedEntry;
      models[`${providerKey}/${modelId}`] = { ...resolvedEntry };
      displayModels.push(providerKey);
    } else {
      for (const rawModel of normalizedModels) {
        const modelId = typeof rawModel === 'string' ? rawModel : rawModel.id;
        const modelOverride = typeof rawModel === 'string' ? undefined : rawModel;
        const modelKey = `${providerKey}/${modelId}`;
        models[modelKey] = buildResolvedModelEntry(providerKey, providerEntry, modelId, modelOverride);
        displayModels.push(modelKey);
      }
    }
  }

  return { models, displayModels };
}

function getResolvedModelsConfigPath(): string {
  if (process.env.MODELS_CONFIG_PATH) {
    return MODELS_CONFIG_PATH;
  }

  if (fs.existsSync(DEFAULT_MODELS_CONFIG_PATH)) {
    return DEFAULT_MODELS_CONFIG_PATH;
  }

  if (fs.existsSync(MODELS_CONFIG_TEMPLATE_PATH)) {
    if (!warnedTemplateModelsFallback) {
      warnedTemplateModelsFallback = true;
      console.warn(
        `[config] state/models.yaml not found; falling back to template models config: ${MODELS_CONFIG_TEMPLATE_PATH}`
      );
    }
    return MODELS_CONFIG_TEMPLATE_PATH;
  }

  return DEFAULT_MODELS_CONFIG_PATH;
}

export function loadModelsConfig(): ModelsConfig {
  const resolvedPath = getResolvedModelsConfigPath();

  try {
    const rawText = fs.readFileSync(resolvedPath, 'utf8');
    const config = yaml.load(rawText) as any;
    return loadModelsConfigFromObject(config);
  } catch (e) {
    throw new Error(
      `Loading models config (${resolvedPath}) error: ${e}. ` +
      `Set MODELS_CONFIG_PATH, or create ${DEFAULT_MODELS_CONFIG_PATH} from ${MODELS_CONFIG_TEMPLATE_PATH}.`
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
