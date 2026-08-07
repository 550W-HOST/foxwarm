import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildSavedFileText, saveInboundSessionFileFromPath, SavedChannelFile } from '../channelFiles';
import type { QQBotMediaConfig } from '../config';
import type { MessagePart } from '../types';

const MIB = 1024 * 1024;

export const QQBOT_MEDIA_HARD_MAX_BYTES = 200 * MIB;
export const QQBOT_MEDIA_SAFE_INLINE_IMAGE_MAX_BYTES = 20 * MIB;
export const QQBOT_MEDIA_DEFAULT_IMAGE_MAX_BYTES = QQBOT_MEDIA_SAFE_INLINE_IMAGE_MAX_BYTES;
export const QQBOT_MEDIA_DEFAULT_FILE_MAX_BYTES = 50 * MIB;
export const QQBOT_MEDIA_DEFAULT_TOTAL_MAX_BYTES = QQBOT_MEDIA_HARD_MAX_BYTES;
export const QQBOT_MEDIA_DEFAULT_MAX_ATTACHMENTS = 8;
export const QQBOT_MEDIA_MAX_ATTACHMENTS = 16;
const QQBOT_MEDIA_MAX_REDIRECTS = 3;
const QQBOT_MEDIA_TIMEOUT_MS = 15_000;
const MAX_ATTACHMENT_TEXT_LENGTH = 160;
const MAX_ATTACHMENT_URL_LENGTH = 8_192;

const QQBOT_MEDIA_HOST_SUFFIXES = [
  'qpic.cn',
  'qq.com',
  'weiyun.com',
  'qq.com.cn',
  'ugcimg.cn',
  'myqcloud.com',
  'tencentcos.cn',
  'tencentcos.com',
];

const RASTER_MIME_FORMATS: Record<string, 'jpeg' | 'png' | 'gif' | 'webp'> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

type RawAttachment = Record<string, unknown>;

type NormalizedAttachment = {
  mediaKind: 'image' | 'file' | 'unsupported';
  index: number;
  url?: string;
  fileName: string;
  mimeType: string;
  declaredSize?: number;
  unsupportedReason?: string;
};

export type QQBotMediaDeps = {
  fetch?: typeof fetch;
  saveInboundSessionFileFromPath?: typeof saveInboundSessionFileFromPath;
  timeoutMs?: number;
};

export type QQBotMediaMaterializeOptions = {
  attachments: unknown[];
  content: string;
  eventId: string;
  sessionId: string;
  config?: QQBotMediaConfig;
  deps?: QQBotMediaDeps;
};

type QQBotMediaLimits = {
  imageInlineMaxBytes: number;
  fileMaxBytes: number;
  totalMaxBytes: number;
  maxAttachments: number;
};

function clampPositiveBytes(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), QQBOT_MEDIA_HARD_MAX_BYTES);
}

function resolveLimits(config?: QQBotMediaConfig): QQBotMediaLimits {
  const requestedImageMaxBytes = clampPositiveBytes(config?.imageMaxBytes, QQBOT_MEDIA_DEFAULT_IMAGE_MAX_BYTES);
  const fileMaxBytes = clampPositiveBytes(config?.fileMaxBytes, QQBOT_MEDIA_DEFAULT_FILE_MAX_BYTES);
  const totalMaxBytes = clampPositiveBytes(config?.maxTotalBytes, QQBOT_MEDIA_DEFAULT_TOTAL_MAX_BYTES);
  const requestedCount = typeof config?.maxAttachments === 'number' && Number.isFinite(config.maxAttachments)
    ? Math.trunc(config.maxAttachments)
    : QQBOT_MEDIA_DEFAULT_MAX_ATTACHMENTS;

  return {
    imageInlineMaxBytes: Math.min(requestedImageMaxBytes, QQBOT_MEDIA_SAFE_INLINE_IMAGE_MAX_BYTES),
    fileMaxBytes,
    totalMaxBytes,
    maxAttachments: Math.max(1, Math.min(requestedCount, QQBOT_MEDIA_MAX_ATTACHMENTS)),
  };
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeMimeType(value: unknown): string {
  const normalized = cleanText(value, 128).toLowerCase();
  if (!normalized || normalized === 'file' || normalized === 'voice') {
    return 'application/octet-stream';
  }
  return normalized;
}

function classifyMediaKind(value: RawAttachment, mimeType: string): { mediaKind: NormalizedAttachment['mediaKind']; unsupportedReason?: string } {
  const declaredType = cleanText(value.content_type ?? value.mimeType ?? value.type, 128).toLowerCase();
  const fileType = value.file_type ?? value.fileType;
  const hasNestedMedia = [value.attachments, value.children]
    .some(nested => nested !== undefined && nested !== null);
  if (hasNestedMedia) {
    return { mediaKind: 'unsupported', unsupportedReason: 'nested QQ media is deferred in Stage 1' };
  }
  if (fileType === 2 || fileType === '2' || declaredType === 'video' || declaredType.startsWith('video/') || mimeType.startsWith('video/')) {
    return { mediaKind: 'unsupported', unsupportedReason: 'QQ video media is deferred in Stage 1' };
  }
  if (fileType === 3 || fileType === '3' || declaredType === 'voice' || declaredType === 'audio' || declaredType.startsWith('audio/') || mimeType.startsWith('audio/') || value.voice_wav_url || value.voiceWavUrl) {
    return { mediaKind: 'unsupported', unsupportedReason: 'QQ voice media is deferred in Stage 1' };
  }
  return { mediaKind: mimeType.startsWith('image/') ? 'image' : 'file' };
}

function safeFileName(value: unknown, index: number, mimeType: string): string {
  const raw = cleanText(value, MAX_ATTACHMENT_TEXT_LENGTH).replace(/\\/g, '/');
  const base = path.basename(raw);
  const extension = path.extname(base).slice(0, 16);
  const withoutExtension = extension ? base.slice(0, -extension.length) : base;
  const safeBase = withoutExtension.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/u, '').slice(0, 96);
  const safeExtension = EXT_BY_MIME[mimeType]
    || (extension && /^\.[a-zA-Z0-9]{1,15}$/u.test(extension) ? extension : '');
  return `${safeBase || `qqbot-attachment-${index + 1}`}${safeExtension}`;
}

