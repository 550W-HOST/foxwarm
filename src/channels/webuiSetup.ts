import type express from 'express';
import path from 'path';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import type { HttpServer } from '../httpServer';
import type { ConfigInstaller } from '../configInstaller';
import { logger } from '../common';
import { APP_CONFIG_PATH, MODELS_CONFIG_TEMPLATE_PATH, MODEL_EFFORTS, getActiveModelsConfigPath, readAppConfigFile, resolveModelConfig, type AppConfig, type ProviderConfigEntry, type ProviderConfigValue, type ModelsConfig } from '../config';
import { buildModelsConfigFromSetupForm, dumpSetupYaml, readRawAppConfigFile, readRawTextFileIfExists, validateAppConfigYaml, buildAppConfigWithChannelsYaml } from '../setupConfig';
import { listChannelRuntimeStatuses } from '../channelRuntime';
import { requestLlmOnce } from '../llm';
import { DEFAULT_WEIXIN_BASE_URL, DEFAULT_WEIXIN_LOGIN_BOT_TYPE, startWeixinQrLogin, waitForWeixinQrLogin } from '../weixin/api';
import { listProviderModels, parseProviderModelListRequest, ProviderModelListError } from '../providerModelList';
import { isConcreteProviderType } from '../../packages/shared/dist/configSchemas';

const MODEL_PLACEHOLDER_RE = /^(your-|sk-\.\.\.|changeme|replace-me|)$/i;

function isPlaceholderSecret(value: unknown): boolean {
  return typeof value === 'string' && MODEL_PLACEHOLDER_RE.test(value.trim()) && value.trim().length > 0;
}

export function getModelsSetupDiagnostics(modelsPath: string = getActiveModelsConfigPath()) {
  const exists = fs.existsSync(modelsPath);
  const rawYaml = exists ? readRawTextFileIfExists(modelsPath) : '';
  const raw = rawYaml ? (yaml.load(rawYaml) as any) || {} : undefined;
  const providers = raw?.providers || raw?.models || {};
  const providerEntries = providers && typeof providers === 'object' && !Array.isArray(providers) ? Object.entries(providers as Record<string, ProviderConfigValue>) : [];
  const providerCount = providerEntries.length;
  const defaultModel = typeof raw?.default === 'string' ? raw.default : null;
  const placeholderProviders = providerEntries
    .filter(([, entry]) => typeof entry !== 'string' && isPlaceholderSecret(entry.apiKey))
    .map(([key]) => key);

  return {
    path: modelsPath,
    templatePath: MODELS_CONFIG_TEMPLATE_PATH,
    exists,
    providerCount,
    defaultModel,
    rawYaml,
    providers: providerEntries.map(([key, entry]) => {
      const normalizedEntry: ProviderConfigEntry = typeof entry === 'string'
        ? { providerType: 'session-hash', targets: [entry.trim()] }
        : entry;
      const providerType = normalizedEntry.providerType || normalizedEntry.provider || 'openai-completions';
      const isVirtual = providerType === 'session-hash' || providerType === 'failover';
      const rawModels = Array.isArray(normalizedEntry.models) ? normalizedEntry.models : Array.isArray(normalizedEntry.model) ? normalizedEntry.model : (normalizedEntry.model ? [normalizedEntry.model] : []);
      const models = rawModels
        .map((item: any) => typeof item === 'string' ? item : item?.id)
        .filter((item: any) => typeof item === 'string' && item.trim())
        .join('\n');
      const defaultPrefix = `${key}/`;
      return {
        id: key,
        providerType,
        isVirtual,
        baseUrl: normalizedEntry.baseUrl || '',
        apiKey: normalizedEntry.apiKey || '',
        models,
        targets: Array.isArray(normalizedEntry.targets) ? normalizedEntry.targets : [],
        failureThreshold: normalizedEntry.failureThreshold ?? (providerType === 'failover' ? 5 : null),
        cooldownMs: normalizedEntry.cooldownMs ?? (providerType === 'failover' ? 600_000 : null),
        defaultModel: defaultModel?.startsWith(defaultPrefix) ? defaultModel.slice(defaultPrefix.length) : '',
      };
    }),
    hasPlaceholderSecrets: placeholderProviders.length > 0,
    placeholderProviders,
    oobe: !exists,
  };
}

