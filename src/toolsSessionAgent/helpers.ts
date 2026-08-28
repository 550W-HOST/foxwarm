import path from 'path';
import * as sessionManager from '../sessionManager';
import * as timers from '../timers';
import type { ChannelFile } from '../channel';
import { getAgentDir, MODEL_EFFORTS, resolveModelConfig, type ModelEffort } from '../config';
import { nodesManager } from '../nodes/manager';
import { checkPathAccess } from '../isolatedCheck';
import { expandHomePath, resolveAgentPath } from '../utils/pathResolve';

export { expandHomePath, resolveAgentPath };

export interface ToolContext {
  sessionId?: string;
  session?: any;
  broadcast?: (text: string, options?: any) => Promise<void>;
  runtimeNodeId?: string;
  /** In-process owner hook for persisting ctx.session; never serialized as a tool/RPC DTO. */
  persistCurrentSession?: () => Promise<void>;
  sessionPlacement?: 'local' | 'session-worker';
  /** Process-local persistent exec owner used to validate exact waitExecIds. */
  execRuntime?: import('../execManager').ExecRuntime;
  /** Internal tool-result metadata request used by the canonical turn runner. */
  captureSuccessfulSendToSessionTarget?: boolean;
  /** Current in-process turn reply metadata; never persisted or sent to remote tools. */
  channelReplyMetadata?: {
    qqbotMessageId?: string;
    qqbotChannelId?: string;
    qqbotConversationId?: string;
  };
}

export type ToolArgs = Record<string, any>;

export const ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT = 20_000;
export const RECALL_DEFAULT_PREVIEW_LENGTH = 1000;
export const RECALL_LEGACY_ARG_NAMES = [
  'startSeq',
  'endSeq',
  'startId',
  'endId',
  'includeMessages',
  'includeBlocks',
];

export function buildEndTurnResult(_reason?: string) {
  return { output: 'ok', __toolLoopControl: { stopCurrentTurn: true } };
}

export type AfterSendBehavior = 'continue' | 'finish' | 'wait';

export function normalizeAfterSendBehavior(
  args: ToolArgs,
  toolName: 'send_to_session' | 'create_child_session',
): AfterSendBehavior {
  for (const key of ['waitAfterHandoff', 'noFurtherAssistantReply'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') {
      throw new Error(`${toolName} ${key} must be a boolean when provided.`);
    }
  }
  const afterSend = args.afterSend;
  if (afterSend !== undefined) {
    if (afterSend !== 'continue' && afterSend !== 'finish' && afterSend !== 'wait') {
      throw new Error(`${toolName} afterSend must be one of: continue, finish, wait.`);
    }
    if (args.waitAfterHandoff !== undefined || args.noFurtherAssistantReply !== undefined) {
      throw new Error(`${toolName} afterSend cannot be combined with legacy waitAfterHandoff or noFurtherAssistantReply.`);
    }
    return afterSend;
  }
  // Hidden compatibility fields remain readable for direct callers and old
  // persisted tool calls, but are intentionally absent from the model schema.
  if (args.waitAfterHandoff === true) return 'wait';
  if (args.noFurtherAssistantReply === true) return 'finish';
  return 'continue';
}

export function normalizeWaitFallbackSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const timeoutSeconds = Number(value);
  if (!Number.isFinite(timeoutSeconds)) {
    throw new Error('wakeIfNoActivityAfterSeconds must be a positive finite number.');
  }
  if (timeoutSeconds < 0) {
    throw new Error('wakeIfNoActivityAfterSeconds must be a positive finite number.');
  }
  if (timeoutSeconds === 0) throw new Error('wakeIfNoActivityAfterSeconds must be greater than zero when provided.');

  return timeoutSeconds;
}

export function normalizeWaitForInput(value: unknown): true | undefined {
  if (value === undefined) return undefined;
  if (value !== true) throw new Error('waitForInput must be exactly true when provided.');
  return true;
}

export function normalizeWaitAllSessions(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('waitAllSessions must be an array of session IDs.');
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('waitAllSessions entries must be non-empty strings.');
    }

    const sessionId = entry.trim();
    if (!sessionId) {
      throw new Error('waitAllSessions entries must be non-empty strings.');
    }

    if (!seen.has(sessionId)) {
      seen.add(sessionId);
      normalized.push(sessionId);
    }
  }

  if (normalized.length === 0) throw new Error('waitAllSessions must contain at least two Session IDs when explicitly provided.');

  if (normalized.length < 2) {
    throw new Error('waitAllSessions must contain at least two distinct session IDs after trimming.');
  }

  return normalized;
}

