import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { buildSavedFileText, saveInboundSessionFile, SavedChannelFile } from '../channelFiles';
import type { QQBotMediaConfig } from '../config';
import type { MessagePart } from '../types';

const MIB = 1024 * 1024;

export const QQBOT_MEDIA_HARD_MAX_BYTES = 200 * MIB;
export const QQBOT_MEDIA_DEFAULT_IMAGE_MAX_BYTES = 20 * MIB;
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
  index: number;
  url?: string;
  fileName: string;
  mimeType: string;
  declaredSize?: number;
};

export type QQBotMediaDeps = {
  fetch?: typeof fetch;
  saveInboundSessionFile?: typeof saveInboundSessionFile;
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
  imageMaxBytes: number;
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
  const imageMaxBytes = clampPositiveBytes(config?.imageMaxBytes, QQBOT_MEDIA_DEFAULT_IMAGE_MAX_BYTES);
  const fileMaxBytes = clampPositiveBytes(config?.fileMaxBytes, QQBOT_MEDIA_DEFAULT_FILE_MAX_BYTES);
  const totalMaxBytes = clampPositiveBytes(config?.maxTotalBytes, QQBOT_MEDIA_DEFAULT_TOTAL_MAX_BYTES);
  const requestedCount = typeof config?.maxAttachments === 'number' && Number.isFinite(config.maxAttachments)
    ? Math.trunc(config.maxAttachments)
    : QQBOT_MEDIA_DEFAULT_MAX_ATTACHMENTS;

  return {
    imageMaxBytes,
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
  const fileName = safeFileName(value.filename ?? value.fileName, index, mimeType);
  const url = cleanText(value.url, MAX_ATTACHMENT_URL_LENGTH) || undefined;
  return {
    index,
    url,
    fileName,
    mimeType,
    declaredSize: normalizeDeclaredSize(value.size ?? value.sizeBytes),
  };
}

function formatByteCount(bytes: number | undefined): string {
  if (bytes === undefined) return 'unknown size';
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(bytes % MIB === 0 ? 0 : 1)} MiB`;
  return `${bytes} bytes`;
}

function attachmentKind(attachment: NormalizedAttachment): 'image' | 'file' {
  return attachment.mimeType.startsWith('image/') ? 'image' : 'file';
}

function attachmentPreview(attachment: NormalizedAttachment): string {
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

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!body) throw new Error('media response has no body');
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) throw new Error(`media exceeds ${formatByteCount(maxBytes)} limit`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function fetchBoundedMedia(url: string, maxBytes: number, fetchFn: typeof fetch, timeoutMs = QQBOT_MEDIA_TIMEOUT_MS): Promise<Buffer> {
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

    const contentLength = response.headers.get('content-length');
    if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
      await cancelResponseBody(response);
      throw new Error(`media exceeds ${formatByteCount(maxBytes)} limit`);
    }
    return await withTimeout(readBoundedBody(response.body, maxBytes), controller, timeoutMs);
  }
  throw new Error('too many media redirects');
}

async function probeRaster(buffer: Buffer, mimeType: string): Promise<{ width?: number; height?: number }> {
  const expected = RASTER_MIME_FORMATS[mimeType];
  if (!expected) throw new Error(`unsupported inline image MIME ${mimeType}`);
  const metadata = await sharp(buffer, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
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
  options: Parameters<typeof saveInboundSessionFile>[0],
): Promise<SavedChannelFile> {
  return (deps?.saveInboundSessionFile || saveInboundSessionFile)(options);
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
    const kind = attachmentKind(attachment);
    const perFileLimit = kind === 'image' ? limits.imageMaxBytes : limits.fileMaxBytes;
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
    try {
      const buffer = await fetchBoundedMedia(attachment.url, fetchLimit, fetchFn, options.deps?.timeoutMs);
      if (buffer.length > perFileLimit) throw new Error(`media exceeds ${formatByteCount(perFileLimit)} limit`);
      totalDownloaded += buffer.length;

      if (kind === 'image' && RASTER_MIME_FORMATS[attachment.mimeType]) {
        const imageMeta = await probeRaster(buffer, attachment.mimeType);
        const saved = await saveInbound(options.deps, {
          sessionId: options.sessionId,
          platform: 'qqbot',
          buffer,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          isImage: true,
        });
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
          buffer,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          isImage: false,
        });
        parts.push({ text: buildSavedFileText(saved, 'file') });
      }
    } catch (error) {
      if (error instanceof Error && /exceeds .*limit/u.test(error.message)) {
        totalBoundReached = true;
      }
      parts.push(mediaErrorPart(label, boundedError(error)));
    }
  }

  if (attachments.length > limits.maxAttachments) {
    parts.push({ text: `[QQ media: ${attachments.length - limits.maxAttachments} additional attachments omitted by the inbound bound]` });
  }
  return parts.length > 0 ? parts : [{ text: '[QQ message contained no readable text or media]' }];
}