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
};

export type MatrixConfig = {
  enabled?: boolean;
  homeserver?: string;
  accessToken?: string;
  botUserId?: string;
  allowedUsers?: string[];
};

export type WeWorkConfig = {
  enabled?: boolean;
  webhookUrl?: string;
  token?: string;
  encodingAESKey?: string;
  listenPort?: number;
  listenPath?: string;
  allowedUsers?: string[];
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
  channels?: {
    telegram?: TelegramConfig;
    matrix?: MatrixConfig;
    wework?: WeWorkConfig;
  };
};

// Base directories
export const BASE_DIR = path.join(__dirname, '..');
export const STATE_DIR = path.join(BASE_DIR, 'state');

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
    },
  };

  return cleanupUndefinedDeep(config);
}

function migrateLegacyEnvIfNeeded(): void {
  const legacyEnvPath = path.join(process.cwd(), '.env');

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

function loadAppConfig(): AppConfig {
  migrateLegacyEnvIfNeeded();

  if (!fs.existsSync(APP_CONFIG_PATH)) {
    return {};
  }

  const parsed = yaml.load(fs.readFileSync(APP_CONFIG_PATH, 'utf8')) as AppConfig | undefined;
  return parsed || {};
}

function resolvePathValue(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(BASE_DIR, value);
}

export const APP_CONFIG = loadAppConfig();
export const BOT_NAME = APP_CONFIG.bot?.name || 'foxwarm';
export const ENABLE_TUI = APP_CONFIG.bot?.enableTUI === true || process.argv.includes('--tui');
export const TELEGRAM_CONFIG: TelegramConfig = APP_CONFIG.channels?.telegram || {};
export const MATRIX_CONFIG: MatrixConfig = APP_CONFIG.channels?.matrix || {};
export const WEWORK_CONFIG: WeWorkConfig = APP_CONFIG.channels?.wework || {};
export const OLLAMA_BASE_URL = APP_CONFIG.llm?.ollamaBaseUrl || 'http://localhost:11434';

export const AGENTS_DIR = resolvePathValue(APP_CONFIG.paths?.agentsDir, path.join(BASE_DIR, 'agents'));
export const SKILLS_DIR = resolvePathValue(APP_CONFIG.paths?.skillsDir, path.join(BASE_DIR, 'skills'));
export const WORKSPACE_DIR = AGENTS_DIR; // Legacy alias for agent-folder

// State subdirectories
export const LOGS_DIR = path.join(STATE_DIR, 'logs');
export const SESSION_LOGS_DIR = path.join(LOGS_DIR, 'sessions');
export const DB_DIR = path.join(STATE_DIR, 'db');
export const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
export const PERSISTENT_MEMORY_DIR = path.join(STATE_DIR, 'persistent_memory'); // Legacy path for migration
export const MAIN_AGENT_DIR = path.join(AGENTS_DIR, 'main');
export const MAIN_AGENT_MEMORY_DIR = path.join(MAIN_AGENT_DIR, 'memory');

// Files
export const TOKEN_FILE = path.join(STATE_DIR, 'token');
export const NODE_TOKEN_FILE = path.join(STATE_DIR, 'node_token');
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

export function getSessionArchiveImagesDir(sessionId: string): string {
  return path.join(LOGS_DIR, `${sessionId}.images`);
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
export const COMPACT_PERCENT = APP_CONFIG.llm?.compactPercent || 0.2;

// TODO: move to models config
export const MAX_OUTPUT = APP_CONFIG.llm?.maxOutput || 16384;
export const THINKING_BUDGET = APP_CONFIG.llm?.thinkingBudget || 10000;

// Models configuration
export const DEFAULT_MODELS_CONFIG_PATH = path.join(STATE_DIR, 'models.yaml');
export const MODELS_CONFIG_TEMPLATE_PATH = path.join(BASE_DIR, 'templates', 'models.example.yaml');
export const MODELS_CONFIG_PATH = resolvePathValue(process.env.MODELS_CONFIG_PATH || APP_CONFIG.paths?.modelsConfigPath, DEFAULT_MODELS_CONFIG_PATH);

export type ModelConfigEntry = {
  provider?: string;
  model?: string | string[];
  baseUrl?: string;
  apiKey?: string;
  contextLimit?: number;
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

function expandModelsConfig(rawModels: Record<string, ModelConfigEntry>) {
  const models: Record<string, ModelConfigEntry> = {};
  const displayModels: string[] = [];

  for (const [provider, rawEntry] of Object.entries(rawModels || {})) {
    const entry = applyProviderDefaults(rawEntry);
    const providerType = entry.provider;
    let modelField = entry.model;

    // Allow empty/undefined (some providers has default model)
    if (!modelField || !modelField.length) {
      models[provider] = { ...entry, provider: providerType, model: '' };
      displayModels.push(provider);
      continue;
    }

    // Allow string
    if (modelField && typeof modelField === 'string') {
      modelField = [modelField];
    }

    if (modelField?.length === 1) {
      const modelName = modelField[0];
      models[provider] = { ...entry, provider: providerType, model: modelName };
      models[`${provider}/${modelName}`] = { ...entry, provider: providerType, model: modelName };
      displayModels.push(provider);
    } else {
      for (const modelName of modelField) {
        const modelKey = `${provider}/${modelName}`;
        models[modelKey] = { ...entry, provider: providerType, model: modelName };
        displayModels.push(modelKey);
      }
    }
  }

  return { models, displayModels };
}

function applyProviderDefaults(entry: ModelConfigEntry): ModelConfigEntry {
  const provider = entry.provider || 'openai';

  if (provider === 'anthropic') {
    return {
      ...entry,
      provider,
      baseUrl: entry.baseUrl || APP_CONFIG.llm?.anthropicBaseUrl || 'https://api.anthropic.com',
      apiKey: entry.apiKey || APP_CONFIG.llm?.anthropicApiKey,
    };
  }

  if (provider === 'openai' || provider === 'openai-responses') {
    return {
      ...entry,
      provider,
      baseUrl: entry.baseUrl || APP_CONFIG.llm?.openaiBaseUrl || 'https://api.openai.com/v1',
      apiKey: entry.apiKey || APP_CONFIG.llm?.openaiApiKey,
    };
  }

  return entry;
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
    const expanded = expandModelsConfig(config.models);
    const defaultKey = expanded.models[config.default] ? config.default : (expanded.displayModels[0] || config.default);

    return { default: defaultKey, models: expanded.models, displayModels: expanded.displayModels };
  } catch (e) {
    throw new Error(
      `Loading models config (${resolvedPath}) error: ${e}. ` +
      `Set MODELS_CONFIG_PATH, or create ${DEFAULT_MODELS_CONFIG_PATH} from ${MODELS_CONFIG_TEMPLATE_PATH}.`
    );
  }
}

export function resolveModelConfig(sessionModel?: string) {
  const modelsConfig = loadModelsConfig();
  const defaultKey = modelsConfig.default;
  const currentKey = sessionModel && modelsConfig.models[sessionModel] ? sessionModel : defaultKey;
  const modelEntry = modelsConfig.models[currentKey] || modelsConfig.models[defaultKey];
  const contextLimit = modelEntry?.contextLimit || CONTEXT_LIMIT;

  return { modelsConfig, defaultKey, currentKey, modelEntry, contextLimit };
}