function normalizeDeclaredSize(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,15}$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeAttachment(raw: unknown, index: number): NormalizedAttachment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as RawAttachment;
  const mimeType = normalizeMimeType(value.content_type ?? value.mimeType);
  const classification = classifyMediaKind(value, mimeType);
  const fileName = safeFileName(value.filename ?? value.fileName, index, mimeType);
  const url = cleanText(value.url, MAX_ATTACHMENT_URL_LENGTH) || undefined;
  return {
    mediaKind: classification.mediaKind,
    index,
    url,
    fileName,
    mimeType,
    declaredSize: normalizeDeclaredSize(value.size ?? value.sizeBytes),
    unsupportedReason: classification.unsupportedReason,
  };
}

function formatByteCount(bytes: number | undefined): string {
  if (bytes === undefined) return 'unknown size';
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(bytes % MIB === 0 ? 0 : 1)} MiB`;
  return `${bytes} bytes`;
}

function attachmentKind(attachment: NormalizedAttachment): 'image' | 'file' {
  return attachment.mediaKind === 'image' ? 'image' : 'file';
}

function attachmentPreview(attachment: NormalizedAttachment): string {
  if (attachment.mediaKind === 'unsupported') {
    return `[QQ unsupported attachment deferred: ${attachment.fileName}; MIME: ${attachment.mimeType}; size: ${formatByteCount(attachment.declaredSize)}; reason: ${attachment.unsupportedReason || 'unsupported media'}]`;
  }
  return `[QQ ${attachmentKind(attachment)} attachment: ${attachment.fileName}; MIME: ${attachment.mimeType}; size: ${formatByteCount(attachment.declaredSize)}]`;
}

function malformedPreview(index: number): string {
  return `[QQ attachment ${index + 1}: malformed attachment metadata]`;
}

function boundedError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value || 'unknown media error');
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/[^\s)]+/gi, '[URL]').slice(0, 180);
}

function mediaErrorPart(label: string, reason: string): MessagePart {
  return { text: `${label}\n[QQ media unavailable: ${boundedError(reason)}]` };
}

function isAllowedMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return QQBOT_MEDIA_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

function validateMediaUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid media URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('media URL must use HTTPS');
  if (parsed.username || parsed.password) throw new Error('media URL userinfo is not allowed');
  if (parsed.port && parsed.port !== '443') throw new Error('media URL port is not allowed');
  if (!isAllowedMediaHost(parsed.hostname)) throw new Error('media URL host is not allowlisted');
  return parsed;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A redirect body is disposable; do not mask the URL validation error.
  }
}

async function withTimeout<T>(promise: Promise<T>, controller: AbortController, timeoutMs = QQBOT_MEDIA_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('media download timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) controller.abort();
  }
}

async function writeResponseBodyToSpool(
  response: Response,
  spoolPath: string,
  maxFileBytes: number,
  totalUsedBytes: number,
  totalMaxBytes: number,
): Promise<number> {
  if (!response.body) throw new Error('media response has no body');
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > maxFileBytes) throw new Error(`media exceeds ${formatByteCount(maxFileBytes)} limit`);
    if (totalUsedBytes + declaredBytes > totalMaxBytes) throw new Error(`media exceeds ${formatByteCount(totalMaxBytes)} total limit`);
  }

  const file = await fs.open(spoolPath, 'wx');
  const reader = response.body.getReader();
  let receivedBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      if (receivedBytes + chunk.length > maxFileBytes) {
        throw new Error(`media exceeds ${formatByteCount(maxFileBytes)} limit`);
      }
      if (totalUsedBytes + receivedBytes + chunk.length > totalMaxBytes) {
        throw new Error(`media exceeds ${formatByteCount(totalMaxBytes)} total limit`);
      }
      await file.write(chunk);
      receivedBytes += chunk.length;
    }
    return receivedBytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    await file.close();
  }
}

async function downloadBoundedMediaToFile(
  url: string,
  spoolPath: string,
  maxFileBytes: number,
  totalUsedBytes: number,
  totalMaxBytes: number,
  fetchFn: typeof fetch,
  timeoutMs = QQBOT_MEDIA_TIMEOUT_MS,
): Promise<number> {
  let currentUrl = url;
  for (let redirect = 0; redirect <= QQBOT_MEDIA_MAX_REDIRECTS; redirect += 1) {
    const parsed = validateMediaUrl(currentUrl);
    const controller = new AbortController();
    const response = await withTimeout(fetchFn(parsed.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      // Never forward the bot API Authorization token or user cookies.
      headers: { accept: '*/*' },
    }), controller, timeoutMs);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await cancelResponseBody(response);
      if (!location) throw new Error('media redirect has no location');
      if (redirect === QQBOT_MEDIA_MAX_REDIRECTS) throw new Error('too many media redirects');
      currentUrl = new URL(location, parsed).toString();
      continue;
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`media download returned HTTP ${response.status}`);
    }

    return await withTimeout(
      writeResponseBodyToSpool(response, spoolPath, maxFileBytes, totalUsedBytes, totalMaxBytes),
      controller,
      timeoutMs,
    );
  }
  throw new Error('too many media redirects');
}

async function probeRaster(spoolPath: string, mimeType: string): Promise<{ width?: number; height?: number }> {
  const expected = RASTER_MIME_FORMATS[mimeType];
  if (!expected) throw new Error(`unsupported inline image MIME ${mimeType}`);
  const metadata = await sharp(spoolPath, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
  if (metadata.format !== expected) {
    throw new Error(`image bytes do not match declared MIME ${mimeType}`);
  }
  return {
    width: typeof metadata.width === 'number' ? metadata.width : undefined,
    height: typeof metadata.height === 'number' ? metadata.height : undefined,
  };
}

function buildPreviewParts(content: string, attachments: unknown[], limits: QQBotMediaLimits): MessagePart[] {
  const parts: MessagePart[] = [];
  if (content.trim()) parts.push({ text: content });
  for (let index = 0; index < attachments.length && index < limits.maxAttachments; index += 1) {
    const attachment = normalizeAttachment(attachments[index], index);
    parts.push({ text: attachment ? attachmentPreview(attachment) : malformedPreview(index) });
  }
  if (attachments.length > limits.maxAttachments) {
    parts.push({ text: `[QQ media: ${attachments.length - limits.maxAttachments} additional attachments omitted by the inbound bound]` });
  }
  return parts.length > 0 ? parts : [{ text: '[QQ message contained no readable text or media]' }];
}

export function buildQQBotAttachmentPreviewParts(content: string, attachments: unknown[], config?: QQBotMediaConfig): MessagePart[] {
  return buildPreviewParts(content, attachments, resolveLimits(config));
}

function makeImageId(eventId: string, attachmentIndex: number, buffer: Buffer): string {
  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const eventDigest = crypto.createHash('sha256').update(eventId).digest('hex').slice(0, 16);
  return `qqbot-${eventDigest}-${attachmentIndex + 1}-${digest}`;
}

async function saveInbound(
  deps: QQBotMediaDeps | undefined,
  options: Parameters<typeof saveInboundSessionFileFromPath>[0],
): Promise<SavedChannelFile> {
  return (deps?.saveInboundSessionFileFromPath || saveInboundSessionFileFromPath)(options);
}

export async function materializeQQBotAttachments(options: QQBotMediaMaterializeOptions): Promise<MessagePart[]> {
  const limits = resolveLimits(options.config);
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const parts: MessagePart[] = [];
  if (options.content.trim()) parts.push({ text: options.content });

  let totalDownloaded = 0;
  let totalBoundReached = false;
  const fetchFn = options.deps?.fetch || globalThis.fetch;
  if (!fetchFn) {
    return buildPreviewParts(options.content, attachments, limits).map(part => ({
      ...part,
      text: part.text ? `${part.text}\n[QQ media unavailable: fetch is not available]` : part.text,
    }));
  }

  for (let index = 0; index < attachments.length && index < limits.maxAttachments; index += 1) {
    const attachment = normalizeAttachment(attachments[index], index);
    if (!attachment) {
      parts.push({ text: malformedPreview(index) });
      continue;
    }

    const label = attachmentPreview(attachment);
    if (attachment.mediaKind === 'unsupported') {
      parts.push(mediaErrorPart(label, attachment.unsupportedReason || 'unsupported QQ media is deferred in Stage 1'));
      continue;
    }

    const perFileLimit = limits.fileMaxBytes;
    if (!attachment.url) {
      parts.push(mediaErrorPart(label, 'attachment URL is missing'));
      continue;
    }
    if (attachment.declaredSize !== undefined && attachment.declaredSize > perFileLimit) {
      parts.push(mediaErrorPart(label, `declared size exceeds ${formatByteCount(perFileLimit)} limit`));
      totalBoundReached = totalBoundReached || attachment.declaredSize > limits.totalMaxBytes;
      continue;
    }
    if (totalBoundReached || totalDownloaded >= limits.totalMaxBytes) {
      parts.push(mediaErrorPart(label, `total inbound media exceeds ${formatByteCount(limits.totalMaxBytes)} limit`));
      continue;
    }

    const remainingTotal = limits.totalMaxBytes - totalDownloaded;
    const fetchLimit = Math.min(perFileLimit, remainingTotal, QQBOT_MEDIA_HARD_MAX_BYTES);
    let spoolDir: string | undefined;
    try {
      spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-qqbot-media-'));
      const spoolPath = path.join(spoolDir, 'attachment.bin');
      const sizeBytes = await downloadBoundedMediaToFile(
        attachment.url,
        spoolPath,
        fetchLimit,
        totalDownloaded,
        limits.totalMaxBytes,
        fetchFn,
        options.deps?.timeoutMs,
      );
      totalDownloaded += sizeBytes;

      const canInlineImage = attachment.mediaKind === 'image'
        && sizeBytes <= limits.imageInlineMaxBytes
        && Boolean(RASTER_MIME_FORMATS[attachment.mimeType]);
      if (canInlineImage) {
        const imageMeta = await probeRaster(spoolPath, attachment.mimeType);
        const saved = await saveInbound(options.deps, {
          sessionId: options.sessionId,
          platform: 'qqbot',
          sourcePath: spoolPath,
          sizeBytes,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          isImage: true,
        });
        // The only full-buffer media read is after the safe inline-image cap
        // and raster validation have both passed.
        const buffer = await fs.readFile(spoolPath);
        parts.push({
          text: buildSavedFileText(saved, 'image'),
          inlineData: { mimeType: attachment.mimeType, data: buffer.toString('base64') },
          imageMeta: {
            imageId: makeImageId(options.eventId, attachment.index, buffer),
            mimeType: attachment.mimeType,
            width: imageMeta.width,
            height: imageMeta.height,
            sizeBytes: buffer.length,
          },
        });
      } else {
        const saved = await saveInbound(options.deps, {
          sessionId: options.sessionId,
          platform: 'qqbot',
          sourcePath: spoolPath,
          sizeBytes,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          isImage: false,
        });
        const imageFallbackNote = attachment.mediaKind === 'image'
          ? `\n[QQ image kept as a generic file; inline image limit is ${formatByteCount(limits.imageInlineMaxBytes)} and no image bytes were sent inline]`
          : '';
        parts.push({ text: `${buildSavedFileText(saved, 'file')}${imageFallbackNote}` });
      }
    } catch (error) {
      if (error instanceof Error && /exceeds .*limit/u.test(error.message)) {
        totalBoundReached = true;
      }
      parts.push(mediaErrorPart(label, boundedError(error)));
    } finally {
      if (spoolDir) {
        await fs.rm(spoolDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  if (attachments.length > limits.maxAttachments) {
    parts.push({ text: `[QQ media: ${attachments.length - limits.maxAttachments} additional attachments omitted by the inbound bound]` });
  }
  return parts.length > 0 ? parts : [{ text: '[QQ message contained no readable text or media]' }];
}