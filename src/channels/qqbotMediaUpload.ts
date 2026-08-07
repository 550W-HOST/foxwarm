import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChannelFile } from '../channel';
import {
  QQBOT_MEDIA_DEFAULT_FILE_MAX_BYTES,
  QQBOT_MEDIA_DEFAULT_IMAGE_MAX_BYTES,
  QQBOT_MEDIA_HARD_MAX_BYTES,
  QQBOT_MEDIA_SAFE_INLINE_IMAGE_MAX_BYTES,
} from './qqbotMedia';

const HASH_READ_CHUNK_BYTES = 64 * 1024;
const MD5_10M_BYTES = 10_002_432;
const MAX_UPLOAD_PARTS = 4_096;
const MAX_UPLOAD_BLOCK_BYTES = QQBOT_MEDIA_HARD_MAX_BYTES;
const MAX_UPLOAD_ID_LENGTH = 256;
const MAX_FILE_INFO_LENGTH = 8_192;
const MAX_FILE_NAME_LENGTH = 160;
const MAX_UPLOAD_URL_LENGTH = 8_192;
const QQBOT_MEDIA_UPLOAD_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

const QQBOT_UPLOAD_HOST_SUFFIXES = [
  'myqcloud.com',
  'tencentcos.com',
  'tencentcos.cn',
];

type QQBotMediaTarget = 'c2c' | 'group';

type UploadRequest = (requestPath: string, body: Record<string, unknown>, maxResponseBytes?: number) => Promise<unknown>;

type QQBotMediaUploadDeps = {
  request: UploadRequest;
  fetch?: typeof fetch;
  isCurrent?: () => boolean;
};

type FileHashes = {
  md5: string;
  sha1: string;
  md5_10m: string;
};

type LocalFileSnapshot = {
  path: string;
  sizeBytes: number;
  dev: number;
  ino: number;
  hashes: FileHashes;
  header: Buffer;
};

type PreparedPart = {
  index: number;
  url: string;
  blockSize: number;
};

type ParsedPrepare = {
  uploadId: string;
  blockSize: number;
  parts: PreparedPart[];
};

export type QQBotMediaUploadResult = {
  fileInfo: string;
  fileType: 1 | 4;
  sizeBytes: number;
  isImage: boolean;
};

export type QQBotMediaUploadConfig = {
  imageMaxBytes?: number;
  fileMaxBytes?: number;
};

function normalizeLimit(value: unknown, fallback: number, hardMax = QQBOT_MEDIA_HARD_MAX_BYTES): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), hardMax);
}

function resolveUploadLimits(config?: QQBotMediaUploadConfig): { imageMaxBytes: number; fileMaxBytes: number } {
  return {
    imageMaxBytes: Math.min(
      normalizeLimit(config?.imageMaxBytes, QQBOT_MEDIA_DEFAULT_IMAGE_MAX_BYTES),
      QQBOT_MEDIA_SAFE_INLINE_IMAGE_MAX_BYTES,
    ),
    fileMaxBytes: normalizeLimit(config?.fileMaxBytes, QQBOT_MEDIA_DEFAULT_FILE_MAX_BYTES),
  };
}

function safeFileName(value: unknown): string {
  const raw = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  const base = path.basename(raw).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/u, '').slice(0, MAX_FILE_NAME_LENGTH);
  return base || 'qqbot-file';
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function assertUploadCurrent(deps: QQBotMediaUploadDeps): void {
  if (deps.isCurrent && !deps.isCurrent()) {
    throw new Error('QQ Bot media send was invalidated before final delivery');
  }
}

function isTencentUploadHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return QQBOT_UPLOAD_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

function validatePresignedUploadUrl(value: unknown): string {
  const raw = boundedString(value, MAX_UPLOAD_URL_LENGTH);
  if (!raw) throw new Error('QQ Bot upload response has an invalid part URL');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('QQ Bot upload response has an invalid part URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new Error('QQ Bot upload response has an unsafe part URL');
  }
  if (!isTencentUploadHost(parsed.hostname)) {
    throw new Error('QQ Bot upload response has an untrusted part URL host');
  }
  return raw;
}

