import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import {
  APP_CONFIG_PATH,
  AppConfig,
  getActiveModelsConfigPath,
  ProviderConfigEntry,
  loadModelsConfigFromObject,
  normalizeDbWorkersEnabled,
  normalizeSessionWorkersConfig,
  normalizeVectorConfig,
  normalizeVectorMaintenanceConfig,
} from './config';

export type ProviderSetupDraft = {
  id?: string;
  providerKey?: string;
  provider?: string;
  providerType?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string;
  model?: string;
  defaultModel?: string;
  targets?: string | string[];
  failureThreshold?: number | string;
  cooldownMs?: number | string;
};

function hasOwn(value: unknown, key: string): boolean {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneConfigValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function dumpSetupYaml(value: unknown): string {
  return yaml.dump(value, { noRefs: true, lineWidth: 120 });
}

export function readRawTextFileIfExists(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

function parseYamlObject(rawYaml: string, label: string): Record<string, any> {
  const parsed = yaml.load(rawYaml);
  if (parsed === undefined || parsed === null) {
    return {};
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a YAML object.`);
  }
  return parsed;
}

export function validateModelsConfigYaml(rawYaml: string): Record<string, any> {
  const config = parseYamlObject(rawYaml, 'models config');
  loadModelsConfigFromObject(config);
  return config;
}

export function writeRawModelsConfig(rawYaml: string, filePath: string = getActiveModelsConfigPath()): Record<string, any> {
  const config = validateModelsConfigYaml(rawYaml);
  fs.ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, rawYaml, 'utf8');
  return config;
}

export function readRawAppConfigFile(filePath: string = APP_CONFIG_PATH): string {
  return readRawTextFileIfExists(filePath);
}

export function validateAppConfigYaml(rawYaml: string): AppConfig {
  const config = parseYamlObject(rawYaml, 'app config') as AppConfig;
  if (config.channels !== undefined && !isPlainObject(config.channels)) {
    throw new Error('app config `channels` must be a YAML object.');
  }
  normalizeSessionWorkersConfig(config.sessionWorkers);
  normalizeDbWorkersEnabled(config.dbWorkers);
  normalizeVectorConfig(config.vector, config.llm?.ollamaBaseUrl);
  normalizeVectorMaintenanceConfig(config.vectorMaintenance);
  return config;
}

export function writeRawAppConfig(rawYaml: string, filePath: string = APP_CONFIG_PATH): AppConfig {
  const config = validateAppConfigYaml(rawYaml);
  fs.ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, rawYaml, 'utf8');
  return config;
}

function indentYamlBlock(rawYaml: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return rawYaml
    .replace(/\s+$/g, '')
    .split('\n')
    .map((line) => line.trim() ? `${prefix}${line}` : line)
    .join('\n');
}

function buildTopLevelSectionText(sectionKey: string, sectionValue: unknown): string {
  const bodyYaml = dumpSetupYaml(sectionValue).trimEnd();
  if (!bodyYaml || bodyYaml === '{}') {
    return `${sectionKey}: {}`;
  }
  return `${sectionKey}:\n${indentYamlBlock(bodyYaml, 2)}`;
}

function replaceTopLevelSection(rawYaml: string, sectionKey: string, sectionText: string): string {
  const hasFinalNewline = rawYaml.endsWith('\n');
  const lines = rawYaml.split('\n');
  if (hasFinalNewline) {
    lines.pop();
  }

  const sectionStartRe = new RegExp(`^${sectionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const start = lines.findIndex((line) => sectionStartRe.test(line));
  if (start < 0) {
    const prefix = rawYaml.trimEnd();
    return `${prefix}${prefix ? '\n\n' : ''}${sectionText}\n`;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && /^\S/.test(line)) {
      end = index;
      break;
    }
  }

  const nextLines = [
    ...lines.slice(0, start),
    ...sectionText.split('\n'),
    ...lines.slice(end),
  ];
  return `${nextLines.join('\n')}${hasFinalNewline ? '\n' : ''}`;
}

export function writeAppConfigWithChannels(channels: AppConfig['channels'], filePath: string = APP_CONFIG_PATH): AppConfig {
  const rawYaml = filePath === APP_CONFIG_PATH ? readRawAppConfigFile(filePath) : readRawTextFileIfExists(filePath);
  const current = rawYaml.trim() ? validateAppConfigYaml(rawYaml) : {};
  const nextConfig: AppConfig = {
    ...current,
    channels: channels || {},
  };
  const nextRawYaml = rawYaml.trim()
    ? replaceTopLevelSection(rawYaml, 'channels', buildTopLevelSectionText('channels', nextConfig.channels || {}))
    : dumpSetupYaml(nextConfig);
  return writeRawAppConfig(nextRawYaml, filePath);
}

function splitModelIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getModelEntryId(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (isPlainObject(entry) && typeof entry.id === 'string') return entry.id.trim();
  return '';
}

function buildModelListPreservingOverrides(existingRawModels: unknown, modelIds: string[]): ProviderConfigEntry['models'] {
  const existingEntries = new Map<string, unknown>();
  const sourceEntries = typeof existingRawModels === 'string'
    ? [existingRawModels]
    : Array.isArray(existingRawModels)
      ? existingRawModels
      : [];

  for (const entry of sourceEntries) {
    const id = getModelEntryId(entry);
    if (id && !existingEntries.has(id)) {
      existingEntries.set(id, entry);
    }
  }

  return modelIds.map((id) => {
    const existing = existingEntries.get(id);
    if (isPlainObject(existing)) {
      return { ...cloneConfigValue(existing), id } as any;
    }
    return id;
  });
}

function normalizeProviderDrafts(body: any): ProviderSetupDraft[] {
  if (Array.isArray(body?.providers)) {
    return body.providers;
  }

  return [{
    id: body?.providerKey || body?.provider || 'openai',
    providerType: body?.providerType,
    baseUrl: body?.baseUrl,
    apiKey: body?.apiKey,
    models: body?.models || body?.model,
    targets: body?.targets,
    failureThreshold: body?.failureThreshold,
    cooldownMs: body?.cooldownMs,
    defaultModel: body?.defaultModel,
  }];
}

export function buildModelsConfigFromSetupForm(body: any, existingConfig: any = {}): { default: string; providers?: Record<string, ProviderConfigEntry>; models?: Record<string, ProviderConfigEntry> } & Record<string, any> {
  const rootKey: 'providers' | 'models' = isPlainObject(existingConfig?.providers)
    ? 'providers'
    : isPlainObject(existingConfig?.models)
      ? 'models'
      : 'providers';
  const existingProviders = isPlainObject(existingConfig?.[rootKey]) ? existingConfig[rootKey] : {};
  const nextProviders: Record<string, ProviderConfigEntry> = {};
  const drafts = normalizeProviderDrafts(body);

  for (const [index, draft] of drafts.entries()) {
    const providerKey = String(draft?.id || draft?.providerKey || draft?.provider || `provider${index + 1}`).trim();
    if (!providerKey) {
      continue;
    }

    const existingProvider = isPlainObject(existingProviders[providerKey])
      ? cloneConfigValue(existingProviders[providerKey]) as ProviderConfigEntry & Record<string, any>
      : {} as ProviderConfigEntry & Record<string, any>;
    const nextProvider: ProviderConfigEntry & Record<string, any> = {
      ...existingProvider,
    };

    const providerType = String(draft?.providerType || existingProvider.providerType || existingProvider.provider || 'openai-completions').trim();
    nextProvider.providerType = providerType || 'openai-completions';

    const isVirtual = providerType === 'session-hash' || providerType === 'failover';
    if (isVirtual) {
      const targets = splitModelIds(hasOwn(draft, 'targets') ? draft.targets : existingProvider.targets);
      nextProvider.targets = targets;
      for (const field of ['models', 'model', 'baseUrl', 'apiKey', 'requestCompression', 'extraFields', 'extraHeaders', 'webSearch', 'contextLimit', 'effort', 'asyncCompact'] as const) {
        delete nextProvider[field];
      }
      if (providerType === 'session-hash') {
        for (const field of ['failureThreshold', 'cooldownMs'] as const) {
          if (hasOwn(draft, field) && String(draft[field] ?? '').trim()) {
            throw new Error(`Virtual provider \`${providerKey}\` (session-hash) forbids failover field \`${field}\`.`);
          }
        }
        delete nextProvider.failureThreshold;
        delete nextProvider.cooldownMs;
      }
      if (providerType === 'failover' && hasOwn(draft, 'failureThreshold')) {
        const rawFailureThreshold = String(draft.failureThreshold ?? '').trim();
        if (!rawFailureThreshold) {
          delete nextProvider.failureThreshold;
        } else {
          const failureThreshold = Number(rawFailureThreshold);
          if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
            throw new Error(`Virtual provider \`${providerKey}\` failureThreshold must be a positive integer.`);
          }
          nextProvider.failureThreshold = failureThreshold;
        }
      }
      if (providerType === 'failover' && hasOwn(draft, 'cooldownMs')) {
        const rawCooldownMs = String(draft.cooldownMs ?? '').trim();
        if (!rawCooldownMs) {
          delete nextProvider.cooldownMs;
        } else {
          const cooldownMs = Number(rawCooldownMs);
          if (!Number.isInteger(cooldownMs) || cooldownMs < 1) {
            throw new Error(`Virtual provider \`${providerKey}\` cooldownMs must be a positive integer.`);
          }
          nextProvider.cooldownMs = cooldownMs;
        }
      }
      nextProviders[providerKey] = nextProvider;
      continue;
    }

    delete nextProvider.targets;
    delete nextProvider.failureThreshold;
    delete nextProvider.cooldownMs;
    const rawModelList = hasOwn(draft, 'models') ? draft.models : draft.model;
    const modelIds = splitModelIds(rawModelList);
    if (modelIds.length === 0) {
      throw new Error(`Provider \`${providerKey}\` requires at least one model id.`);
    }

    if (hasOwn(draft, 'baseUrl')) {
      const baseUrl = String(draft.baseUrl || '').trim();
      if (baseUrl) {
        nextProvider.baseUrl = baseUrl;
      } else {
        delete nextProvider.baseUrl;
      }
    }

    if (hasOwn(draft, 'apiKey')) {
      const apiKey = String(draft.apiKey || '').trim();
      if (apiKey) {
        nextProvider.apiKey = apiKey;
      } else {
        delete nextProvider.apiKey;
      }
    }

    const existingModels = existingProvider.models ?? existingProvider.model;
    nextProvider.models = buildModelListPreservingOverrides(existingModels, modelIds);
    delete nextProvider.model;

    nextProviders[providerKey] = nextProvider;
  }

  if (Object.keys(nextProviders).length === 0) {
    throw new Error('At least one provider with at least one model id is required.');
  }

  const firstProviderKey = Object.keys(nextProviders)[0];
  const firstProvider = nextProviders[firstProviderKey];
  const firstModels = firstProvider.models || [];
  const firstModelId = firstModels.length > 0 ? getModelEntryId(firstModels[0]) : '';
  const fallbackDefault = firstProviderKey && firstModelId ? `${firstProviderKey}/${firstModelId}` : firstProviderKey;
  const defaultKey = String(body?.defaultModel || body?.default || '').trim() || fallbackDefault;

  const nextConfig = {
    ...cloneConfigValue(existingConfig || {}),
    default: defaultKey,
    [rootKey]: nextProviders,
  } as { default: string; providers?: Record<string, ProviderConfigEntry>; models?: Record<string, ProviderConfigEntry> } & Record<string, any>;

  loadModelsConfigFromObject(nextConfig);
  return nextConfig;
}