export function normalizeWaitAnySessions(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('waitAnySessions must be an array of session IDs.');
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('waitAnySessions entries must be non-empty strings.');
    const sessionId = entry.trim();
    if (!seen.has(sessionId)) { seen.add(sessionId); normalized.push(sessionId); }
  }
  if (normalized.length === 0) throw new Error('waitAnySessions must contain at least one session ID.');
  return normalized;
}

export function normalizeWaitExecIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('waitExecIds must be an array of exact execId values. Never use a PID or log path.');
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('waitExecIds entries must be non-empty exact execId strings. Never use a PID or log path.');
    }

    const execId = entry.trim();
    if (!execId) {
      throw new Error('waitExecIds entries must be non-empty exact execId strings. Never use a PID or log path.');
    }

    if (!seen.has(execId)) {
      seen.add(execId);
      normalized.push(execId);
    }
  }

  if (normalized.length === 0) throw new Error('waitExecIds must contain at least one exact execId when explicitly provided.');
  return normalized;
}

export function normalizePositivePreviewLength(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function calculatePreviewRequestChars(itemCount: number, previewLength: number): number {
  const normalizedCount = Math.max(0, Math.floor(itemCount));
  if (normalizedCount <= 1) {
    return 0;
  }
  return normalizedCount * previewLength;
}

export function assertPreviewRequestWithinLimit(
  toolName: string,
  segments: Array<{ label: string; count: number; previewLength: number }>,
): void {
  const evaluatedSegments = segments
    .map(segment => {
      const count = Math.max(0, Math.floor(segment.count));
      const previewLength = Math.max(0, Math.floor(segment.previewLength));
      return {
        ...segment,
        count,
        previewLength,
        requestedChars: calculatePreviewRequestChars(count, previewLength),
      };
    })
    .filter(segment => segment.count > 0);

  const totalRequestedChars = evaluatedSegments.reduce((sum, segment) => sum + segment.requestedChars, 0);
  if (totalRequestedChars <= ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT) {
    return;
  }

  const detailText = evaluatedSegments
    .map(segment => `${segment.label}: ${segment.count} × ${segment.previewLength}${segment.count <= 1 ? ' (single-item request exempt)' : ` = ${segment.requestedChars}`}`)
    .join('; ');

  throw new Error(
    `Request too large for ${toolName}: requested preview budget is ${totalRequestedChars} characters, exceeding the ${ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT}-character limit. `
    + `First narrow the range or locate the relevant message/block position, then request fuller content. ${detailText}`,
  );
}

const MIME_TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

export function formatTimerTimestamp(timestamp?: number | null): string {
  if (!timestamp) return 'n/a';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'n/a' : date.toISOString();
}

export function formatTimerSummary(timer: timers.TimerView): string {
  const mode = timer.mode === 'cron'
    ? `cron: ${timer.cron}`
    : `at: ${formatTimerTimestamp(timer.at)}`;
  const target = timer.newSession
    ? `new session (${timer.agentName || 'main'} / ${timer.sessionPrefix || 'timer'})`
    : `session ${timer.sessionId}`;

  return `Timer \`${timer.id}\` created.\nMode: ${mode}\nTarget: ${target}\nNext run: ${formatTimerTimestamp(timer.nextRunAt)}\nMessage: ${timer.message}`;
}

export function formatTimerUpdateSummary(timer: timers.TimerView): string {
  const mode = timer.mode === 'cron'
    ? `cron: ${timer.cron}`
    : `at: ${formatTimerTimestamp(timer.at)}`;
  const target = timer.newSession
    ? `new session (${timer.agentName || 'main'} / ${timer.sessionPrefix || 'timer'})`
    : `session ${timer.sessionId}`;

  return `Timer \`${timer.id}\` updated.\nMode: ${mode}\nTarget: ${target}\nNext run: ${formatTimerTimestamp(timer.nextRunAt)}\nMessage: ${timer.message}`;
}

export function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPE_BY_EXT[ext] || 'application/octet-stream';
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeToolModelKey(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const normalized = value.trim();
  const { modelsConfig } = resolveModelConfig(undefined);
  if (!modelsConfig.models[normalized]) {
    throw new Error(`Unknown model \`${normalized}\`. Use /model to list available models.`);
  }

  return normalized;
}

export type ForcedSessionModelEffort = {
  model?: string;
  effort?: ModelEffort;
};

const CREATE_CHILD_SESSION_KEYS = new Set([
  'suffix', 'fork', 'message', 'node', 'forceModel', 'afterSend', 'noFurtherAssistantReply', 'waitAfterHandoff',
]);
const CREATE_SESSION_KEYS = new Set([
  'agentName', 'sessionName', 'displayName', 'parentSessionId', 'forceModel', 'systemPromptFiles',
]);

function cloneCreationArgs(args: ToolArgs): ToolArgs {
  return { ...args, ...(args.forceModel && { forceModel: { ...args.forceModel } }) };
}

export function normalizeForceModel(
  args: ToolArgs,
  toolName: 'create_child_session' | 'create_session',
  makeError: (message: string) => Error = message => new Error(message),
): ForcedSessionModelEffort {
  if (Object.prototype.hasOwnProperty.call(args, 'model') || Object.prototype.hasOwnProperty.call(args, 'effort')) {
    throw makeError(`${toolName} no longer accepts top-level model or effort. Use forceModel: { modelId, effort }.`);
  }

  if (!Object.prototype.hasOwnProperty.call(args, 'forceModel') || args.forceModel === undefined) {
    return {};
  }

  const value = args.forceModel;
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw makeError(`${toolName} forceModel must be an object when provided.`);
  }

  const keys = Object.keys(value);
  const unknownKey = keys.find(key => key !== 'modelId' && key !== 'effort');
  if (unknownKey) {
    throw makeError(`${toolName} forceModel accepts only modelId and effort; unknown key: ${unknownKey}.`);
  }

  let model: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'modelId')) {
    if (typeof value.modelId !== 'string' || !value.modelId.trim()
      || Buffer.byteLength(value.modelId, 'utf8') > 4096) {
      throw makeError(`${toolName} forceModel.modelId must be a bounded non-empty string when provided.`);
    }
    try {
      model = normalizeToolModelKey(value.modelId);
    } catch (error) {
      throw makeError(error instanceof Error ? error.message : String(error));
    }
  }

  let effort: ModelEffort | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'effort')) {
    if (typeof value.effort !== 'string' || !MODEL_EFFORTS.includes(value.effort as ModelEffort)) {
      throw makeError(`${toolName} forceModel.effort must be one of: ${MODEL_EFFORTS.join(', ')}.`);
    }
    effort = value.effort as ModelEffort;
  }

  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