function assertRegularSnapshot(linkStats: any, fileStats: any): void {
  if (!linkStats.isFile() || !fileStats.isFile()) {
    throw new Error('QQ Bot file source must be a regular file');
  }
  if (typeof linkStats.dev === 'number' && typeof fileStats.dev === 'number'
    && typeof linkStats.ino === 'number' && typeof fileStats.ino === 'number'
    && (linkStats.dev !== fileStats.dev || linkStats.ino !== fileStats.ino)) {
    throw new Error('QQ Bot file source changed while it was being opened');
  }
}

async function inspectLocalFile(file: ChannelFile): Promise<LocalFileSnapshot> {
  const sourcePath = path.resolve(file.path);
  const linkStats = await fs.lstat(sourcePath);
  if (!linkStats.isFile()) throw new Error('QQ Bot file source must be a regular file');
  const handle = await fs.open(sourcePath, 'r');
  try {
    const fileStats = await handle.stat();
    assertRegularSnapshot(linkStats, fileStats);
    if (fileStats.size <= 0) throw new Error('QQ Bot cannot upload an empty file');

    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    const md5_10m = crypto.createHash('md5');
    const header = Buffer.alloc(16);
    let headerBytes = 0;
    let offset = 0;
    let firstTenMb = 0;
    while (offset < fileStats.size) {
      const length = Math.min(HASH_READ_CHUNK_BYTES, fileStats.size - offset);
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) throw new Error('QQ Bot file changed while it was being read');
      const chunk = buffer.subarray(0, result.bytesRead);
      md5.update(chunk);
      sha1.update(chunk);
      if (firstTenMb < MD5_10M_BYTES) {
        const hashLength = Math.min(chunk.length, MD5_10M_BYTES - firstTenMb);
        md5_10m.update(chunk.subarray(0, hashLength));
        firstTenMb += hashLength;
      }
      if (headerBytes < header.length) {
        const headerLength = Math.min(chunk.length, header.length - headerBytes);
        chunk.copy(header, headerBytes, 0, headerLength);
        headerBytes += headerLength;
      }
      offset += result.bytesRead;
    }
    return {
      path: sourcePath,
      sizeBytes: fileStats.size,
      dev: fileStats.dev,
      ino: fileStats.ino,
      hashes: { md5: md5.digest('hex'), sha1: sha1.digest('hex'), md5_10m: md5_10m.digest('hex') },
      header,
    };
  } finally {
    await handle.close();
  }
}

function isSafeRasterImage(file: ChannelFile, snapshot: LocalFileSnapshot): boolean {
  if (!file.isImage) return false;
  const mimeType = String(file.mimeType || '').toLowerCase();
  const png = mimeType === 'image/png'
    && snapshot.header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = mimeType === 'image/jpeg'
    && snapshot.header[0] === 0xff && snapshot.header[1] === 0xd8 && snapshot.header[2] === 0xff;
  return png || jpeg;
}

function buildPath(target: QQBotMediaTarget, targetId: string, suffix: string): string {
  const encoded = encodeURIComponent(targetId);
  return target === 'c2c' ? `/v2/users/${encoded}/${suffix}` : `/v2/groups/${encoded}/${suffix}`;
}

function parsePositiveInteger(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`QQ Bot upload response has an invalid ${label}`);
  }
  return value;
}