function buildProviderConfigFromSetup(body: any): { default: string; providers: Record<string, ProviderConfigEntry> } {
  const providerKey = String(body?.providerKey || body?.provider || 'openai').trim() || 'openai';
  const providerType = String(body?.providerType || 'openai-completions').trim() || 'openai-completions';
  if (!isConcreteProviderType(providerType)) {
    throw new Error(`Provider type \`${providerType}\` cannot be tested. Choose a concrete protocol.`);
  }
  const baseUrl = String(body?.baseUrl || '').trim();
  const apiKey = String(body?.apiKey || '').trim();
  const modelLines = String(body?.models || body?.model || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (modelLines.length === 0) {
    throw new Error('At least one model id is required.');
  }

  const defaultModelId = String(body?.defaultModel || modelLines[0]).trim() || modelLines[0];
  const defaultKey = modelLines.length === 1 ? providerKey : `${providerKey}/${defaultModelId}`;
  const provider: ProviderConfigEntry = {
    providerType,
    baseUrl: baseUrl || undefined,
    ...(apiKey ? { apiKey } : {}),
    models: modelLines,
  };

  return {
    default: defaultKey,
    providers: {
      [providerKey]: provider,
    },
  };
}

function parseChannelsYaml(rawYaml: unknown): AppConfig['channels'] {
  const text = typeof rawYaml === 'string' ? rawYaml.trim() : '';
  if (!text) {
    return {};
  }
  const parsed = yaml.load(text) as any;
  if (!parsed) {
    return {};
  }
  const channels = parsed.channels && typeof parsed.channels === 'object' ? parsed.channels : parsed;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    throw new Error('channels config must be a YAML object or an object under `channels:`.');
  }
  return channels;
}

function sanitizeChannelConfigForSetup(config: AppConfig): Record<string, any> {
  return config.channels || {};
}

function getWeixinSetupConfig(body: any = {}) {
  const appConfig = readAppConfigFile();
  const rawChannels = appConfig.channels || {};
  const requestedChannelId = typeof body.channelId === 'string' && body.channelId.trim() ? body.channelId.trim() : undefined;
  const channelId = requestedChannelId
    || Object.entries(rawChannels).find(([id, config]: [string, any]) => (config?.type || id) === 'weixin')?.[0]
    || 'weixin';
  const existing = (rawChannels as any)[channelId] || {};
  return {
    appConfig,
    channelId,
    existing,
    baseUrl: body.baseUrl?.trim?.() || existing.baseUrl || DEFAULT_WEIXIN_BASE_URL,
    routeTag: body.routeTag?.trim?.() || existing.routeTag || undefined,
    botType: body.botType?.trim?.() || existing.loginBotType || DEFAULT_WEIXIN_LOGIN_BOT_TYPE,
  };
}

export function buildWebUiModelsPayloadFromConfig(modelsConfig: ModelsConfig, currentKey: string = modelsConfig.default) {
  const defaultKey = modelsConfig.default;
  const displayModels = modelsConfig.displayModels || Object.keys(modelsConfig.models || {});
  return {
    defaultKey,
    currentKey,
    models: displayModels.map((key) => {
      const entry = modelsConfig.models[key];
      return {
        key,
        label: key,
        isDefault: key === defaultKey,
        contextLimit: entry?.contextLimit || null,
        providerKey: entry?.providerKey || null,
        modelId: entry?.model || null,
        providerType: entry?.providerType || null,
        isVirtual: !!entry?.virtualRouting,
        targets: entry?.virtualRouting?.targets || [],
        allowedEfforts: [...(entry?.effort?.allowed || MODEL_EFFORTS)],
        defaultEffort: entry?.virtualRouting ? null : (entry?.effort?.default || 'high'),
      };
    }),
  };
}

export function buildWebUiModelsPayload(currentModel?: string) {
  const { modelsConfig, currentKey } = resolveModelConfig(currentModel);
  return buildWebUiModelsPayloadFromConfig(modelsConfig, currentKey);
}