export function normalizeCreateChildSessionArgs(
  args: ToolArgs,
  makeError: (message: string) => Error = message => new Error(message),
): ToolArgs {
  normalizeForceModel(args, 'create_child_session', makeError);
  const unknownKey = Object.keys(args).find(key => !CREATE_CHILD_SESSION_KEYS.has(key));
  if (unknownKey) {
    throw makeError(`create_child_session accepts only suffix, fork, message, node, forceModel, and afterSend; unknown key: ${unknownKey}.`);
  }
  if (typeof args.suffix !== 'string' || !args.suffix.trim()) {
    throw makeError('create_child_session requires a non-empty suffix.');
  }
  for (const key of ['fork', 'noFurtherAssistantReply', 'waitAfterHandoff'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') {
      throw makeError(`create_child_session ${key} must be a boolean when provided.`);
    }
  }
  try {
    normalizeAfterSendBehavior(args, 'create_child_session');
  } catch (error) {
    throw makeError(error instanceof Error ? error.message : String(error));
  }
  if (args.message !== undefined && typeof args.message !== 'string') {
    throw makeError('create_child_session message must be a string when provided.');
  }
  if (args.node !== undefined
    && (typeof args.node !== 'string' || !args.node.trim() || Buffer.byteLength(args.node, 'utf8') > 4096)) {
    throw makeError('create_child_session node must be a bounded non-empty string when provided.');
  }
  return cloneCreationArgs(args);
}

export function normalizeCreateSessionArgs(
  args: ToolArgs,
  makeError: (message: string) => Error = message => new Error(message),
): ToolArgs {
  normalizeForceModel(args, 'create_session', makeError);
  const unknownKey = Object.keys(args).find(key => !CREATE_SESSION_KEYS.has(key));
  if (unknownKey) {
    throw makeError(`create_session accepts only agentName, sessionName, displayName, parentSessionId, forceModel, and systemPromptFiles; unknown key: ${unknownKey}.`);
  }
  return cloneCreationArgs(args);
}

