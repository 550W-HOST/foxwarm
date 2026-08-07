import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  buildSavedFileText,
  isInboundSessionMainHosted,
  saveInboundSessionFileFromPath,
  SavedChannelFile,
} from '../channelFiles';
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

const RASTER_MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

type RawAttachment = Record<string, unknown>;

type QQBotMediaErrorCategory =
  | 'download-failed'
  | 'download-too-large'
  | 'download-timeout'
  | 'invalid-media'
  | 'storage-failed'
  | 'isolated-unavailable'
  | 'unsupported-media';

const QQBOT_MEDIA_ERROR_MESSAGES: Record<QQBotMediaErrorCategory, string> = {
  'download-failed': 'media download failed',
  'download-too-large': 'media download exceeded the configured size limit',
  'download-timeout': 'media download timed out',
  'invalid-media': 'media metadata or bytes were invalid',
  'storage-failed': 'media storage failed',
  'isolated-unavailable': 'media storage is unavailable for isolated sessions',
  'unsupported-media': 'nested QQ media is deferred',
};

class QQBotMediaError extends Error {
  readonly category: QQBotMediaErrorCategory;

  constructor(category: QQBotMediaErrorCategory) {
    super(QQBOT_MEDIA_ERROR_MESSAGES[category]);
    this.name = 'QQBotMediaError';
    this.category = category;
  }
}

function mediaError(category: QQBotMediaErrorCategory): QQBotMediaError {
  return new QQBotMediaError(category);
}

function asMediaError(value: unknown, fallback: QQBotMediaErrorCategory): QQBotMediaError {
  return value instanceof QQBotMediaError ? value : mediaError(fallback);
}

type NormalizedAttachment = {
  mediaKind: 'image' | 'file' | 'unsupported';
  index: number;
  url?: string;
  voiceWavUrl?: string;
  fileName: string;
  mimeType: string;
  declaredSize?: number;
  asrReferText?: string;
  unsupportedReason?: string;
};

export type QQBotMediaDeps = {
  fetch?: typeof fetch;
  saveInboundSessionFileFromPath?: typeof saveInboundSessionFileFromPath;
  isMainHostedSession?: typeof isInboundSessionMainHosted;
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
  const hasNestedMedia = [value.attachments, value.children]
    .some(nested => nested !== undefined && nested !== null);
  if (hasNestedMedia) {
    return { mediaKind: 'unsupported', unsupportedReason: 'nested QQ media is deferred' };
  }
  // Direct QQ video/audio/voice is intentionally treated as an ordinary file
  // descriptor. Native playback, transcoding, and nested media remain out of
  // scope; the model/tools can inspect the bounded saved bytes instead.
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
  const isVoice = value.file_type === 3 || value.fileType === 3
    || value.file_type === '3' || value.fileType === '3'
    || cleanText(value.content_type ?? value.mimeType ?? value.type, 128).toLowerCase() === 'voice'
    || value.voice_wav_url !== undefined || value.voiceWavUrl !== undefined;
  const voiceWavUrl = isVoice
    ? cleanText(value.voice_wav_url ?? value.voiceWavUrl, MAX_ATTACHMENT_URL_LENGTH) || undefined
    : undefined;
  const normalizedMimeType = isVoice && mimeType === 'application/octet-stream' && voiceWavUrl
    ? 'audio/wav'
    : mimeType;
  const fileName = safeFileName(value.filename ?? value.fileName, index, normalizedMimeType);
  const url = cleanText(value.url, MAX_ATTACHMENT_URL_LENGTH) || undefined;
  const asrReferText = isVoice
    ? cleanText(value.asr_refer_text ?? value.asrReferText, 512) || undefined
    : undefined;
  return {
    mediaKind: classification.mediaKind,
    index,
    url,
    voiceWavUrl,
    fileName,
    mimeType: normalizedMimeType,
    declaredSize: normalizeDeclaredSize(value.size ?? value.sizeBytes),
    asrReferText,
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
  const asr = attachment.asrReferText ? `; ASR reference: ${attachment.asrReferText}` : '';
  return `[QQ ${attachmentKind(attachment)} attachment: ${attachment.fileName}; MIME: ${attachment.mimeType}; size: ${formatByteCount(attachment.declaredSize)}${asr}]`;
}

function malformedPreview(index: number): string {
  return `[QQ attachment ${index + 1}: malformed attachment metadata]`;
}

function mediaErrorPart(label: string, error: QQBotMediaError): MessagePart {
  return { text: `${label}\n[QQ media unavailable: ${QQBOT_MEDIA_ERROR_MESSAGES[error.category]}]` };
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
    throw mediaError('invalid-media');
  }
  if (parsed.protocol !== 'https:') throw mediaError('invalid-media');
  if (parsed.username || parsed.password) throw mediaError('invalid-media');
  if (parsed.port && parsed.port !== '443') throw mediaError('invalid-media');
  if (!isAllowedMediaHost(parsed.hostname)) throw mediaError('invalid-media');
  return parsed;
}