/** Administrator Setup and model catalog routes share the Main configuration installer. */
export function registerWebUiSetupRoutes(server: HttpServer, installer: ConfigInstaller): void {
  server.addRoute({
    path: '/api/models',
    method: 'GET',
    handler: async (req: express.Request, res: express.Response) => {
      try {
        const currentModel = typeof req.query.current === 'string' ? req.query.current : undefined;
        res.json(buildWebUiModelsPayload(currentModel));
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to get models');
        res.status(500).json({ error: e.message });
      }
    },
  });

  server.addRoute({
    path: '/api/setup/status',
    method: 'GET',
    handler: async (_req: express.Request, res: express.Response) => {
      try {
        const models = getModelsSetupDiagnostics();
        const rawAppConfigYaml = readRawAppConfigFile();
        const appConfig = rawAppConfigYaml ? validateAppConfigYaml(rawAppConfigYaml) : readAppConfigFile();
        const channels = sanitizeChannelConfigForSetup(appConfig);
        res.json({
          oobe: models.oobe,
          models,
          config: {
            appConfigPath: APP_CONFIG_PATH,
            rawYaml: rawAppConfigYaml,
            // Backward-compatible field for older clients; the Setup UI now
            // edits rawYaml (the entire config file) so comments and unknown
            // top-level fields are not destroyed by section serialization.
            channelsYaml: dumpSetupYaml(channels),
            channelCount: Object.keys(channels).length,
          },
          channels: listChannelRuntimeStatuses(),
        });
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to get setup status');
        res.status(500).json({ error: e.message });
      }
    },
  });

  server.addRoute({
    path: '/api/setup/models',
    method: 'POST',
    handler: async (req: express.Request, res: express.Response) => {
      try {
        const modelsPath = getActiveModelsConfigPath();
        fs.ensureDirSync(path.dirname(modelsPath));
        const hasRawYaml = Object.prototype.hasOwnProperty.call(req.body || {}, 'yaml');
        if (hasRawYaml) {
          // Raw mode is intentionally raw: validate first, then write the
          // user-provided text byte-for-byte instead of parse + dump, so
          // comments, key order, quoting, and custom formatting survive.
          await installer.install('models', String(req.body?.yaml ?? ''));
        } else {
          await installer.install('models', () => {
            const existingRaw = readRawTextFileIfExists(modelsPath);
            const existingConfig = existingRaw.trim() ? ((yaml.load(existingRaw) as any) || {}) : {};
            return dumpSetupYaml(buildModelsConfigFromSetupForm(req.body || {}, existingConfig));
          });
        }

        // Validate by resolving the newly written config.
        const payload = buildWebUiModelsPayload();
        res.json({ success: true, models: getModelsSetupDiagnostics(), payload });
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to save models setup');
        res.status(400).json({ error: e.message });
      }
    },
  });

  server.addRoute({
    path: '/api/setup/models/list',
    method: 'POST',
    handler: async (req: express.Request, res: express.Response) => {
      let providerType = '';
      try {
        const request = parseProviderModelListRequest(req.body);
        providerType = request.providerType;
        const models = await listProviderModels(request);
        res.json({ models });
      } catch (error) {
        if (error instanceof ProviderModelListError) {
          logger.warn({
            providerType,
            code: error.code,
            upstreamStatus: error.upstreamStatus,
          }, 'Failed to list provider models');
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        logger.error({
          providerType,
          errorName: error instanceof Error ? error.name : typeof error,
        }, 'Unexpected provider model list failure');
        res.status(500).json({ error: 'Failed to list provider models.' });
      }
    },
  });

  server.addRoute({
    path: '/api/setup/models/test',
    method: 'POST',
    handler: async (req: express.Request, res: express.Response) => {
      try {
        const transientConfig = buildProviderConfigFromSetup(req.body);
        const config = transientConfig.providers[Object.keys(transientConfig.providers)[0]];
        const model = typeof req.body?.testModel === 'string' && req.body.testModel.trim()
          ? req.body.testModel.trim()
          : (Array.isArray(config.models) ? (typeof config.models[0] === 'string' ? config.models[0] : config.models[0]?.id) : '');
        if (!model) {
          throw new Error('A model id is required for test.');
        }

        const modelConfig = {
          ...config,
          model,
          providerKey: Object.keys(transientConfig.providers)[0],
          extraFields: config.extraFields || {},
          extraHeaders: config.extraHeaders || {},
        } as any;
        const result = await requestLlmOnce({
          contents: [{ role: 'user', parts: [{ text: 'Please reply ok' }] }],
          systemPrompt: '',
          modelEntryOverride: modelConfig,
          sessionId: 'setup-model-test',
          promptCacheKey: 'setup-model-test',
          iteration: 0,
          toolDefinitions: [],
          notifySessionEvents: false,
          registerAbortController: false,
          maxRetries: 1,
          timeoutMs: 30000,
          purpose: 'setup-test',
        });
        res.json({ success: true, text: result.text, usage: result.usage || null });
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to test models setup');
        res.status(400).json({ success: false, error: e.message });
      }
    },
  });

  server.addRoute({
    path: '/api/setup/config',
    method: 'POST',
    handler: async (req: express.Request, res: express.Response) => {
      try {
        const rawYaml = String(req.body?.yaml ?? '');
        const config = validateAppConfigYaml(rawYaml);
        const installation = await installer.install('config', rawYaml);
        const reload = installation.reload;
        res.json({
          success: true,
          configPath: APP_CONFIG_PATH,
          rawYaml,
          channelCount: Object.keys(config.channels || {}).length,
          ...installation,
          reload,
        });
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to save setup config');
        res.status(400).json({ error: e.message });
      }
    },
  });

  server.addRoute({
    path: '/api/setup/channels',
    method: 'POST',
    handler: async (req: express.Request, res: express.Response) => {
      try {
        const nextChannels = req.body?.channels && typeof req.body.channels === 'object'
          ? req.body.channels
          : parseChannelsYaml(req.body?.yaml);
        const installation = await installer.install('config', () => buildAppConfigWithChannelsYaml(nextChannels || {}, APP_CONFIG_PATH));
        const reload = installation.reload;
        res.json({
          success: true,
          configPath: APP_CONFIG_PATH,
          channelsYaml: dumpSetupYaml(nextChannels || {}),
          ...installation,
          reload,
        });
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to save channels setup');
        res.status(400).json({ error: e.message });
      }
    },
  });

  server.addRoute({
    path: '/api/setup/weixin/login/start',
    method: 'POST',
    handler: async (req: express.Request, res: express.Response) => {
      try {
        const setup = getWeixinSetupConfig(req.body || {});
        const result = await startWeixinQrLogin({
          baseUrl: setup.baseUrl,
          botType: setup.botType,
          routeTag: setup.routeTag,
          force: req.body?.force === true,
        });
        res.json({ success: true, channelId: setup.channelId, baseUrl: setup.baseUrl, routeTag: setup.routeTag || null, botType: setup.botType, ...result });
      } catch (e: any) {
        logger.error({ err: e }, 'Failed to start Weixin setup login');
        res.status(400).json({ error: e.message });
      }
    },
  });

  server.addRoute({
    path: '/api/setup/weixin/login/wait',
    method: 'POST',
    handler: async (req: express.Request, res: express.Response) => {
      try {
        const sessionKey = typeof req.body?.sessionKey === 'string' ? req.body.sessionKey.trim() : '';
        if (!sessionKey) {
          throw new Error('sessionKey is required.');
        }
        const setup = getWeixinSetupConfig(req.body || {});
        const result = await waitForWeixinQrLogin({ sessionKey, baseUrl: setup.baseUrl, routeTag: setup.routeTag, timeoutMs: 5000 });
        if (result.connected && result.botToken) {
          const installation = await installer.install('config', () => {
            const current = readAppConfigFile();
            const existingChannels = current.channels || {};
            const previous = (existingChannels as any)[setup.channelId] || {};
            const channels: AppConfig['channels'] = {
              ...existingChannels,
              [setup.channelId]: {
                ...previous,
                type: previous.type || (setup.channelId === 'weixin' ? undefined : 'weixin'),
                enabled: true,
                baseUrl: result.baseUrl || setup.baseUrl,
                token: result.botToken,
                routeTag: setup.routeTag,
                allowedUsers: result.userId ? Array.from(new Set([...(previous.allowedUsers || []), result.userId])) : previous.allowedUsers,
              },
            };
            return buildAppConfigWithChannelsYaml(channels, APP_CONFIG_PATH);
          });
          const reload = installation.reload;
          return res.json({ success: true, channelId: setup.channelId, connected: true, userId: result.userId || null, message: result.message, ...installation, reload });
        }
        res.json({ success: true, channelId: setup.channelId, connected: false, message: result.message });
      } catch (e: any) {
        logger.error({ err: e }, 'Failed while waiting for Weixin setup login');
        res.status(400).json({ error: e.message });
      }
    },
  });
}
