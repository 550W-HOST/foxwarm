import path from 'path';
import * as sessionManager from '../sessionManager';
import * as timers from '../timers';
import type { ChannelFile } from '../channel';
import { getAgentDir, resolveModelConfig } from '../config';
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

export function normalizeWaitTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const timeoutSeconds = Number(value);
  if (!Number.isFinite(timeoutSeconds)) {
    throw new Error('timeoutSeconds must be a non-negative number.');
  }
  if (timeoutSeconds < 0) {
    throw new Error('timeoutSeconds must be a non-negative number.');
  }
  if (timeoutSeconds === 0) {
    return undefined;
  }

  return timeoutSeconds;
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

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

export function normalizeWaitExecIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('waitExecIds must be an array of exec IDs.');
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('waitExecIds entries must be non-empty strings.');
    }

    const execId = entry.trim();
    if (!execId) {
      throw new Error('waitExecIds entries must be non-empty strings.');
    }

    if (!seen.has(execId)) {
      seen.add(execId);
      normalized.push(execId);
    }
  }

  return normalized.length > 0 ? normalized : undefined;
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