function selectAttachmentUrl(attachment: NormalizedAttachment): string | undefined {
  if (attachment.voiceWavUrl) {
    try {
      validateMediaUrl(attachment.voiceWavUrl);
      return attachment.voiceWavUrl;
    } catch {
      // A malformed/unallowlisted WAV helper URL must not block a valid
      // primary attachment URL.
    }
  }
  return attachment.url;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (cancelledResponseBodies.has(response)) return;
  cancelledResponseBodies.add(response);
  try {
    await response.body?.cancel();
  } catch {
    // A redirect body is disposable; do not mask the URL validation error.
  }
}

const cancelledResponseBodies = new WeakSet<Response>();

async function withTimeout<T>(promise: Promise<T>, controller: AbortController, timeoutMs = QQBOT_MEDIA_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(mediaError('download-timeout'));
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
  signal: AbortSignal,
): Promise<number> {
  if (!response.body) throw mediaError('invalid-media');
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > maxFileBytes || totalUsedBytes + declaredBytes > totalMaxBytes) {
      throw mediaError('download-too-large');
    }
  }

  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyCancelPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let abortRequested = false;
  const cancelBodyOnce = (): Promise<void> => {
    if (bodyCancelPromise) return bodyCancelPromise;
    if (cancelledResponseBodies.has(response)) {
      bodyCancelPromise = Promise.resolve();
    } else {
      cancelledResponseBodies.add(response);
      bodyCancelPromise = (reader
        ? reader.cancel()
        : response.body?.cancel())?.catch(() => {}) || Promise.resolve();
    }
    return bodyCancelPromise;
  };
  const closeFileOnce = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = file?.close().catch(() => {
      throw mediaError('storage-failed');
    }) || Promise.resolve();
    return closePromise;
  };
  const cancelOnAbort = () => {
    abortRequested = true;
    void cancelBodyOnce();
  };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  if (signal.aborted) cancelOnAbort();
  try {
    try {
      file = await fs.open(spoolPath, 'wx');
    } catch {
      if (abortRequested || signal.aborted) throw mediaError('download-timeout');
      throw mediaError('storage-failed');
    }
    if (abortRequested || signal.aborted) {
      await closeFileOnce();
      throw mediaError('download-timeout');
    }
  } catch (error) {
    signal.removeEventListener('abort', cancelOnAbort);
    await closeFileOnce();
    throw asMediaError(error, 'storage-failed');
  }
  try {
    reader = response.body.getReader();
  } catch {
    await closeFileOnce();
    throw mediaError('invalid-media');
  }
  if (abortRequested || signal.aborted) {
    await cancelBodyOnce();
    await closeFileOnce();
    signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
    throw mediaError('download-timeout');
  }
  let receivedBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      if (receivedBytes + chunk.length > maxFileBytes) {
        throw mediaError('download-too-large');
      }
      if (totalUsedBytes + receivedBytes + chunk.length > totalMaxBytes) {
        throw mediaError('download-too-large');
      }
      try {
        await file.write(chunk);
      } catch {
        throw mediaError('storage-failed');
      }
      receivedBytes += chunk.length;
    }
    if (signal.aborted) throw mediaError('download-timeout');
    return receivedBytes;
  } catch (error) {
    await cancelBodyOnce();
    throw asMediaError(error, 'download-failed');
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
    await closeFileOnce();
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
    let response: Response | undefined;
    let bodyPromise: Promise<number> | undefined;
    try {
      const fetchPromise = fetchFn(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        // Never forward the bot API Authorization token or user cookies.
        headers: { accept: '*/*' },
      });
      void fetchPromise.then(lateResponse => {
        if (controller.signal.aborted) void cancelResponseBody(lateResponse);
      }).catch(() => {});
      response = await withTimeout(fetchPromise, controller, timeoutMs);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw mediaError('invalid-media');
        if (redirect === QQBOT_MEDIA_MAX_REDIRECTS) throw mediaError('invalid-media');
        try {
          currentUrl = new URL(location, parsed).toString();
        } catch {
          throw mediaError('invalid-media');
        }
        await cancelResponseBody(response);
        continue;
      }

      if (!response.ok) {
        throw mediaError('download-failed');
      }

      bodyPromise = writeResponseBodyToSpool(
        response,
        spoolPath,
        maxFileBytes,
        totalUsedBytes,
        totalMaxBytes,
        controller.signal,
      );
      return await withTimeout(bodyPromise, controller, timeoutMs);
    } catch (error) {
      controller.abort();
      if (bodyPromise) await bodyPromise.catch(() => {});
      if (response) await cancelResponseBody(response);
      throw asMediaError(error, 'download-failed');
    }
  }
  throw mediaError('invalid-media');
}

