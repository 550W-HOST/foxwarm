/**
 * WebUI Channel - HTTP API for web interface and external trigger
 */

import express from 'express';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { buildModelsConfigFromSetupForm, dumpSetupYaml, readRawAppConfigFile, readRawTextFileIfExists, validateAppConfigYaml, writeAppConfigWithChannels, writeRawAppConfig, writeRawModelsConfig } from '../setupConfig';
import { buildSavedFileText, saveInboundSessionFile } from '../channelFiles';
import { WebSocket } from 'ws';
import { Channel, ChannelContext, ChannelFile, ChannelMessage, ChannelSendFileOptions } from '../channel';
import { MessageRouter } from '../messageRouter';
import { logger } from '../common';
import * as sessionManager from '../sessionManager';
import { AGENTS_DIR, APP_CONFIG_PATH, AppConfig, BASE_DIR, MODELS_CONFIG_TEMPLATE_PATH, ProviderConfigEntry, getActiveModelsConfigPath, readAppConfigFile, resolveModelConfig } from '../config';
import { httpServer } from '../httpServer';
import { COMMANDS } from '../commands';
import { listChannelRuntimeStatuses, reloadManagedChannels } from '../channelRuntime';
import { requestLlmOnce } from '../llm';
import { DEFAULT_WEIXIN_BASE_URL, DEFAULT_WEIXIN_LOGIN_BOT_TYPE, startWeixinQrLogin, waitForWeixinQrLogin } from '../weixin/api';
import { createAsrServiceWebSocket, getAsrServiceStatus, transcribeWithAsrService } from '../asrClient';
import { attachTerminalClient, closeTerminal, createTerminal, detachTerminalClient, getTerminalRecord, listTerminalRecords, resizeTerminal, resolveTerminalControlRequest, writeTerminalInput } from '../terminalRouter';
import { getSessionHistoryFilePath } from '../session/metadataStore';
import { normalizeWebUiInstanceName, normalizeWebUiTabIcon, readWebUiSettings, writeWebUiSettings } from '../webuiSettings';
import { renderContextBlockExpansion } from '../toolsSessionAgent/archiveRecall';
import type { Message, MessagePart, QueueItem } from '../types';
import { formatFoxwarmMessage } from '../utils/promptWrappers';
import { registerVscodeWebRoutes } from '../vscodeWebRoutes';
import { externalizeMessages, externalizeQueueItems, getSafeRasterMimeType, resolveImageBlobPath } from '../imageBlobs';

const MODEL_PLACEHOLDER_RE = /^(your-|sk-\.\.\.|changeme|replace-me|)$/i;
const MAX_QUEUED_PREVIEW_ITEMS = 20;
const MAX_QUEUED_PREVIEW_TEXT_CHARS = 4000;

function isPlaceholderSecret(value: unknown): boolean {
  return typeof value === 'string' && MODEL_PLACEHOLDER_RE.test(value.trim()) && value.trim().length > 0;
}

function getSingleQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function parseOptionalPositiveNumberQuery(value: unknown, label: string): number | undefined {
  const raw = getSingleQueryValue(value);
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return Math.floor(parsed);
}

function truncateQueuedPreviewText(value: string): string {
  if (value.length <= MAX_QUEUED_PREVIEW_TEXT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_QUEUED_PREVIEW_TEXT_CHARS)}\n… [preview truncated]`;
}

function sanitizeQueuedPreviewPart(part: MessagePart): MessagePart | null {
  const sanitized: MessagePart = { ...part };

  if (typeof sanitized.text === 'string') {
    sanitized.text = truncateQueuedPreviewText(sanitized.text);
  }
  if (typeof sanitized.system === 'string') {
    sanitized.system = truncateQueuedPreviewText(sanitized.system);
  }
  if (typeof sanitized.thinking === 'string') {
    sanitized.thinking = truncateQueuedPreviewText(sanitized.thinking);
  }

  if (sanitized.inlineData || sanitized.inlineDataRef) {
    const mimeType = sanitized.inlineData?.mimeType
      || sanitized.inlineData?.mime_type
      || sanitized.inlineDataRef?.mimeType
      || 'attachment';
    delete sanitized.inlineData;
    delete (sanitized as any).inlineDataRef;
    return { text: `[${mimeType} attachment preview omitted]` };
  }

  return sanitized;
}

function sanitizeWebUiTransportValue(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeWebUiTransportValue);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'inlineData' && entry && typeof entry === 'object' && typeof (entry as any).data === 'string') {
      const { data: _data, ...metadata } = entry as Record<string, any>;
      result.inlineDataUnavailable = {
        ...sanitizeWebUiTransportValue(metadata),
        unavailable: true,
      };
      continue;
    }
    if (key === 'inlineDataItems' && Array.isArray(entry)) {
      const retained: any[] = [];
      const unavailable: any[] = [];
      for (const item of entry) {
        if (item && typeof item === 'object' && typeof item.data === 'string') {
          const { data: _data, ...metadata } = item;
          unavailable.push({ ...sanitizeWebUiTransportValue(metadata), unavailable: true });
        } else {
          retained.push(sanitizeWebUiTransportValue(item));
        }
      }
      if (retained.length > 0) result.inlineDataItems = retained;
      if (unavailable.length > 0) result.inlineDataItemsUnavailable = unavailable;
      continue;
    }
    if (key === 'inlineDataRef' && entry && typeof entry === 'object') {
      const { path: _path, apiPath: _apiPath, ...ref } = entry as Record<string, any>;
      result.inlineDataRef = ref.blobId
        ? { ...sanitizeWebUiTransportValue(ref), apiPath: `/blobs/${encodeURIComponent(ref.blobId)}` }
        : { ...sanitizeWebUiTransportValue(ref), unavailable: true };
      continue;
    }
    result[key] = sanitizeWebUiTransportValue(entry);
  }
  return result;
}

function buildWebUiMessage(message: Message): Message {
  return sanitizeWebUiTransportValue(message) as Message;
}

async function materializeWebUiMessages(messages: Message[]): Promise<{ messages: Message[]; canonicalMessages: Message[]; changed: boolean }> {
  try {
    const canonical = await externalizeMessages(messages);
    return {
      canonicalMessages: canonical.messages,
      changed: canonical.changed,
      messages: canonical.messages.map(buildWebUiMessage),
    };
  } catch (error) {
    logger.warn({ err: error }, 'Failed to materialize legacy images for WebUI transport');
    return {
      canonicalMessages: messages,
      changed: false,
      messages: messages.map(buildWebUiMessage),
    };
  }
}

async function sanitizeWebUiDebugPayload(payload: any): Promise<any> {
  const result = { ...payload };
  if (Array.isArray(payload?.history)) {
    result.history = (await materializeWebUiMessages(payload.history)).messages;
  }
  if (Array.isArray(payload?.queue)) {
    let queueItems: QueueItem[] = payload.queue;
    try {
      queueItems = (await externalizeQueueItems(payload.queue)).items;
    } catch (error) {
      logger.warn({ err: error }, 'Failed to materialize legacy queue images for WebUI debug transport');
    }
    result.queue = queueItems.map(item => ({
      ...item,
      ...(Array.isArray(item.parts) ? { parts: sanitizeQueuedPreviewParts(item.parts) } : {}),
      ...(item.message ? { message: buildWebUiMessage(item.message) } : {}),
    }));
  }
  return sanitizeWebUiTransportValue(result);
}

function sanitizeQueuedPreviewParts(parts: MessagePart[] | undefined): MessagePart[] {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts
    .map(sanitizeQueuedPreviewPart)
    .filter((part): part is MessagePart => !!part);
}

function hashQueuedPreviewItem(index: number, item: QueueItem): string {
  const hash = crypto.createHash('sha1');
  hash.update(String(index));
  hash.update('\0');
  hash.update(item.type || 'unknown');
  hash.update('\0');
  hash.update(JSON.stringify({
    source: item.source,
    sourceSessionId: item.sourceSessionId,
    parts: item.parts,
    message: item.message,
  }, (_key, value) => (
    typeof value === 'string' && value.length > 1000 ? `${value.slice(0, 1000)}…` : value
  )).slice(0, 20_000));
  return hash.digest('hex').slice(0, 12);
}

function hasSystemPart(parts: MessagePart[]): boolean {
  return parts.some(part => typeof part.system === 'string' && part.system.trim().length > 0);
}

function buildNonUserQueuedPreviewParts(item: QueueItem, parts: MessagePart[]): MessagePart[] {
  if (hasSystemPart(parts)) {
    return parts;
  }

  const text = parts
    .map(part => part.text || part.thinking || '')
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) {
    return [];
  }

  return [{
    system: formatFoxwarmMessage({
      type: item.type || 'background',
      ...(item.sourceSessionId ? { sourceSessionId: item.sourceSessionId } : {}),
      hint: 'queued session event preview',
    }, truncateQueuedPreviewText(text)),
  }];
}

function buildQueuedPreviewMessage(item: QueueItem, index: number): Message | null {
  if (item.type === 'compact-commit') {
    return null;
  }

  const synthetic = `queued-${index}-${item.type}-${hashQueuedPreviewItem(index, item)}`;
  const queuedMeta = {
    ...(item.message?.__meta || {}),
    synthetic,
    temporary: true,
    queuedPreview: true,
    queueIndex: index,
    queueType: item.type,
  };

  if (item.message) {
    return {
      ...item.message,
      parts: sanitizeQueuedPreviewParts(item.message.parts),
      __meta: queuedMeta,
    };
  }

  const sanitizedParts = sanitizeQueuedPreviewParts(item.parts);
  const parts = item.type === 'user'
    ? sanitizedParts
    : buildNonUserQueuedPreviewParts(item, sanitizedParts);

  if (parts.length === 0) {
    return null;
  }

  return {
    role: 'user',
    parts,
    __meta: queuedMeta,
  };
}

function buildQueuedPreviewMessages(queue: QueueItem[] | undefined): Message[] {
  if (!Array.isArray(queue) || queue.length === 0) {
    return [];
  }

  const messages: Message[] = [];
  for (let index = 0; index < queue.length && messages.length < MAX_QUEUED_PREVIEW_ITEMS; index++) {
    const message = buildQueuedPreviewMessage(queue[index], index);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}


export function getModelsSetupDiagnostics(modelsPath: string = getActiveModelsConfigPath()) {
  const exists = fs.existsSync(modelsPath);
  const rawYaml = exists ? readRawTextFileIfExists(modelsPath) : '';
  const raw = rawYaml ? (yaml.load(rawYaml) as any) || {} : undefined;
  const providers = raw?.providers || raw?.models || {};
  const providerEntries = providers && typeof providers === 'object' && !Array.isArray(providers) ? Object.entries(providers as Record<string, ProviderConfigEntry>) : [];
  const providerCount = providerEntries.length;
  const defaultModel = typeof raw?.default === 'string' ? raw.default : null;
  const placeholderProviders = providerEntries
    .filter(([, entry]) => isPlaceholderSecret((entry as ProviderConfigEntry).apiKey))
    .map(([key]) => key);

  return {
    path: modelsPath,
    templatePath: MODELS_CONFIG_TEMPLATE_PATH,
    exists,
    providerCount,
    defaultModel,
    rawYaml,
    providers: providerEntries.map(([key, entry]) => {
      const providerType = entry.providerType || entry.provider || 'openai-completions';
      const isVirtual = providerType === 'session-hash' || providerType === 'failover';
      const rawModels = Array.isArray(entry.models) ? entry.models : Array.isArray(entry.model) ? entry.model : (entry.model ? [entry.model] : []);
      const models = rawModels
        .map((item: any) => typeof item === 'string' ? item : item?.id)
        .filter((item: any) => typeof item === 'string' && item.trim())
        .join('\n');
      const defaultPrefix = `${key}/`;
      return {
        id: key,
        providerType,
        isVirtual,
        baseUrl: entry.baseUrl || '',
        apiKey: entry.apiKey || '',
        models,
        targets: Array.isArray(entry.targets) ? entry.targets : [],
        failureThreshold: entry.failureThreshold ?? (providerType === 'failover' ? 5 : null),
        cooldownMs: entry.cooldownMs ?? (providerType === 'failover' ? 600_000 : null),
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

function buildWebUiModelStatus(session: { model?: string; childModelDefault?: string }) {
  const { defaultKey, currentKey } = resolveModelConfig(session.model);
  const { currentKey: effectiveChildModelKey } = resolveModelConfig(sessionManager.resolveSpawnedSessionModel(session));
  return {
    model: typeof session.model === 'string' && session.model.trim() ? session.model.trim() : null,
    modelKey: currentKey,
    defaultModelKey: defaultKey,
    childModelDefault: typeof session.childModelDefault === 'string' && session.childModelDefault.trim() ? session.childModelDefault.trim() : null,
    effectiveChildModelKey,
  };
}

function buildWebUiSessionState(session: any) {
  return {
    id: session.id,
    agent: session.agent || 'main',
    aliases: session.aliases || [],
    busy: session.busy || false,
    busyStartedAt: typeof session.busyStartedAt === 'number' ? session.busyStartedAt : null,
    queueLength: session.queue?.length || 0,
    runtimeState: sessionManager.buildSessionRuntimeState(session),
    displayName: session.displayName || null,
    archived: session.archived || false,
    currentNode: session.currentNode || 'master',
    cwd: session.cwd || null,
    ...buildWebUiModelStatus(session),
    isolated: sessionManager.isSessionEffectivelyIsolated(session),
  };
}

function buildWebUiModelsPayload(currentModel?: string) {
  const { modelsConfig, defaultKey, currentKey } = resolveModelConfig(currentModel);
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
        providerType: entry?.providerType || null,
        isVirtual: !!entry?.virtualRouting,
        targets: entry?.virtualRouting?.targets || [],
      };
    }),
  };
}

function normalizeWebUiModelSelection(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('model must be a string, null, or omitted with clear=true.');
  }

  const normalized = value.trim();
  if (!normalized || normalized === 'default' || normalized === 'unset' || normalized === 'clear') {
    return undefined;
  }

  const { modelsConfig } = resolveModelConfig(undefined);
  if (!modelsConfig.models[normalized]) {
    throw new Error(`Unknown model \`${normalized}\`.`);
  }

  return normalized;
}

