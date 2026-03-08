/**
 * Centralized configuration constants
 */
import path from 'path';
import fs from 'fs-extra';
import yaml from 'js-yaml';

// Base directories
export const BASE_DIR = path.join(__dirname, '..');
export const STATE_DIR = path.join(BASE_DIR, 'state');
export const AGENTS_DIR = process.env.AGENTS_DIR || path.join(BASE_DIR, 'agents');
export const SKILLS_DIR = process.env.SKILLS_DIR || path.join(BASE_DIR, 'skills');
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
export const MCP_CONFIG_PATH = process.env.MCP_CONFIG_PATH || path.join(STATE_DIR, 'mcp.json');

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
export const HTTP_PORT = parseInt(process.env.HTTP_PORT || process.env.WEBUI_PORT || '3001');
export const ENABLE_WEBUI = process.env.ENABLE_WEBUI !== 'false'; // Default: enabled
export const ENABLE_TRIGGER = process.env.ENABLE_TRIGGER !== 'false'; // Default: enabled

// Legacy support
export const TRIGGER_PORT = HTTP_PORT; // For backward compatibility
export const WEBUI_PORT = HTTP_PORT; // For backward compatibility

// Context and compaction settings
export const CONTEXT_LIMIT = parseInt(process.env.CONTEXT_LIMIT || '122880'); // 120K tokens
export const COMPACT_PERCENT = parseFloat(process.env.COMPACT_PERCENT || '0.2');

// TODO: move to models config
export const MAX_OUTPUT = parseInt(process.env.MAX_OUTPUT || '16384');
export const THINKING_BUDGET = parseInt(process.env.THINKING_BUDGET || '10000');

// Models configuration
export const DEFAULT_MODELS_CONFIG_PATH = path.join(STATE_DIR, 'models.yaml');
export const MODELS_CONFIG_TEMPLATE_PATH = path.join(BASE_DIR, 'templates', 'models.example.yaml');
export const MODELS_CONFIG_PATH = process.env.MODELS_CONFIG_PATH || DEFAULT_MODELS_CONFIG_PATH;

export type ModelConfigEntry = {
  provider?: string;
  model?: string | string[];
  baseUrl?: string;
  apiKey?: string;
  contextLimit?: number;
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
      baseUrl: entry.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      apiKey: entry.apiKey || process.env.ANTHROPIC_API_KEY,
    };
  }

  if (provider === 'openai') {
    return {
      ...entry,
      provider,
      baseUrl: entry.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: entry.apiKey || process.env.OPENAI_API_KEY,
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