async function probeRaster(spoolPath: string): Promise<{ mimeType: string; width?: number; height?: number } | undefined> {
  try {
    const metadata = await sharp(spoolPath, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
    const mimeType = metadata.format ? RASTER_MIME_BY_FORMAT[metadata.format] : undefined;
    if (!mimeType) return undefined;
    return {
      mimeType,
      width: typeof metadata.width === 'number' ? metadata.width : undefined,
      height: typeof metadata.height === 'number' ? metadata.height : undefined,
    };
  } catch {
    return undefined;
  }
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

function buildMainHostedOnlyErrorParts(
  content: string,
  attachments: unknown[],
  limits: QQBotMediaLimits,
  error = mediaError('isolated-unavailable'),
): MessagePart[] {
  const parts: MessagePart[] = [];
  if (content.trim()) parts.push({ text: content });
  for (let index = 0; index < attachments.length && index < limits.maxAttachments; index += 1) {
    const attachment = normalizeAttachment(attachments[index], index);
    if (!attachment) {
      parts.push({ text: malformedPreview(index) });
    } else if (attachment.mediaKind === 'unsupported') {
      parts.push(mediaErrorPart(attachmentPreview(attachment), mediaError('unsupported-media')));
    } else {
      parts.push(mediaErrorPart(attachmentPreview(attachment), error));
    }
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
  try {
    return await (deps?.saveInboundSessionFileFromPath || saveInboundSessionFileFromPath)(options);
  } catch (error) {
    if (error instanceof Error && error.message.includes('whole-buffer only')) {
      throw mediaError('isolated-unavailable');
    }
    throw mediaError('storage-failed');
  }
}

export async function materializeQQBotAttachments(options: QQBotMediaMaterializeOptions): Promise<MessagePart[]> {
  const limits = resolveLimits(options.config);
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const parts: MessagePart[] = [];
  if (options.content.trim()) parts.push({ text: options.content });

  let totalDownloaded = 0;
  let totalBoundReached = false;
  if (!options.deps?.saveInboundSessionFileFromPath) {
    try {
      const mainHosted = await (options.deps?.isMainHostedSession || isInboundSessionMainHosted)(options.sessionId);
      if (!mainHosted) return buildMainHostedOnlyErrorParts(options.content, attachments, limits);
    } catch {
      return buildMainHostedOnlyErrorParts(options.content, attachments, limits, mediaError('storage-failed'));
    }
  }
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
      parts.push(mediaErrorPart(label, mediaError('unsupported-media')));
      continue;
    }

    const canPotentiallyInlineImage = attachment.mediaKind === 'image';
    const downloadLimit = canPotentiallyInlineImage
      ? Math.max(limits.fileMaxBytes, limits.imageInlineMaxBytes)
      : limits.fileMaxBytes;
    const selectedUrl = selectAttachmentUrl(attachment);
    if (!selectedUrl) {
      parts.push(mediaErrorPart(label, mediaError('invalid-media')));
      continue;
    }
    if (attachment.declaredSize !== undefined && attachment.declaredSize > downloadLimit) {
      parts.push(mediaErrorPart(label, mediaError('download-too-large')));
      totalBoundReached = totalBoundReached || attachment.declaredSize > limits.totalMaxBytes;
      continue;
    }
    if (totalBoundReached || totalDownloaded >= limits.totalMaxBytes) {
      parts.push(mediaErrorPart(label, mediaError('download-too-large')));
      continue;
    }

    const remainingTotal = limits.totalMaxBytes - totalDownloaded;
    const fetchLimit = Math.min(downloadLimit, remainingTotal, QQBOT_MEDIA_HARD_MAX_BYTES);
    let spoolDir: string | undefined;
    try {
      try {
        spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-qqbot-media-'));
      } catch {
        throw mediaError('storage-failed');
      }
      const spoolPath = path.join(spoolDir, 'attachment.bin');
      const sizeBytes = await downloadBoundedMediaToFile(
        selectedUrl,
        spoolPath,
        fetchLimit,
        totalDownloaded,
        limits.totalMaxBytes,
        fetchFn,
        options.deps?.timeoutMs,
      );
      totalDownloaded += sizeBytes;

      const raster = sizeBytes <= limits.imageInlineMaxBytes
        ? await probeRaster(spoolPath)
        : undefined;
      const canInlineImage = Boolean(raster);
      if (!canInlineImage && sizeBytes > limits.fileMaxBytes) {
        throw mediaError('download-too-large');
      }
      if (canInlineImage) {
        const imageMeta = raster!;
        const saved = await saveInbound(options.deps, {
          sessionId: options.sessionId,
          platform: 'qqbot',
          sourcePath: spoolPath,
          sizeBytes,
          fileName: attachment.fileName,
          mimeType: imageMeta.mimeType,
          isImage: true,
        });
        // The only full-buffer media read is after the safe inline-image cap
        // and raster validation have both passed.
        let buffer: Buffer;
        try {
          buffer = await fs.readFile(spoolPath);
        } catch {
          throw mediaError('storage-failed');
        }
        parts.push({
          text: buildSavedFileText(saved, 'image'),
          inlineData: { mimeType: imageMeta.mimeType, data: buffer.toString('base64') },
          imageMeta: {
            imageId: makeImageId(options.eventId, attachment.index, buffer),
            mimeType: imageMeta.mimeType,
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
        const asrNote = attachment.asrReferText
          ? `\n[QQ voice ASR reference: ${attachment.asrReferText}]`
          : '';
        parts.push({ text: `${buildSavedFileText(saved, 'file')}${imageFallbackNote}${asrNote}` });
      }
    } catch (error) {
      const controlledError = asMediaError(error, 'download-failed');
      if (controlledError.category === 'download-too-large') {
        totalBoundReached = true;
      }
      parts.push(mediaErrorPart(label, controlledError));
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