function parsePrepareResponse(raw: unknown, fileSize: number): ParsedPrepare {
  if (!raw || typeof raw !== 'object') throw new Error('QQ Bot upload_prepare returned an invalid response');
  const value = raw as Record<string, unknown>;
  const uploadId = boundedString(value.upload_id, MAX_UPLOAD_ID_LENGTH);
  if (!uploadId) throw new Error('QQ Bot upload_prepare returned no upload_id');
  const blockSize = parsePositiveInteger(value.block_size, 'block_size', MAX_UPLOAD_BLOCK_BYTES);
  if (!Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > MAX_UPLOAD_PARTS) {
    throw new Error('QQ Bot upload_prepare returned an invalid part list');
  }
  const expectedPartCount = Math.ceil(fileSize / blockSize);
  if (value.parts.length !== expectedPartCount) {
    throw new Error('QQ Bot upload_prepare returned an incomplete part list');
  }
  const parts = value.parts.map((rawPart, position) => {
    if (!rawPart || typeof rawPart !== 'object') throw new Error('QQ Bot upload_prepare returned an invalid part');
    const part = rawPart as Record<string, unknown>;
    const index = parsePositiveInteger(part.index, 'part index', MAX_UPLOAD_PARTS);
    if (index !== position + 1) throw new Error('QQ Bot upload_prepare returned out-of-order parts');
    const partBlockSize = part.block_size === undefined || part.block_size === 0
      ? blockSize
      : parsePositiveInteger(part.block_size, 'part block_size', MAX_UPLOAD_BLOCK_BYTES);
    if (partBlockSize > blockSize) throw new Error('QQ Bot upload response has an oversized part range');
    return { index, url: validatePresignedUploadUrl(part.presigned_url ?? part.url), blockSize: partBlockSize };
  });
  return { uploadId, blockSize, parts };
}

async function hashPart(snapshot: LocalFileSnapshot, offset: number, length: number): Promise<string> {
  const handle = await fs.open(snapshot.path, 'r');
  try {
    const digest = crypto.createHash('md5');
    let position = offset;
    let remaining = length;
    while (remaining > 0) {
      const readLength = Math.min(HASH_READ_CHUNK_BYTES, remaining);
      const buffer = Buffer.alloc(readLength);
      const result = await handle.read(buffer, 0, readLength, position);
      if (result.bytesRead !== readLength) throw new Error('QQ Bot file changed while a part was being read');
      digest.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
      remaining -= result.bytesRead;
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

async function openPartBody(snapshot: LocalFileSnapshot, offset: number, length: number): Promise<{ body: ReadableStream<Uint8Array>; close: () => Promise<void> }> {
  const linkStats = await fs.lstat(snapshot.path);
  const handle = await fs.open(snapshot.path, 'r');
  try {
    const fileStats = await handle.stat();
    assertRegularSnapshot(linkStats, fileStats);
    if (fileStats.size !== snapshot.sizeBytes) throw new Error('QQ Bot file changed while it was being uploaded');
  } catch (error) {
    await handle.close();
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  let position = offset;
  let remaining = length;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (remaining === 0) {
          await close();
          controller.close();
          return;
        }
        const readLength = Math.min(HASH_READ_CHUNK_BYTES, remaining);
        const buffer = Buffer.alloc(readLength);
        const result = await handle.read(buffer, 0, readLength, position);
        if (result.bytesRead !== readLength) throw new Error('QQ Bot file changed while it was being uploaded');
        position += result.bytesRead;
        remaining -= result.bytesRead;
        controller.enqueue(buffer.subarray(0, result.bytesRead));
        if (remaining === 0) {
          await close();
          controller.close();
        }
      } catch (error) {
        await close().catch(() => {});
        controller.error(error);
      }
    },
    cancel() {
      void close().catch(() => {});
    },
  });
  return { body, close };
}