// Extend Express Request to include cookies
declare global {
  namespace Express {
    interface Request {
      cookies: { [key: string]: string };
    }
  }
}

export interface WebUIChannelOptions {
  router: MessageRouter;
  token: string;
  enableWebUI?: boolean;
  enableTrigger?: boolean;
}

function buildChildrenMap(allSessions: Map<string, any>): Map<string, string[]> {
  const childrenMap = new Map<string, string[]>();
  for (const [id, session] of allSessions.entries()) {
    if (session.parentSessionId) {
      if (!childrenMap.has(session.parentSessionId)) {
        childrenMap.set(session.parentSessionId, []);
      }
      childrenMap.get(session.parentSessionId)!.push(id);
    }
  }

  for (const children of childrenMap.values()) {
    children.sort((a, b) => compareWebUiSidebarSessions(
      allSessions.get(a) || { id: a },
      allSessions.get(b) || { id: b },
    ));
  }
  return childrenMap;
}

function getWebUiSidebarOrder(session: any): number | undefined {
  const value = session?.sidebarOrder;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getSessionTreeParentId(session: any): string | null {
  return typeof session?.parentSessionId === 'string' && session.parentSessionId.trim()
    ? session.parentSessionId.trim()
    : null;
}

function compareWebUiSidebarSessions(a: any, b: any): number {
  if (!!a?.archived && !b?.archived) return 1;
  if (!a?.archived && !!b?.archived) return -1;

  const aOrder = getWebUiSidebarOrder(a);
  const bOrder = getWebUiSidebarOrder(b);
  if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) {
    return aOrder - bOrder;
  }
  if (aOrder !== undefined && bOrder === undefined) return -1;
  if (aOrder === undefined && bOrder !== undefined) return 1;

  const aTime = typeof a?.meta?.lastMessageTime === 'number' ? a.meta.lastMessageTime : 0;
  const bTime = typeof b?.meta?.lastMessageTime === 'number' ? b.meta.lastMessageTime : 0;
  if (aTime !== bTime) return bTime - aTime;

  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function getWebUiSidebarSiblings(parentSessionId: string | null, excludeSessionId?: string): any[] {
  return Array.from(sessionManager.getAllSessions().values())
    .filter((candidate: any) => candidate?.id !== excludeSessionId)
    .filter((candidate: any) => getSessionTreeParentId(candidate) === parentSessionId)
    .sort(compareWebUiSidebarSessions);
}

function writeWebUiSidebarOrder(sessions: any[]): void {
  sessions.forEach((session, index) => {
    session.sidebarOrder = (index + 1) * 1000;
  });
}

async function resolveOptionalSessionId(sessionId: unknown, label: string): Promise<string | null | undefined> {
  if (sessionId === undefined) return undefined;
  if (sessionId === null) return null;
  if (typeof sessionId !== 'string') {
    throw new Error(`${label} must be a string, null, or omitted.`);
  }
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  const session = await sessionManager.getExistingSession(trimmed);
  if (!session) {
    const error = new Error(`${label} session "${trimmed}" was not found.`);
    (error as any).statusCode = 404;
    (error as any).code = `${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_NOT_FOUND`;
    throw error;
  }
  return session.id;
}

async function assertNoSidebarParentCycle(childSessionId: string, targetParentSessionId: string | null): Promise<void> {
  if (!targetParentSessionId) return;
  if (childSessionId === targetParentSessionId) {
    const error = new Error('A session cannot be assigned as a child of itself.');
    (error as any).statusCode = 400;
    (error as any).code = 'SELF_PARENT_NOT_ALLOWED';
    throw error;
  }

  const seen = new Set<string>([childSessionId]);
  let cursorParentId: string | null = targetParentSessionId;
  while (cursorParentId) {
    const cursorParent = await sessionManager.getExistingSession(cursorParentId);
    if (!cursorParent) break;
    const canonicalCursorId = cursorParent.id;
    if (seen.has(canonicalCursorId)) {
      const error = new Error(`Session "${childSessionId}" cannot be moved under descendant "${targetParentSessionId}" because that would create a parent cycle.`);
      (error as any).statusCode = 400;
      (error as any).code = 'PARENT_CYCLE_NOT_ALLOWED';
      throw error;
    }
    seen.add(canonicalCursorId);
    cursorParentId = getSessionTreeParentId(cursorParent);
  }
}

type WebUiDeleteLifecycleTestHook = (context: {
  rootSessionId: string;
  includeDescendants: boolean;
  targetSessionIds: string[];
}) => void | Promise<void>;

let webUiDeleteLifecycleTestHook: WebUiDeleteLifecycleTestHook | null = null;

export function setWebUiDeleteLifecycleTestHookForTests(hook: WebUiDeleteLifecycleTestHook | null): void {
  webUiDeleteLifecycleTestHook = hook;
}

function haveSameSessionIds(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((sessionId, index) => sessionId === expected[index]);
}

export class WebUIChannel implements Channel {
  readonly name = 'webui';
  readonly platform = 'webui';
  private router: MessageRouter;
  private token: string;
  private enableWebUI: boolean;
  private enableTrigger: boolean;
  private sseClients: Map<string, express.Response[]> = new Map(); // sessionId -> clients
  private globalSseClients: express.Response[] = []; // Global clients for session list updates

  private async streamPathDownload(resolvedPath: string, res: express.Response): Promise<void> {
    const stat = await fs.stat(resolvedPath);

    if (!stat.isFile()) {
      throw new Error('Path is not a file');
    }

    await new Promise<void>((resolve, reject) => {
      const fileName = path.basename(resolvedPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '')}"`);

      const stream = fs.createReadStream(resolvedPath);
      stream.on('error', (err) => reject(err));
      res.on('close', () => {
        if (!res.writableEnded) {
          stream.destroy();
        }
      });
      res.on('finish', () => resolve());
      stream.pipe(res);
    });
  }

  constructor(options: WebUIChannelOptions) {
    this.router = options.router;
    this.token = options.token;
    this.enableWebUI = options.enableWebUI !== false;
    this.enableTrigger = options.enableTrigger !== false;
    
    // Add routes to HTTP server
    this.setupRoutes();
  }

  // Middleware for static file protection
  private staticAuthMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Do not intercept public login/auth routes. Also let /download reach its
    // dedicated route, where token validation is performed before any file is
    // sent.
    if (req.path === '/login.html' || req.path === '/api/auth' || req.path === '/download') {
      return next();
    }
    
    // Check token
    if (!httpServer.checkToken(req)) {
      // Serve login.html directly instead of redirect
      const loginPath = path.join(BASE_DIR, 'packages', 'webui', 'public', 'login.html');
      return res.sendFile(loginPath);
    }
    
    next();
  };

  private setupRoutes() {
    // Add routes to HTTP server
    const httpServerInstance = httpServer;
    
    // External trigger endpoint
    if (this.enableTrigger) {
      httpServerInstance.addRoute({
        path: '/trigger',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const { text, sessionId } = req.body;
            const finalSessionId = sessionId || 'main'; // Default to main session

            if (!text) throw new Error('Missing text');

            logger.info({ trigger: true, text, sessionId: finalSessionId }, 'External trigger received');

            await sessionManager.queueSessionEvent(finalSessionId, text, 'trigger');
            res.json({ success: true, message: 'Triggered' });
          } catch (e: any) {
            logger.error({ err: e }, 'Trigger error');
            res.status(400).json({ error: e.message });
          }
        },
      });
      logger.info('External trigger endpoint enabled');
    }

    // WebUI API endpoints
    if (this.enableWebUI) {
      registerVscodeWebRoutes(httpServerInstance);

      // Auth endpoint
      httpServerInstance.addRoute({
        path: '/api/auth',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          const { token } = req.body;
          if (token === this.token) {
            res.json({ success: true });
          } else {
            res.status(401).json({ error: 'Invalid token' });
          }
        },
        noAuth: true,
      });

      // Get available slash commands for WebUI autocomplete
      httpServerInstance.addRoute({
        path: '/api/commands',
        method: 'GET',
        handler: async (_req: express.Request, res: express.Response) => {
          try {
            const commands = Object.entries(COMMANDS)
              .map(([name, def]) => ({
                name,
                description: def.description,
                usage: def.usage || null,
                requiresSession: def.requiresSession !== false,
                showInTelegram: def.showInTelegram !== false,
                autocomplete: def.autocomplete || null,
              }))
              .sort((a, b) => a.name.localeCompare(b.name));

            res.json({ commands });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get commands');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/webui/settings',
        method: 'GET',
        handler: async (_req: express.Request, res: express.Response) => {
          try {
            res.json({ settings: readWebUiSettings() });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get WebUI settings');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/webui/settings',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const current = readWebUiSettings();
            const settings = writeWebUiSettings({
              instanceName: Object.prototype.hasOwnProperty.call(req.body || {}, 'instanceName')
                ? normalizeWebUiInstanceName(req.body?.instanceName || '')
                : current.instanceName,
              tabIcon: Object.prototype.hasOwnProperty.call(req.body || {}, 'tabIcon')
                ? normalizeWebUiTabIcon(req.body?.tabIcon || '')
                : current.tabIcon,
            });
            res.json({ success: true, settings });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to save WebUI settings');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
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

      httpServerInstance.addRoute({
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

      httpServerInstance.addRoute({
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
              writeRawModelsConfig(String(req.body?.yaml ?? ''), modelsPath);
            } else {
              const existingRaw = readRawTextFileIfExists(modelsPath);
              const existingConfig = existingRaw.trim() ? ((yaml.load(existingRaw) as any) || {}) : {};
              const config = buildModelsConfigFromSetupForm(req.body || {}, existingConfig);
              fs.writeFileSync(modelsPath, dumpSetupYaml(config), 'utf8');
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

      httpServerInstance.addRoute({
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
            });
            res.json({ success: true, text: result.text, usage: result.usage || null });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to test models setup');
            res.status(400).json({ success: false, error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/setup/config',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const rawYaml = String(req.body?.yaml ?? '');
            const config = writeRawAppConfig(rawYaml, APP_CONFIG_PATH);
            const reload = await reloadManagedChannels();
            res.json({
              success: true,
              configPath: APP_CONFIG_PATH,
              rawYaml,
              channelCount: Object.keys(config.channels || {}).length,
              reload,
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to save setup config');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/setup/channels',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const nextChannels = req.body?.channels && typeof req.body.channels === 'object'
              ? req.body.channels
              : parseChannelsYaml(req.body?.yaml);
            const current = readAppConfigFile();
            const next: AppConfig = {
              ...current,
              channels: nextChannels,
            };
            writeAppConfigWithChannels(next.channels || {}, APP_CONFIG_PATH);
            const reload = await reloadManagedChannels();
            res.json({
              success: true,
              configPath: APP_CONFIG_PATH,
              channelsYaml: dumpSetupYaml(next.channels || {}),
              reload,
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to save channels setup');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
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

      httpServerInstance.addRoute({
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
              const current = readAppConfigFile();
              const existingChannels = current.channels || {};
              const previous = (existingChannels as any)[setup.channelId] || {};
              const next: AppConfig = {
                ...current,
                channels: {
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
                },
              };
              writeAppConfigWithChannels(next.channels || {}, APP_CONFIG_PATH);
              const reload = await reloadManagedChannels();
              return res.json({ success: true, channelId: setup.channelId, connected: true, userId: result.userId || null, message: result.message, reload });
            }
            res.json({ success: true, channelId: setup.channelId, connected: false, message: result.message });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed while waiting for Weixin setup login');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/agents',
        method: 'GET',
        handler: async (_req: express.Request, res: express.Response) => {
          try {
            const entries = await fs.pathExists(AGENTS_DIR)
              ? await fs.readdir(AGENTS_DIR, { withFileTypes: true })
              : [];
            const agents = entries
              .filter(entry => entry.isDirectory())
              .map(entry => ({
                id: entry.name,
                inherit: sessionManager.getAgentMetadata(entry.name).inherit || null,
              }))
              .sort((a, b) => a.id.localeCompare(b.id));
            res.json({ agents });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get agents');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/agents',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
            const inheritAgent = typeof req.body?.inheritAgent === 'string' && req.body.inheritAgent.trim()
              ? req.body.inheritAgent.trim()
              : undefined;
            if (!agentId) {
              return res.status(400).json({ error: 'Agent ID is required.' });
            }
            sessionManager.validateAgentName(agentId);
            if (inheritAgent === agentId) {
              return res.status(400).json({ error: 'Agent cannot inherit from itself.' });
            }
            if (inheritAgent && sessionManager.getAgentMetadata(inheritAgent).isolated) {
              return res.status(400).json({ error: `Agent "${inheritAgent}" is isolated and cannot be used as an inherit source.` });
            }

            const result = await sessionManager.createAgentWithMainSession({
              agentName: agentId,
              inherit: inheritAgent,
              createMainSession: true,
            });
            const session = await sessionManager.getExistingSession(result.mainSessionId);
            if (session) {
              const rootSiblings = getWebUiSidebarSiblings(null, session.id);
              writeWebUiSidebarOrder([session, ...rootSiblings]);
              await sessionManager.saveSessionsMetadata();
            }
            this.broadcastSessionListUpdate();
            res.status(201).json({ success: true, agentId, sessionId: result.mainSessionId });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to create agent');
            const message = e instanceof Error ? e.message : String(e);
            const code = typeof e?.code === 'string' ? e.code : undefined;
            const status = code === sessionManager.ARCHIVED_SESSION_ID_ERROR_CODE || /already exists/i.test(message) ? 409 : 400;
            res.status(status).json({ error: message, ...(code ? { code } : {}) });
          }
        },
      });

      // Get all sessions
      httpServerInstance.addRoute({
        path: '/api/sessions',
        method: 'GET',
        handler: async (_req: express.Request, res: express.Response) => {
          try {
            const allSessions = sessionManager.getAllSessions();
            
            // Build parent-to-children map
            const childrenMap = buildChildrenMap(allSessions);
            
            const sessions = Array.from(allSessions.entries())
              .map(([id, session]) => ({
                ...buildWebUiSessionState(session),
                messageCount: session.meta?.messageCount ?? session.history.length,
                lastMessageTime: session.meta?.lastMessageTime ?? (session.history.length > 0 
                  ? session.history[session.history.length - 1].__meta?.timestamp || 0
                  : 0),
                parentSessionId: session.parentSessionId || null,
                childSessions: childrenMap.get(id) || [],
                pinned: session.pinned || false,
                sidebarOrder: getWebUiSidebarOrder(session) ?? null,
                tokenUsage: {
                  cachedTokens: session.stats?.totalCachedTokens || 0,
                  inputTokens: session.stats?.totalInputTokens || 0,
                  outputTokens: session.stats?.totalOutputTokens || 0,
                },
              }))
              .sort((a, b) => b.lastMessageTime - a.lastMessageTime); // Sort by lastMessageTime descending
            res.json({ sessions });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get sessions');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const agentId = typeof req.body?.agentId === 'string' && req.body.agentId.trim()
              ? req.body.agentId.trim()
              : 'main';
            const requestedSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
            sessionManager.validateAgentName(agentId);

            let sessionId: string;
            if (agentId === 'main' && !requestedSessionId) {
              const result = await sessionManager.createEmptySession();
              if (!result.created) {
                return res.status(409).json({ error: 'Session already exists', sessionId: result.session.id });
              }
              sessionId = result.session.id;
            } else {
              if (requestedSessionId) {
                sessionManager.validateSessionName(requestedSessionId);
              }
              const result = await sessionManager.createSessionInAgent({
                agentName: agentId,
                ...(requestedSessionId ? { sessionName: requestedSessionId } : {}),
              });
              sessionId = result.sessionId;
            }

            const session = await sessionManager.getExistingSession(sessionId);
            if (!session) throw new Error(`Created session "${sessionId}" could not be loaded.`);
            const rootSiblings = getWebUiSidebarSiblings(null, session.id);
            writeWebUiSidebarOrder([session, ...rootSiblings]);
            await sessionManager.saveSessionsMetadata();

            this.broadcastSessionListUpdate();

            res.json({
              success: true,
              sessionId,
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to create session');
            const message = e instanceof Error ? e.message : String(e);
            const code = typeof e?.code === 'string' ? e.code : undefined;
            const status = code === sessionManager.ARCHIVED_SESSION_ID_ERROR_CODE || /already exists/i.test(message)
              ? 409
              : /does not exist|invalid/i.test(message) ? 400 : 500;
            res.status(status).json({ error: message, ...(code ? { code } : {}) });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/cwd',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
            const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd : undefined;
            const result = await sessionManager.setSessionCwd(sessionId, cwd);
            this.broadcastSessionListUpdate();
            res.json({
              success: true,
              changed: result.changed,
              previous: result.previous || null,
              cwd: result.current || null,
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to update session cwd');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/model',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
            const session = await sessionManager.getExistingSession(sessionId);
            if (!session) {
              return res.status(404).json({ error: 'Session not found' });
            }

            const model = req.body?.clear === true ? undefined : normalizeWebUiModelSelection(req.body?.model);
            if (model !== undefined) {
              session.model = model;
            } else {
              delete session.model;
            }

            await sessionManager.saveSession(session.id);
            this.broadcastSessionListUpdate();
            res.json({ success: true, sessionId: session.id, ...buildWebUiModelStatus(session) });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to update session model');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/child-model',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
            const session = await sessionManager.getExistingSession(sessionId);
            if (!session) {
              return res.status(404).json({ error: 'Session not found' });
            }

            const model = req.body?.clear === true ? undefined : normalizeWebUiModelSelection(req.body?.model);
            await sessionManager.setSessionChildModelDefault(session.id, model);
            const updated = await sessionManager.getExistingSession(session.id) || session;
            this.broadcastSessionListUpdate();
            res.json({ success: true, sessionId: updated.id, ...buildWebUiModelStatus(updated) });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to update session child model');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/terminals',
        method: 'GET',
        handler: async (_req: express.Request, res: express.Response) => {
          try {
            const terminals = await listTerminalRecords();
            res.json({ terminals });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to list terminals');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/terminals',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const nodeId = typeof req.body?.nodeId === 'string' && req.body.nodeId.trim() ? req.body.nodeId.trim() : undefined;
            const cwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim() ? req.body.cwd.trim() : '';
            const cols = typeof req.body?.cols === 'number' ? req.body.cols : undefined;
            const rows = typeof req.body?.rows === 'number' ? req.body.rows : undefined;

            const terminal = await createTerminal({ nodeId, cwd, cols, rows });
            res.json({
              success: true,
              terminal,
              streamPath: '/api/terminals/stream',
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to create terminal');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/terminals/:terminalId',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const terminalId = Array.isArray(req.params.terminalId) ? req.params.terminalId[0] : req.params.terminalId;
            const terminal = await getTerminalRecord(terminalId);
            if (!terminal) {
              return res.status(404).json({ error: 'Terminal not found' });
            }
            res.json({ terminal });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get terminal');
            res.status(400).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/terminals/:terminalId',
        method: 'DELETE',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const terminalId = Array.isArray(req.params.terminalId) ? req.params.terminalId[0] : req.params.terminalId;
            await closeTerminal(terminalId, 'api-delete');
            res.json({ success: true });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to close terminal');
            res.status(400).json({ error: e.message });
          }
        },
      });

      // Get agents tree (for multi-agent dashboard)
      httpServerInstance.addRoute({
        path: '/api/agents/tree',
        method: 'GET',
        handler: async (_req: express.Request, res: express.Response) => {
          try {
            const allSessions = sessionManager.getAllSessions();

            const childrenMap = buildChildrenMap(allSessions);
            
            // Build tree structure
            const agents = Array.from(allSessions.entries()).map(([id, session]) => ({
              id,
              displayName: session.displayName || id,
              busy: session.busy || false,
              queueLength: session.queue?.length || 0,
              parentSessionId: session.parentSessionId || null,
              childSessions: childrenMap.get(id) || [],
              messageCount: session.meta?.messageCount ?? session.history.length,
              lastMessageTime: session.meta?.lastMessageTime ?? 0,
              archived: session.archived || false
            }));
            
            // Build root agents (no parent)
            const rootAgents = agents.filter(a => !a.parentSessionId);
            
            res.json({ agents, rootAgents: rootAgents.map(a => a.id) });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get agents tree');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Get session history (must be before DELETE /:sessionId)

      httpServerInstance.addRoute({
        path: '/api/blobs/:blobId',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const blobId = req.params.blobId as string;
            const blobPath = resolveImageBlobPath(blobId);
            const stat = await fs.stat(blobPath);
            if (!stat.isFile()) return res.status(404).json({ error: 'Image blob not found' });
            const safeMimeType = getSafeRasterMimeType(blobId);
            res.setHeader('Content-Type', safeMimeType || 'application/octet-stream');
            res.setHeader('Content-Length', String(stat.size));
            res.setHeader('ETag', `"${blobId}"`);
            res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (!safeMimeType) {
              res.setHeader('Content-Disposition', `attachment; filename="${blobId}"`);
            }
            await new Promise<void>((resolve, reject) => {
              const stream = fs.createReadStream(blobPath);
              stream.on('error', reject);
              res.on('finish', resolve);
              res.on('close', resolve);
              stream.pipe(res);
            });
          } catch (e: any) {
            if (e?.code === 'ENOENT') return res.status(404).json({ error: 'Image blob not found' });
            if (e?.message === 'Invalid image blob id.') return res.status(400).json({ error: e.message });
            logger.error({ err: e }, 'Failed to serve image blob');
            if (!res.headersSent) res.status(500).json({ error: 'Failed to serve image blob' });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/debug-file',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            await sessionManager.getExistingSession(sessionId);
            const resolvedPath = getSessionHistoryFilePath(sessionId);
            if (!await fs.pathExists(resolvedPath)) {
              return res.status(404).json({ error: 'Session file not found' });
            }
            const payload = await fs.readJson(resolvedPath);
            res.json({ resolvedPath, payload: await sanitizeWebUiDebugPayload(payload) });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to read session debug file');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/state',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const session = await sessionManager.getExistingSession(sessionId);
            if (!session) {
              return res.status(404).json({ error: 'Session not found' });
            }
            res.json({ session: buildWebUiSessionState(session) });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get session state');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/history',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const session = await sessionManager.getExistingSession(sessionId);
            if (!session) {
              return res.status(404).json({ error: 'Session not found' });
            }
            const queuedMessages = buildQueuedPreviewMessages(session.queue);
            const webUiHistory = await materializeWebUiMessages(session.history);
            if (webUiHistory.changed) {
              session.history = webUiHistory.canonicalMessages;
              await sessionManager.saveSession(session.id);
            }
            res.json({
              session: buildWebUiSessionState(session),
              messages: webUiHistory.messages,
              persistentMemorySnapshot: session.persistentMemorySnapshot || '',
              queuedMessages,
              queueLength: session.queue?.length || 0,
              queuedPreviewLimit: MAX_QUEUED_PREVIEW_ITEMS,
              queuedPreviewOmittedCount: Math.max(0, (session.queue?.length || 0) - queuedMessages.length),
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get history');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/context-blocks/:blockId/expand',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const blockId = Number(req.params.blockId);
            if (!Number.isInteger(blockId) || blockId <= 0) {
              return res.status(400).json({ error: 'blockId must be a positive integer.', code: 'INVALID_CONTEXT_BLOCK_ID' });
            }

            const result = await renderContextBlockExpansion({
              sessionId,
              blockId,
              previewLength: parseOptionalPositiveNumberQuery(req.query.previewLength, 'previewLength'),
            });
            const webUiMessages = await materializeWebUiMessages(result.messages);
            res.json({
              ...result,
              messages: webUiMessages.messages,
              items: result.items.map((item, index) => ({ ...item, message: webUiMessages.messages[index] })),
            });
          } catch (e: any) {
            const statusCode = typeof e?.statusCode === 'number' ? e.statusCode : (e?.message?.includes('must be') ? 400 : 500);
            if (statusCode >= 500) {
              logger.error({ err: e }, 'Failed to expand context block');
            }
            res.status(statusCode).json({ error: e?.message || 'Failed to expand context block', code: e?.code || 'CTX_BLOCK_EXPANSION_FAILED' });
          }
        },
      });

      // Update session display name
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/name',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const { name } = req.body;
            const session = await sessionManager.getExistingSession(sessionId);

            if (!session) {
              return res.status(404).json({ error: 'Session not found' });
            }

            if (typeof name === 'string' && name.trim()) {
              session.displayName = name.trim();
            } else {
              session.displayName = undefined;
            }

            await sessionManager.saveSession(session.id);

            this.broadcastSessionListUpdate();

            res.json({
              success: true,
              sessionId: session.id,
              displayName: session.displayName || null,
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to update session display name');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Pin/unpin a session in the WebUI list without touching per-session history.
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/pin',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const session = await sessionManager.getExistingSession(sessionId);

            if (!session) {
              return res.status(404).json({ error: 'Session not found' });
            }

            if (typeof req.body?.pinned !== 'boolean') {
              return res.status(400).json({ error: 'pinned must be a boolean' });
            }

            if (req.body.pinned) {
              session.pinned = true;
            } else {
              delete session.pinned;
            }

            await sessionManager.saveSessionsMetadata();
            this.broadcastSessionListUpdate();
            res.json({ success: true, sessionId: session.id, pinned: !!session.pinned });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to update session pin state');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Archive/unarchive session (must be before DELETE /:sessionId)
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/archive',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const requestedSessionId = req.params.sessionId as string;
            const session = await sessionManager.getExistingSession(requestedSessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            const archived = req.body?.archived !== false;
            const includeDescendants = archived && req.body?.includeDescendants === true;
            const targetSessionIds = [session.id];
            if (includeDescendants) {
              targetSessionIds.push(...sessionManager.collectSessionDescendants(session.id).descendantIds);
            }
            const result = await sessionManager.archiveSessions(targetSessionIds, archived);

            this.broadcastSessionListUpdate();
            res.json({
              success: true,
              archived,
              includeDescendants,
              matchedCount: result.matchedSessionIds.length,
              changedCount: result.changedSessionIds.length,
              matchedSessionIds: result.matchedSessionIds,
              changedSessionIds: result.changedSessionIds,
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to archive session');
            const code = typeof e?.code === 'string' ? e.code : 'ARCHIVE_SESSION_FAILED';
            res.status(code === 'SESSION_RELATION_CYCLE' ? 409 : 500).json({ error: e.message, code });
          }
        },
      });

      // Fork session (must be before DELETE /:sessionId)
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/fork',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const { suffix } = req.body;
            
            const newSessionId = await sessionManager.forkSession(sessionId, suffix, false);
            
            // Broadcast session list update
            this.broadcastSessionListUpdate();
            
            res.json({ success: true, newSessionId });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to fork session');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Move/reorder a session in the WebUI sidebar tree. This powers drag-and-drop:
      // - parentSessionId: string => assign as a child of that session
      // - parentSessionId: null   => detach to root
      // - beforeSessionId/afterSessionId => reorder among siblings
      // - position: first/last => insert into a target sibling group without an anchor
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/move',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          const requestedSessionId = req.params.sessionId as string;
          const body = req.body || {};

          try {
            const movingSession = await sessionManager.getExistingSession(requestedSessionId);
            if (!movingSession) {
              res.status(404).json({
                error: `Session "${requestedSessionId}" was not found, so it cannot be moved.`,
                code: 'SESSION_NOT_FOUND',
                sessionId: requestedSessionId,
              });
              return;
            }

            const beforeSessionId = await resolveOptionalSessionId(body.beforeSessionId, 'beforeSessionId');
            const afterSessionId = await resolveOptionalSessionId(body.afterSessionId, 'afterSessionId');

            if (beforeSessionId && afterSessionId) {
              res.status(400).json({
                error: 'Specify either beforeSessionId or afterSessionId, not both.',
                code: 'MULTIPLE_MOVE_ANCHORS',
                sessionId: movingSession.id,
              });
              return;
            }

            const updateOrder = body.updateOrder !== false;
            const requestedPosition = body.position === undefined || body.position === null || body.position === ''
              ? undefined
              : body.position;
            if (requestedPosition !== undefined && requestedPosition !== 'first' && requestedPosition !== 'last') {
              res.status(400).json({
                error: 'position must be either "first" or "last" when provided.',
                code: 'INVALID_MOVE_POSITION',
                sessionId: movingSession.id,
                position: requestedPosition,
              });
              return;
            }

            if (requestedPosition !== undefined && (beforeSessionId || afterSessionId)) {
              res.status(400).json({
                error: 'position cannot be combined with beforeSessionId or afterSessionId.',
                code: 'POSITION_WITH_ANCHOR_NOT_ALLOWED',
                sessionId: movingSession.id,
              });
              return;
            }

            if (!updateOrder && (requestedPosition !== undefined || beforeSessionId || afterSessionId)) {
              res.status(400).json({
                error: 'updateOrder=false can only be used for parent-only moves.',
                code: 'ORDER_ANCHOR_WITH_UPDATE_ORDER_DISABLED',
                sessionId: movingSession.id,
              });
              return;
            }

            const anchorSessionId = beforeSessionId || afterSessionId || null;
            if (anchorSessionId === movingSession.id) {
              res.status(400).json({
                error: 'A session cannot be reordered relative to itself.',
                code: 'SELF_ANCHOR_NOT_ALLOWED',
                sessionId: movingSession.id,
              });
              return;
            }

            const anchorSession = anchorSessionId
              ? await sessionManager.getExistingSession(anchorSessionId)
              : null;

            const parentProvided = Object.prototype.hasOwnProperty.call(body, 'parentSessionId');
            const requestedParentSessionId = parentProvided
              ? await resolveOptionalSessionId(body.parentSessionId, 'parentSessionId')
              : undefined;
            const anchorParentSessionId = anchorSession ? getSessionTreeParentId(anchorSession) : null;
            const targetParentSessionId = requestedParentSessionId !== undefined
              ? requestedParentSessionId
              : anchorSession
                ? anchorParentSessionId
                : getSessionTreeParentId(movingSession);

            if (anchorSession && anchorParentSessionId !== targetParentSessionId) {
              res.status(400).json({
                error: `Move anchor "${anchorSession.id}" is not in the requested target parent group.`,
                code: 'ANCHOR_PARENT_MISMATCH',
                sessionId: movingSession.id,
                anchorSessionId: anchorSession.id,
                anchorParentSessionId,
                targetParentSessionId,
              });
              return;
            }

            await assertNoSidebarParentCycle(movingSession.id, targetParentSessionId);

            const previousParentSessionId = getSessionTreeParentId(movingSession);
            if (previousParentSessionId !== targetParentSessionId) {
              await sessionManager.setSessionParent(movingSession.id, targetParentSessionId || undefined);
            }

            const latestMovingSession = await sessionManager.getExistingSession(movingSession.id);
            if (!latestMovingSession) {
              res.status(404).json({
                error: `Session "${movingSession.id}" disappeared while moving.`,
                code: 'SESSION_NOT_FOUND_AFTER_PARENT_UPDATE',
                sessionId: movingSession.id,
              });
              return;
            }

            if (!updateOrder) {
              this.broadcastSessionListUpdate();
              res.json({
                success: true,
                sessionId: latestMovingSession.id,
                parentSessionId: getSessionTreeParentId(latestMovingSession),
                previousParentSessionId,
                beforeSessionId: null,
                afterSessionId: null,
                sidebarOrder: getWebUiSidebarOrder(latestMovingSession) || null,
              });
              return;
            }

            if (previousParentSessionId !== targetParentSessionId) {
              writeWebUiSidebarOrder(getWebUiSidebarSiblings(previousParentSessionId, latestMovingSession.id));
            }

            const targetSiblingsWithoutMoving = getWebUiSidebarSiblings(targetParentSessionId, latestMovingSession.id);
            let insertIndex = requestedPosition === 'last' ? targetSiblingsWithoutMoving.length : 0;

            if (beforeSessionId) {
              const beforeIndex = targetSiblingsWithoutMoving.findIndex(session => session.id === beforeSessionId);
              if (beforeIndex < 0) {
                res.status(400).json({
                  error: `beforeSessionId "${beforeSessionId}" is not a sibling in the target group.`,
                  code: 'BEFORE_ANCHOR_NOT_IN_TARGET_GROUP',
                  sessionId: latestMovingSession.id,
                  beforeSessionId,
                  targetParentSessionId,
                });
                return;
              }
              insertIndex = beforeIndex;
            } else if (afterSessionId) {
              const afterIndex = targetSiblingsWithoutMoving.findIndex(session => session.id === afterSessionId);
              if (afterIndex < 0) {
                res.status(400).json({
                  error: `afterSessionId "${afterSessionId}" is not a sibling in the target group.`,
                  code: 'AFTER_ANCHOR_NOT_IN_TARGET_GROUP',
                  sessionId: latestMovingSession.id,
                  afterSessionId,
                  targetParentSessionId,
                });
                return;
              }
              insertIndex = afterIndex + 1;
            }

            const targetSiblings = [...targetSiblingsWithoutMoving];
            targetSiblings.splice(Math.max(0, Math.min(insertIndex, targetSiblings.length)), 0, latestMovingSession);
            writeWebUiSidebarOrder(targetSiblings);

            await sessionManager.saveSessionsMetadata();
            this.broadcastSessionListUpdate();

            res.json({
              success: true,
              sessionId: latestMovingSession.id,
              parentSessionId: getSessionTreeParentId(latestMovingSession),
              previousParentSessionId,
              beforeSessionId: beforeSessionId || null,
              afterSessionId: afterSessionId || null,
              sidebarOrder: getWebUiSidebarOrder(latestMovingSession) || null,
            });
          } catch (e: any) {
            const statusCode = typeof e?.statusCode === 'number' ? e.statusCode : 500;
            const code = typeof e?.code === 'string' ? e.code : 'MOVE_SESSION_FAILED';
            if (statusCode >= 500) {
              logger.error({ err: e, sessionId: requestedSessionId }, 'Failed to move session in WebUI sidebar');
            } else {
              logger.warn({ sessionId: requestedSessionId, statusCode, code, reason: e?.message }, 'Rejected WebUI sidebar session move');
            }
            res.status(statusCode).json({
              error: e?.message || 'Failed to move session.',
              code,
              sessionId: requestedSessionId,
            });
          }
        },
      });

      // Promote session (move up one level or detach from parent, making it a root session)
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/promote',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          const sessionId = req.params.sessionId as string;
          const targetParentId = typeof req.body?.targetParentId === 'string' && req.body.targetParentId.trim()
            ? req.body.targetParentId.trim()
            : undefined;
          const operation = targetParentId ? 'move-up' : 'promote-to-root';

          try {
            const childSession = await sessionManager.getExistingSession(sessionId);
            if (!childSession) {
              res.status(404).json({
                error: `Session "${sessionId}" was not found, so it cannot be promoted.`,
                code: 'SESSION_NOT_FOUND',
                operation,
                sessionId,
                targetParentId: targetParentId || null,
              });
              return;
            }

            let targetParentBusy: boolean | undefined;
            if (targetParentId) {
              const targetParentSession = await sessionManager.getExistingSession(targetParentId);
              if (!targetParentSession) {
                res.status(404).json({
                  error: `Target parent session "${targetParentId}" was not found, so session "${childSession.id}" cannot be moved there.`,
                  code: 'TARGET_PARENT_NOT_FOUND',
                  operation,
                  sessionId: childSession.id,
                  previousParentSessionId: childSession.parentSessionId || null,
                  targetParentId,
                  sessionBusy: !!childSession.busy,
                });
                return;
              }

              targetParentBusy = !!targetParentSession.busy;

              if (targetParentSession.id === childSession.id) {
                res.status(400).json({
                  error: 'A session cannot be moved under itself.',
                  code: 'SELF_PARENT_NOT_ALLOWED',
                  operation,
                  sessionId: childSession.id,
                  previousParentSessionId: childSession.parentSessionId || null,
                  targetParentId: targetParentSession.id,
                  sessionBusy: !!childSession.busy,
                  targetParentBusy,
                });
                return;
              }

              // Defensive guard for API callers: the WebUI only sends a grandparent here,
              // but arbitrary targetParentId values must not be allowed to create cycles.
              const seenAncestors = new Set<string>([childSession.id]);
              let cursorParentId = targetParentSession.parentSessionId || undefined;
              while (cursorParentId) {
                if (seenAncestors.has(cursorParentId)) {
                  res.status(400).json({
                    error: `Session "${childSession.id}" cannot be moved under descendant "${targetParentSession.id}" because that would create a parent cycle.`,
                    code: 'PARENT_CYCLE_NOT_ALLOWED',
                    operation,
                    sessionId: childSession.id,
                    previousParentSessionId: childSession.parentSessionId || null,
                    targetParentId: targetParentSession.id,
                    sessionBusy: !!childSession.busy,
                    targetParentBusy,
                  });
                  return;
                }
                seenAncestors.add(cursorParentId);
                const cursorParent = await sessionManager.getExistingSession(cursorParentId);
                if (!cursorParent) break;
                cursorParentId = cursorParent.parentSessionId || undefined;
              }
            }

            const result = await sessionManager.setSessionParent(sessionId, targetParentId);
            const movedSession = await sessionManager.getExistingSession(result.childSessionId);

            if (movedSession) {
              const previousParentSessionId = result.previousParentSessionId || null;
              const nextParentSessionId = result.parentSessionId || null;

              if (previousParentSessionId !== nextParentSessionId) {
                writeWebUiSidebarOrder(getWebUiSidebarSiblings(previousParentSessionId, movedSession.id));
              }

              const targetSiblingsWithoutMoving = getWebUiSidebarSiblings(nextParentSessionId, movedSession.id);
              const previousParentIndex = result.previousParentSessionId
                ? targetSiblingsWithoutMoving.findIndex(session => session.id === result.previousParentSessionId)
                : -1;
              const insertIndex = previousParentIndex >= 0 ? previousParentIndex + 1 : 0;
              const targetSiblings = [...targetSiblingsWithoutMoving];
              targetSiblings.splice(insertIndex, 0, movedSession);
              writeWebUiSidebarOrder(targetSiblings);
            }

            await sessionManager.saveSessionsMetadata();

            this.broadcastSessionListUpdate();

            res.json({
              success: true,
              operation,
              sessionId: result.childSessionId,
              parentSessionId: result.parentSessionId || null,
              previousParentSessionId: result.previousParentSessionId || null,
              targetParentId: result.parentSessionId || null,
              sidebarOrder: movedSession ? getWebUiSidebarOrder(movedSession) || null : null,
              sessionBusy: !!childSession.busy,
              targetParentBusy,
            });
          } catch (e: any) {
            const reason = e?.message || 'Unknown backend error';
            logger.error({ err: e, sessionId, targetParentId, operation }, 'Failed to promote session');
            res.status(500).json({
              error: `Could not ${targetParentId ? 'move session up one level' : 'promote session to root'}: ${reason}`,
              reason,
              code: 'PROMOTE_FAILED',
              operation,
              sessionId,
              targetParentId: targetParentId || null,
            });
          }
        },
      });

      // Delete session (must be after specific routes like /archive, /fork, /history)
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId',
        method: 'DELETE',
        handler: async (req: express.Request, res: express.Response) => {
          const requestedSessionId = req.params.sessionId as string;
          const includeDescendants = req.body?.includeDescendants === true;
          let deleteClaimId: string | undefined;
          try {
            const rootSession = await sessionManager.getExistingSession(requestedSessionId);
            if (!rootSession) return res.status(404).json({ error: 'Session not found' });

            const relationTree = includeDescendants
              ? sessionManager.collectSessionDescendants(rootSession.id)
              : undefined;
            const directChildSessionIds = relationTree?.directChildIds
              || sessionManager.getCanonicalChildSessionIds(rootSession.id);
            const targetSessionIds = relationTree
              ? [rootSession.id, ...relationTree.descendantIds]
              : [rootSession.id];
            const postOrderSessionIds = relationTree?.postOrderIds || [rootSession.id];
            const claimSessionIds = includeDescendants
              ? targetSessionIds
              : [rootSession.id, ...directChildSessionIds];
            deleteClaimId = (await sessionManager.claimSessionsForDestructiveLifecycle(claimSessionIds)).claimId;

            const channelBlockers = targetSessionIds.flatMap(sessionId => sessionManager
              .getChannelsBySession(sessionId)
              .filter(channel => channel.channelId !== 'webui')
              .map(channel => ({ sessionId, ...channel })));

            if (channelBlockers.length > 0) {
              return res.status(409).json({
                error: 'Cannot delete session tree while one or more sessions have non-WebUI channels attached. Detach those channels and retry.',
                code: 'SESSION_DELETE_CHANNEL_BLOCKED',
                includeDescendants,
                blockingSessionIds: [...new Set(channelBlockers.map(blocker => blocker.sessionId))],
                blockingChannels: channelBlockers,
              });
            }

            const prepResults = [];
            for (const sessionId of targetSessionIds) {
              prepResults.push(await sessionManager.prepareSessionForDestructiveAction(sessionId));
            }
            const busySessionIds = prepResults
              .filter(result => result.requiresRetry)
              .map(result => result.session.id);
            if (busySessionIds.length > 0) {
              const droppedQueueItems = prepResults.reduce((sum, result) => sum + result.droppedQueueItems, 0);
              const abortedInFlightCount = prepResults.filter(result => result.abortedInFlight).length;
              const queueNote = droppedQueueItems > 0
                ? ` Cleared ${droppedQueueItems} queued item(s).`
                : '';
              const stopNote = abortedInFlightCount > 0
                ? ` Aborted ${abortedInFlightCount} in-flight LLM request(s); other running tools will stop after their current call.`
                : ' Running tools will stop after their current call.';
              return res.status(409).json({
                error: `Session tree contains busy sessions. Stop signals sent.${stopNote}${queueNote} Retry delete after every listed session becomes idle.`,
                code: 'SESSION_DELETE_BUSY',
                includeDescendants,
                busySessionIds,
                droppedQueueItems,
                abortedInFlightCount,
              });
            }

            await webUiDeleteLifecycleTestHook?.({
              rootSessionId: rootSession.id,
              includeDescendants,
              targetSessionIds: [...targetSessionIds],
            });

            const currentRootSession = await sessionManager.getExistingSession(rootSession.id);
            if (!currentRootSession) {
              return res.status(409).json({
                error: 'The session tree changed while preparing deletion. Retry the delete request.',
                code: 'SESSION_DELETE_TREE_CHANGED',
                includeDescendants,
              });
            }
            const currentRelationTree = includeDescendants
              ? sessionManager.collectSessionDescendants(currentRootSession.id)
              : undefined;
            const currentDirectChildSessionIds = currentRelationTree?.directChildIds
              || sessionManager.getCanonicalChildSessionIds(currentRootSession.id);
            const currentTargetSessionIds = currentRelationTree
              ? [currentRootSession.id, ...currentRelationTree.descendantIds]
              : [currentRootSession.id];
            const currentPostOrderSessionIds = currentRelationTree?.postOrderIds || [currentRootSession.id];
            if (!haveSameSessionIds(currentTargetSessionIds, targetSessionIds)
              || !haveSameSessionIds(currentPostOrderSessionIds, postOrderSessionIds)
              || !haveSameSessionIds(currentDirectChildSessionIds, directChildSessionIds)) {
              return res.status(409).json({
                error: 'The canonical session tree changed while preparing deletion. Retry the delete request.',
                code: 'SESSION_DELETE_TREE_CHANGED',
                includeDescendants,
                expectedSessionIds: targetSessionIds,
                currentSessionIds: currentTargetSessionIds,
              });
            }

            const revalidatedChannelBlockers = targetSessionIds.flatMap(sessionId => sessionManager
              .getChannelsBySession(sessionId)
              .filter(channel => channel.channelId !== 'webui')
              .map(channel => ({ sessionId, ...channel })));
            const revalidatedBusySessionIds = targetSessionIds.filter(sessionId => sessionManager.getAllSessions().get(sessionId)?.busy);
            const revalidatedQueuedSessionIds = targetSessionIds.filter(sessionId => (sessionManager.getAllSessions().get(sessionId)?.queue?.length || 0) > 0);
            if (revalidatedChannelBlockers.length > 0 || revalidatedBusySessionIds.length > 0 || revalidatedQueuedSessionIds.length > 0) {
              return res.status(409).json({
                error: 'The session tree became active or channel-blocked while preparing deletion. Retry the delete request.',
                code: 'SESSION_DELETE_STATE_CHANGED',
                includeDescendants,
                blockingSessionIds: [...new Set(revalidatedChannelBlockers.map(blocker => blocker.sessionId))],
                blockingChannels: revalidatedChannelBlockers,
                busySessionIds: revalidatedBusySessionIds,
                queuedSessionIds: revalidatedQueuedSessionIds,
              });
            }

            const detachedChildSessionIds: string[] = [];
            if (!includeDescendants) {
              for (const childSessionId of directChildSessionIds) {
                if (!sessionManager.getAllSessions().has(childSessionId)) continue;
                try {
                  await sessionManager.setSessionParent(childSessionId, undefined, deleteClaimId);
                  detachedChildSessionIds.push(childSessionId);
                } catch (error: any) {
                  this.broadcastSessionListUpdate();
                  return res.status(500).json({
                    error: `Session "${rootSession.id}" was not deleted because surviving child "${childSessionId}" could not be detached: ${error?.message || error}`,
                    code: 'SESSION_DELETE_DETACH_PARTIAL',
                    includeDescendants,
                    deletedSessionIds: [],
                    failedDetachChildSessionId: childSessionId,
                    detachedChildSessionIds,
                  });
                }
              }
            }

            const deletedSessionIds: string[] = [];
            for (const sessionId of postOrderSessionIds) {
              try {
                const deleted = await sessionManager.deleteSession(sessionId, deleteClaimId);
                if (!deleted) throw new Error(`Session "${sessionId}" disappeared before deletion.`);
                deletedSessionIds.push(sessionId);
              } catch (error: any) {
                this.broadcastSessionListUpdate();
                return res.status(500).json({
                  error: `Session tree deletion stopped after an unexpected failure at "${sessionId}": ${error?.message || error}`,
                  code: 'SESSION_TREE_DELETE_PARTIAL',
                  includeDescendants,
                  failedSessionId: sessionId,
                  deletedSessionIds,
                  remainingSessionIds: postOrderSessionIds.filter(id => sessionManager.getAllSessions().has(id)),
                });
              }
            }

            this.broadcastSessionListUpdate();
            res.json({
              success: true,
              includeDescendants,
              deletedCount: deletedSessionIds.length,
              deletedSessionIds,
              detachedChildSessionIds,
            });
          } catch (e: any) {
            logger.error({ err: e, requestedSessionId, includeDescendants }, 'Failed to delete session');
            const code = typeof e?.code === 'string' ? e.code : 'DELETE_SESSION_FAILED';
            const status = typeof e?.statusCode === 'number'
              ? e.statusCode
              : code === 'SESSION_RELATION_CYCLE' ? 409 : 500;
            res.status(status).json({ error: e.message, code });
          } finally {
            if (deleteClaimId) sessionManager.releaseSessionsForDestructiveLifecycle(deleteClaimId);
          }
        },
      });

      // SSE endpoint for real-time updates
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/stream',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          const requestedSessionId = req.params.sessionId as string;

          // Check token from cookie or query parameter
          if (!httpServer.checkToken(req)) {
            logger.warn('SSE token validation failed');
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }

          const session = await sessionManager.getExistingSession(requestedSessionId);
          if (!session) {
            res.status(404).json({ error: 'Session not found' });
            return;
          }
          const sessionId = session.id;
          
          // Set SSE headers
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
          res.flushHeaders(); // Flush headers immediately
          
          // Add client to list
          if (!this.sseClients.has(sessionId)) {
            this.sseClients.set(sessionId, []);
          }
          this.sseClients.get(sessionId)!.push(res);
          
          // logger.info({ sessionId, clientCount: this.sseClients.get(sessionId)!.length }, 'SSE client connected');
          
          // Preserve the existing connection acknowledgement, then send a
          // canonical state snapshot after registration. Browser Chat starts
          // history only after this registered stream opens, so live state and
          // post-request messages take precedence over an older snapshot.
          res.write('data: {"type":"connected"}\n\n');
          const initialState = JSON.stringify({ type: 'session-state', session: buildWebUiSessionState(session) });
          res.write(`data: ${initialState}\n\n`);
          
          // Keep-alive ping every 30 seconds
          const keepAliveInterval = setInterval(() => {
            try {
              res.write(': keep-alive\n\n');
            } catch (e) {
              clearInterval(keepAliveInterval);
            }
          }, 30000);
          
          // Remove client on disconnect
          req.on('close', () => {
            clearInterval(keepAliveInterval);
            const clients = this.sseClients.get(sessionId);
            if (clients) {
              const index = clients.indexOf(res);
              if (index !== -1) {
                clients.splice(index, 1);
              }
              if (clients.length === 0) {
                this.sseClients.delete(sessionId);
              }
            }
            // logger.info({ sessionId }, 'SSE client disconnected');
          });
          
        }
      });

      // Global SSE endpoint for session list updates
      httpServerInstance.addRoute({
        path: '/api/sessions/stream',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          // Check token
          if (!httpServer.checkToken(req)) {
            logger.warn('Global SSE token validation failed');
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }
          
          // Set SSE headers
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
          
          // Add to global clients
          this.globalSseClients.push(res);
          
          // Send initial ping
          res.write('data: {"type":"connected"}\n\n');
          
          // Keep-alive ping
          const keepAliveInterval = setInterval(() => {
            try {
              res.write(': keep-alive\n\n');
            } catch (e) {
              clearInterval(keepAliveInterval);
            }
          }, 30000);
          
          // Remove on disconnect
          req.on('close', () => {
            clearInterval(keepAliveInterval);
            const index = this.globalSseClients.indexOf(res);
            if (index !== -1) {
              this.globalSseClients.splice(index, 1);
            }
          });
          
          res;
        },
      });

      // Upload file
      httpServerInstance.addRoute({
        path: '/api/upload',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const multer = require('multer');
            const os = require('os');
            const crypto = require('crypto');
            
            // Setup multer for file upload
            const upload = multer({
              dest: path.join(os.tmpdir(), 'foxwarm-uploads'),
              limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
            });
            
            // Ensure upload directory exists
            await fs.ensureDir(path.join(os.tmpdir(), 'foxwarm-uploads'));
            
            // Handle upload
            upload.single('file')(req, res, async (err: any) => {
              if (err) {
                res.status(400).json({ error: err.message });
                return;
              }
              
              if (!req.file) {
                res.status(400).json({ error: 'No file uploaded' });
                return;
              }
              
              // Generate unique filename
              const ext = path.extname(req.file.originalname);
              const filename = `${crypto.randomBytes(16).toString('hex')}${ext}`;
              const finalPath = path.join(os.tmpdir(), 'foxwarm-uploads', filename);
              
              // Move file to final path
              await fs.move(req.file.path, finalPath, { overwrite: true });
              
              logger.info({ filename, originalName: req.file.originalname, size: req.file.size }, 'File uploaded');
              
              res.json({ 
                path: finalPath,
                filename: req.file.originalname,
                mimeType: req.file.mimetype,
                size: req.file.size
              });
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Upload error');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/asr/status',
        method: 'GET',
        handler: async (_req: express.Request, res: express.Response) => {
          res.json(await getAsrServiceStatus());
        },
      });

      httpServerInstance.addRoute({
        path: '/api/asr/transcribe',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const multer = require('multer');
            const os = require('os');
            const uploadDir = path.join(os.tmpdir(), 'foxwarm-asr-proxy');

            await fs.ensureDir(uploadDir);

            const upload = multer({
              dest: uploadDir,
              limits: { fileSize: 25 * 1024 * 1024 },
            });

            upload.single('audio')(req, res, async (err: any) => {
              if (err) {
                res.status(400).json({ error: err.message });
                return;
              }

              if (!req.file) {
                res.status(400).json({ error: 'No audio uploaded' });
                return;
              }

              try {
                const fileBuffer = await fs.readFile(req.file.path);
                const result = await transcribeWithAsrService({
                  fileBuffer,
                  fileName: req.file.originalname || 'audio.wav',
                  mimeType: req.file.mimetype,
                  context: typeof req.body?.context === 'string' ? req.body.context : '',
                  language: typeof req.body?.language === 'string' ? req.body.language : '',
                  segmentSeconds: typeof req.body?.segmentSeconds === 'string' ? req.body.segmentSeconds : '',
                });

                res.status(result.status).json(result.body);
              } catch (proxyError: any) {
                logger.error({ err: proxyError }, 'ASR proxy error');
                res.status(502).json({ error: proxyError?.message || 'ASR proxy request failed' });
              } finally {
                await fs.remove(req.file.path).catch(() => {});
              }
            });
          } catch (e: any) {
            logger.error({ err: e }, 'ASR route error');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addWebSocket('/api/asr/stream', async (ws: WebSocket, req: http.IncomingMessage) => {
        if (!httpServerInstance.checkIncomingToken(req)) {
          ws.close(1008, 'Unauthorized');
          return;
        }

        const upstream = createAsrServiceWebSocket();
        if (!upstream) {
          ws.close(1011, 'ASR service is not configured');
          return;
        }

        const pendingMessages: Array<{ data: any; isBinary: boolean }> = [];
        let upstreamOpen = false;
        let closed = false;

        const closeBoth = (code?: number, reason?: string) => {
          if (closed) return;
          closed = true;
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(code, reason);
            }
          } catch {}
          try {
            if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
              upstream.close();
            }
          } catch {}
        };

        const forwardToUpstream = (data: any, isBinary: boolean) => {
          if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary: isBinary });
          } else {
            pendingMessages.push({ data, isBinary });
          }
        };

        upstream.on('open', () => {
          upstreamOpen = true;
          for (const pending of pendingMessages.splice(0)) {
            upstream.send(pending.data, { binary: pending.isBinary });
          }
        });

        upstream.on('message', (data, isBinary) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, { binary: isBinary });
          }
        });

        upstream.on('error', (error) => {
          logger.error({ err: error }, 'ASR upstream websocket error');
          closeBoth(1011, 'ASR upstream error');
        });

        upstream.on('close', (code, reason) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(code || 1000, reason.toString() || undefined);
          }
        });

        ws.on('message', (data, isBinary) => {
          forwardToUpstream(data, isBinary);
        });

        ws.on('close', () => {
          closeBoth();
        });

        ws.on('error', (error) => {
          logger.error({ err: error }, 'ASR client websocket error');
          closeBoth();
        });
      });

      httpServerInstance.addWebSocket('/api/terminals/stream', async (ws: WebSocket, req: http.IncomingMessage) => {
        if (!httpServerInstance.checkIncomingToken(req)) {
          ws.close(1008, 'Unauthorized');
          return;
        }

        const requestUrl = new URL(req.url || '/api/terminals/stream', 'http://localhost');
        const terminalId = requestUrl.searchParams.get('terminalId') || '';
        const codeControl = requestUrl.searchParams.get('control') === 'code';
        if (!terminalId) {
          ws.close(1008, 'Missing terminalId');
          return;
        }

        let attachedTerminalId = '';
        try {
          const { terminal, backlog } = await attachTerminalClient(terminalId, ws, { codeControl });
          attachedTerminalId = terminal.id;
          ws.send(JSON.stringify({
            type: 'ready',
            terminal,
            backlog,
          }));
        } catch (err: any) {
          ws.close(1008, err?.message || 'Failed to attach terminal');
          return;
        }

        ws.on('message', async (raw) => {
          try {
            const payload = JSON.parse(raw.toString());
            if (payload?.type === 'input' && typeof payload.data === 'string') {
              writeTerminalInput(attachedTerminalId, payload.data);
              return;
            }

            if (payload?.type === 'resize') {
              resizeTerminal(attachedTerminalId, Number(payload.cols || 0), Number(payload.rows || 0));
              return;
            }

            if (payload?.type === 'close') {
              await closeTerminal(attachedTerminalId, 'ws-close-message');
              return;
            }

            if (payload?.type === 'control-result') {
              resolveTerminalControlRequest(attachedTerminalId, ws, payload);
              return;
            }

            ws.send(JSON.stringify({ type: 'error', message: 'Unsupported terminal message type' }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Terminal stream error' }));
          }
        });

        ws.on('close', () => {
          detachTerminalClient(attachedTerminalId, ws);
        });

        ws.on('error', (error) => {
          logger.error({ err: error, terminalId: attachedTerminalId }, 'Terminal websocket client error');
          detachTerminalClient(attachedTerminalId, ws);
        });
      });

      // Send message
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/message',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const { text, parts, filePaths, uploadedFiles } = req.body;
            const clientMessageId = typeof req.body?.clientMessageId === 'string'
              && req.body.clientMessageId.length > 0
              && req.body.clientMessageId.length <= 160
              ? req.body.clientMessageId
              : undefined;

            const existingSession = await sessionManager.getExistingSession(sessionId);
            if (!existingSession) {
              return res.status(404).json({ error: 'Session not found' });
            }

            // Support both old format (text) and new format (parts)
            let finalParts = parts || (text ? [{ text }] : []);
            
            const ctx: ChannelContext = {
              channelId: 'webui',
              channelType: 'webui',
              channelUserId: sessionId, // Use sessionId as channelUserId (matches attachChannel)
              conversationId: sessionId,
              username: 'webui',
              platform: 'webui',
              reply: async (replyText: string) => {
                // Check if this is a command response by checking if message starts with /
                const messageText = (text || finalParts.map((p: any) => p.text || '').join('\n')).trim();
                const isCommand = messageText.startsWith('/');
                
                logger.debug({ sessionId, isCommand, replyLength: replyText.length }, 'WebUI reply called');
                
                if (isCommand) {
                  // Broadcast temporary command response (not saved to history)
                  this.broadcastMessage(sessionId, {
                    role: 'assistant',
                    parts: [{ text: replyText }],
                    __meta: {
                      timestamp: Date.now(),
                      channelUserId: sessionId,
                      username: 'webui',
                      platform: 'webui',
                      temporary: true, // Mark as temporary
                      isCommandResponse: true // Mark as command response to skip timestamp check
                    }
                  });
                  logger.debug({ sessionId }, 'Command response broadcasted');
                }
                
                // Don't call res.json() here - response already sent
              },
              sendTyping: async () => {}
            };

            const message: ChannelMessage = {
              parts: finalParts,
              channelUserId: sessionId, // Use sessionId as channelUserId
              conversationId: sessionId,
              username: 'webui',
              ...(clientMessageId ? { clientMessageId } : {}),
            };

            const uploadedEntries = Array.isArray(uploadedFiles)
              ? uploadedFiles
              : (Array.isArray(filePaths) ? filePaths.map((filePath) => ({ path: filePath })) : []);

            if (uploadedEntries.length > 0) {
              for (const entry of uploadedEntries) {
                const tempPath = typeof entry === 'string'
                  ? entry
                  : (typeof entry?.path === 'string' ? entry.path : '');
                if (!tempPath) continue;

                try {
                  const stats = await fs.stat(tempPath);
                  if (!stats.isFile()) continue;

                  const fileBuffer = await fs.readFile(tempPath);
                  const originalName = typeof entry?.filename === 'string' && entry.filename.trim()
                    ? entry.filename.trim()
                    : path.basename(tempPath);
                  const ext = path.extname(originalName || tempPath).toLowerCase();
                  const mimeType = typeof entry?.mimeType === 'string' && entry.mimeType.trim()
                    ? entry.mimeType.trim()
                    : (ext === '.png' ? 'image/png'
                      : ext === '.gif' ? 'image/gif'
                      : ext === '.webp' ? 'image/webp'
                      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                      : 'application/octet-stream');
                  const isImage = mimeType.startsWith('image/');
                  const saved = await saveInboundSessionFile({
                    sessionId,
                    platform: 'webui',
                    buffer: fileBuffer,
                    fileName: originalName,
                    mimeType,
                    isImage,
                  });

                  finalParts.push({ text: buildSavedFileText(saved, isImage ? 'image' : 'file') });

                  if (isImage) {
                    finalParts.push({
                      inlineData: {
                        data: fileBuffer.toString('base64'),
                        mimeType,
                      }
                    });
                  }
                } catch (err) {
                  logger.warn({ filePath: tempPath, err }, 'Failed to process uploaded file');
                } finally {
                  await fs.remove(tempPath).catch(() => {});
                }
              }
            }
            
            if (finalParts.length === 0) throw new Error('Missing message content');

            // Attach webui channel if not already attached
            // Use sessionId as channelUserId so each session has its own channel
            let existingSessionId = sessionManager.getSessionByChannel('webui', sessionId);
            if (!existingSessionId || existingSessionId !== sessionId) {
              sessionManager.attachChannel('webui', sessionId, sessionId);
            }

            // Return immediately - don't wait for processing
            res.json({ success: true, message: 'Message received' });

            // Let the router handle everything asynchronously (including commands)
            // Results will be sent via SSE
            this.router.handleMessage(ctx, message).catch(err => {
              logger.error({ err }, 'Error handling WebUI message');
            });
          } catch (e: any) {
            logger.error({ err: e }, 'WebUI message error');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Serve WebUI static files with authentication
      const webuiDistPath = path.join(BASE_DIR, 'packages', 'webui', 'dist');
      const loginPath = path.join(BASE_DIR, 'packages', 'webui', 'public', 'login.html');
      
      if (fs.existsSync(webuiDistPath)) {
        // Serve login.html without auth
        if (fs.existsSync(loginPath)) {
          httpServerInstance.addRoute({
            path: '/login.html',
            method: 'GET',
            noAuth: true,
            handler: async (_req: express.Request, res: express.Response) => {
              res.sendFile(loginPath);
            }
          });
        }
        
        // Protect all other static files
        httpServerInstance.app.use(this.staticAuthMiddleware);
        httpServerInstance.app.use(express.static(webuiDistPath));
        
        // Note: No SPA fallback route needed, using hash routing
      } else {
        logger.warn('WebUI dist folder not found, skipping static file serving');
      }

      logger.info('WebUI endpoints enabled');
    }

    // File download endpoint
    httpServerInstance.addRoute({
      path: '/download',
      method: 'GET',
      handler: async (req: express.Request, res: express.Response) => {
        // Check token
        if (!httpServer.checkToken(req)) {
          logger.warn('Download token validation failed');
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const filePath = req.query.path as string;
        if (!filePath) {
          res.status(400).json({ error: 'Missing path parameter' });
          return;
        }

        // Security: Ensure absolute path
        if (!path.isAbsolute(filePath)) {
          res.status(400).json({ error: 'Path must be absolute' });
          return;
        }

        // Check if file exists
        if (!fs.existsSync(filePath)) {
          res.status(404).json({ error: 'File not found' });
          return;
        }

        try {
          await this.streamPathDownload(filePath, res);
        } catch (err) {
          logger.error({ err, filePath }, 'Failed to send file download');
          if (!res.headersSent) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send download' });
          }
        }
      }
    });
  }

  // Broadcast new message to SSE clients
  broadcastMessage(sessionId: string, message: any) {
    const clients = this.sseClients.get(sessionId);
    logger.debug({ sessionId, clientCount: clients?.length || 0, messageRole: message.role }, 'Broadcasting message to SSE clients');
    if (clients && clients.length > 0) {
      const data = JSON.stringify({ type: 'message', message: buildWebUiMessage(message) });
      clients.forEach(client => {
        try {
          client.write(`data: ${data}\n\n`);
          logger.debug({ sessionId }, 'SSE message sent');
        } catch (e) {
          logger.error({ err: e }, 'Failed to send SSE message');
        }
      });
    }
  }

  broadcastSessionEvent(sessionId: string, event: any) {
    const clients = this.sseClients.get(sessionId);
    if (clients && clients.length > 0) {
      const data = JSON.stringify({ type: 'session-event', event });
      clients.forEach(client => {
        try {
          client.write(`data: ${data}\n\n`);
        } catch (e) {
          logger.error({ err: e }, 'Failed to send SSE session event');
        }
      });
    }
  }

  broadcastSessionStateUpdate(sessionId: string) {
    const clients = this.sseClients.get(sessionId);
    if (!clients || clients.length === 0) {
      return;
    }

    const session = sessionManager.getAllSessions().get(sessionId);
    const data = session
      ? JSON.stringify({ type: 'session-state', session: buildWebUiSessionState(session) })
      : JSON.stringify({ type: 'session-deleted', sessionId });

    clients.forEach(client => {
      try {
        client.write(`data: ${data}\n\n`);
        if (!session) {
          client.end();
        }
      } catch (e) {
        logger.error({ err: e, sessionId }, 'Failed to send SSE session state');
      }
    });

    if (!session) {
      this.sseClients.delete(sessionId);
    }
  }

  // Broadcast session list update to all global SSE clients
  broadcastSessionListUpdate() {
    if (this.globalSseClients.length > 0) {
      const data = JSON.stringify({ type: 'sessions-updated' });
      this.globalSseClients.forEach(client => {
        try {
          client.write(`data: ${data}\n\n`);
        } catch (e) {
          logger.error({ err: e }, 'Failed to send session list update');
        }
      });
    }
  }

  // Channel interface implementation
  async sendMessage(channelUserId: string, text: string, _options?: any): Promise<void> {
    // For WebUI, channelUserId is the sessionId
    // Use broadcastMessage for consistency (unified message system)
    logger.debug({ sessionId: channelUserId, textPreview: text.substring(0, 50) }, 'WebUI sendMessage called');
    this.broadcastMessage(channelUserId, {
      role: 'assistant',
      parts: [{ text }],
      __meta: {
        timestamp: Date.now(),
        channelUserId: channelUserId,
        username: 'system',
        platform: 'webui',
        temporary: true,
        isInstantNotification: true // Mark as instant notification (like compact messages)
      }
    });
  }

  async sendFile(channelUserId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<void> {
    // WebUI does not need a channel-side binary push: the tool result includes
    // the local fullPath, and WebUI renders tool results with download/open
    // affordances. Implementing this as a successful no-op prevents generic
    // session delivery from reporting that WebUI "does not support file
    // sending", which incorrectly suggests to agents that WebUI users cannot
    // access the file.
    logger.debug({
      sessionId: channelUserId,
      fileName: file.name,
      filePath: file.path,
      sizeBytes: file.sizeBytes,
      caption: options?.caption,
    }, 'WebUI sendFile noop called');
  }

  async sendTyping(channelUserId: string): Promise<void> {
    // For WebUI, send typing indicator via SSE
    const clients = this.sseClients.get(channelUserId);
    if (clients && clients.length > 0) {
      const data = JSON.stringify({ type: 'typing' });
      clients.forEach(client => {
        try {
          client.write(`data: ${data}\n\n`);
        } catch (e) {
          logger.error({ err: e, sessionId: channelUserId }, 'Failed to send typing indicator');
        }
      });
    }
  }

  onMessage(_handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
    // WebUI handles messages internally via HTTP API
    // This is a no-op for WebUI
  }

  async start(): Promise<void> {
    // HTTP server is already started globally, no need to start here
    logger.info({ webui: this.enableWebUI, trigger: this.enableTrigger }, 'WebUI channel started');
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    // HTTP server is managed globally, no need to stop here
    logger.info('WebUI channel stopped');
    return Promise.resolve();
  }
}