export function formatMessageLogRange(startSeq?: number, endSeq?: number): string {
  if (typeof startSeq !== 'number' || !Number.isFinite(startSeq)) {
    return 'msg#?';
  }

  const start = Math.trunc(startSeq);
  if (typeof endSeq !== 'number' || !Number.isFinite(endSeq) || Math.trunc(endSeq) === start) {
    return `msg#${start}`;
  }

  return `msg#${start}-${Math.trunc(endSeq)}`;
}

export function formatBlockIdRange(startId?: number, endId?: number): string {
  if (typeof startId !== 'number' || !Number.isFinite(startId)) {
    return 'B#?';
  }

  const start = Math.trunc(startId);
  if (typeof endId !== 'number' || !Number.isFinite(endId) || Math.trunc(endId) === start) {
    return `B#${start}`;
  }

  return `B#${start}-B#${Math.trunc(endId)}`;
}

export function shouldEnforceIsolatedMasterPathAccess(ctx?: ToolContext): boolean {
  return sessionManager.isSessionEffectivelyIsolated(ctx?.session) && (ctx?.runtimeNodeId || ctx?.session?.currentNode || 'master') === 'master';
}

export function getPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

export async function prepareRemoteChannelFile(filePath: string, nodeId: string, ctx?: ToolContext): Promise<ChannelFile> {
  if (!ctx?.sessionId) {
    throw new Error('send_file requires an active session context when reading a file from a remote node.');
  }
  const payload = await nodesManager.readFileFromNode(nodeId, filePath, ctx.sessionId);
  const agentName = ctx?.session?.agent || 'main';
  const tempDir = path.join(getAgentDir(agentName), '.temp', 'send-file-cache');
  const fs = await import('fs-extra');
  await fs.ensureDir(tempDir);
  const ext = path.extname(payload.name || filePath);
  const tempPath = path.join(tempDir, `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`);
  await fs.writeFile(tempPath, Buffer.from(payload.dataBase64, 'base64'));
  return {
    path: tempPath,
    name: payload.name || path.basename(filePath),
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    isImage: payload.isImage,
  };
}

export async function prepareChannelFile(filePath: string, ctx?: ToolContext): Promise<ChannelFile> {
  const agentName = ctx?.session?.agent || 'main';
  const fileNodeId = ctx?.runtimeNodeId || ctx?.session?.currentNode || 'master';
  if (fileNodeId !== 'master') {
    return prepareRemoteChannelFile(filePath, fileNodeId, ctx);
  }

  const fs = await import('fs-extra');
  const fullPath = resolveAgentPath(filePath, agentName, ctx?.session?.cwd);
  if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
    checkPathAccess(fullPath, agentName);
  }
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const mimeType = detectMimeType(fullPath);
  return {
    path: fullPath,
    name: path.basename(fullPath),
    mimeType,
    sizeBytes: stats.size,
    isImage: mimeType.startsWith('image/'),
  };
}

export function formatSendFileSessionResult(targetSessionId: string, file: ChannelFile, result: sessionManager.FileDeliveryResult): string {
  const lines = [
    `File \`${file.name}\` sent for session \`${targetSessionId}\`.`,
    `Delivered: ${result.deliveredChannels.length}`,
  ];

  if (result.deliveredChannels.length) {
    lines.push(`Channels: ${result.deliveredChannels.map(id => `\`${id}\``).join(', ')}`);
  }

  if (result.skippedChannels.length) {
    lines.push(`Skipped: ${result.skippedChannels.map(item => `\`${item.channelId}\` (${item.reason})`).join(', ')}`);
  }

  if (result.failedChannels.length) {
    lines.push(`Failed: ${result.failedChannels.map(item => `\`${item.channelId}\` (${item.error})`).join(', ')}`);
  }

  return lines.join('\n');
}

export function isWebUiUnsupportedFileDelivery(channelId: string, reason: string): boolean {
  return channelId.startsWith('webui:') && reason === 'channel does not support file sending yet';
}

export function buildSendFileResult(output: string, file: ChannelFile) {
  return {
    output,
    fullPath: file.path,
  };
}