async function uploadPart(
  snapshot: LocalFileSnapshot,
  part: PreparedPart,
  fileSize: number,
  blockSize: number,
  fetchFn: typeof fetch,
  isCurrent?: () => boolean,
): Promise<string> {
  if (isCurrent && !isCurrent()) throw new Error('QQ Bot media send was invalidated before final delivery');
  const offset = (part.index - 1) * blockSize;
  const length = Math.min(part.blockSize, fileSize - offset);
  if (offset < 0 || length <= 0 || offset + length > fileSize) {
    throw new Error('QQ Bot upload response has an invalid part range');
  }
  const md5 = await hashPart(snapshot, offset, length);
  if (isCurrent && !isCurrent()) throw new Error('QQ Bot media send was invalidated before final delivery');
  const partBody = await openPartBody(snapshot, offset, length);
  try {
    if (isCurrent && !isCurrent()) throw new Error('QQ Bot media send was invalidated before final delivery');
    const response = await fetchFn(part.url, {
      method: 'PUT',
      redirect: 'error',
      headers: {
        'Content-Length': String(length),
      },
      body: partBody.body as any,
      duplex: 'half',
    } as any);
    if (!response.ok || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`QQ Bot media part upload failed (${response.status})`);
    }
  } catch (error) {
    await partBody.close().catch(() => {});
    if (error instanceof Error && error.message.startsWith('QQ Bot media part upload failed')) throw error;
    throw new Error('QQ Bot media part upload failed');
  }
  await partBody.close();

  // The caller sends upload_part_finish only after the PUT has completed. The
  // hash is returned separately so this helper never buffers a whole part.
  return md5;
}

export async function uploadQQBotFile(
  target: QQBotMediaTarget,
  targetId: string,
  file: ChannelFile,
  config: QQBotMediaUploadConfig | undefined,
  deps: QQBotMediaUploadDeps,
): Promise<QQBotMediaUploadResult> {
  if (target !== 'c2c' && target !== 'group') throw new Error('QQ Bot media upload is unsupported for this destination');
  const fetchFn = deps.fetch || globalThis.fetch;
  if (!fetchFn) throw new Error('QQ Bot media upload requires a fetch-capable runtime');
  assertUploadCurrent(deps);
  const snapshot = await inspectLocalFile(file);
  assertUploadCurrent(deps);
  const limits = resolveUploadLimits(config);
  const safeImage = isSafeRasterImage(file, snapshot);
  const sendAsImage = safeImage && snapshot.sizeBytes <= limits.imageMaxBytes;
  const fileType: 1 | 4 = sendAsImage ? 1 : 4;
  if ((!sendAsImage && snapshot.sizeBytes > limits.fileMaxBytes)
    || snapshot.sizeBytes > QQBOT_MEDIA_HARD_MAX_BYTES) {
    throw new Error('QQ Bot file exceeds the configured media limit');
  }

  const fileName = safeFileName(file.name);
  assertUploadCurrent(deps);
  const prepareRaw = await deps.request(buildPath(target, targetId, 'upload_prepare'), {
    file_type: fileType,
    file_size: snapshot.sizeBytes,
    file_name: fileName,
    ...snapshot.hashes,
  }, QQBOT_MEDIA_UPLOAD_RESPONSE_MAX_BYTES);
  const prepared = parsePrepareResponse(prepareRaw, snapshot.sizeBytes);
  for (const part of prepared.parts) {
    assertUploadCurrent(deps);
    const md5 = await uploadPart(snapshot, part, snapshot.sizeBytes, prepared.blockSize, fetchFn, deps.isCurrent);
    assertUploadCurrent(deps);
    await deps.request(buildPath(target, targetId, 'upload_part_finish'), {
      upload_id: prepared.uploadId,
      part_index: part.index,
      block_size: Math.min(part.blockSize, snapshot.sizeBytes - ((part.index - 1) * prepared.blockSize)),
      md5,
    }, QQBOT_MEDIA_UPLOAD_RESPONSE_MAX_BYTES);
  }
  assertUploadCurrent(deps);
  const completeRaw = await deps.request(buildPath(target, targetId, 'files'), { upload_id: prepared.uploadId }, QQBOT_MEDIA_UPLOAD_RESPONSE_MAX_BYTES);
  if (!completeRaw || typeof completeRaw !== 'object') throw new Error('QQ Bot media upload completion returned an invalid response');
  const fileInfo = boundedString((completeRaw as Record<string, unknown>).file_info, MAX_FILE_INFO_LENGTH);
  if (!fileInfo) throw new Error('QQ Bot media upload completion returned no file_info');
  return { fileInfo, fileType, sizeBytes: snapshot.sizeBytes, isImage: sendAsImage };
}
