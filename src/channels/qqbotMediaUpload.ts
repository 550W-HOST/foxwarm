import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { ChannelFile } from '../channel';
import {
  QQBOT_MEDIA_DEFAULT_FILE_MAX_BYTES,
  QQBOT_MEDIA_DEFAULT_IMAGE_MAX_BYTES,
  QQBOT_MEDIA_SAFE_INLINE_IMAGE_MAX_BYTES,
} from './qqbotMedia';

const HASH_READ_CHUNK_BYTES = 64 * 1024;
const MD5_10M_BYTES = 10_002_432;
const MAX_UPLOAD_PARTS = 4_096;
export const QQBOT_MEDIA_OUTBOUND_HARD_MAX_BYTES = 100 * 1024 * 1024;
export const QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BLOCK_BYTES = QQBOT_MEDIA_OUTBOUND_HARD_MAX_BYTES;
const MAX_UPLOAD_ID_LENGTH = 256;
const MAX_FILE_INFO_LENGTH = 8_192;
const MAX_FILE_NAME_LENGTH = 160;
const MAX_UPLOAD_URL_LENGTH = 8_192;
const QQBOT_MEDIA_UPLOAD_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const QQBOT_MEDIA_PART_TIMEOUT_MS = 20_000;

type QQBotMediaTarget = 'c2c' | 'group';

type UploadRequest = (requestPath: string, body: Record<string, unknown>, maxResponseBytes?: number) => Promise<unknown>;

type QQBotMediaUploadDeps = {
  request: UploadRequest;
  fetch?: typeof fetch;
  isCurrent?: () => boolean;
  partTimeoutMs?: number;
};

type FileHashes = {
  md5: string;
  sha1: string;
  md5_10m: string;
};

type LocalFileSnapshot = {
  path: string;
  sizeBytes: number;
  hashes?: FileHashes;
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

function normalizeLimit(value: unknown, fallback: number, hardMax = QQBOT_MEDIA_OUTBOUND_HARD_MAX_BYTES): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), hardMax);
}

function resolveUploadLimits(config?: QQBotMediaUploadConfig): { imageMaxBytes: number; fileMaxBytes: number } {
  return {
    imageMaxBytes: Math.min(
      normalizeLimit(config?.imageMaxBytes, QQBOT_MEDIA_DEFAULT_IMAGE_MAX_BYTES),
      QQBOT_MEDIA_SAFE_INLINE_IMAGE_MAX_BYTES,
    ),
    fileMaxBytes: normalizeLimit(config?.fileMaxBytes, QQBOT_MEDIA_DEFAULT_FILE_MAX_BYTES, QQBOT_MEDIA_OUTBOUND_HARD_MAX_BYTES),
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
  return raw;
}

function assertRegularFile(fileStats: any): void {
  if (!fileStats.isFile()) {
    throw new Error('QQ Bot file source must be a regular file');
  }
}

async function inspectLocalFile(file: ChannelFile): Promise<LocalFileSnapshot> {
  const sourcePath = path.resolve(file.path);
  const linkStats = await fs.lstat(sourcePath);
  if (!linkStats.isFile()) throw new Error('QQ Bot file source must be a regular file');
  const handle = await fs.open(sourcePath, 'r');
  try {
    const fileStats = await handle.stat();
    assertRegularFile(fileStats);
    if (fileStats.size <= 0) throw new Error('QQ Bot cannot upload an empty file');
    return { path: sourcePath, sizeBytes: fileStats.size };
  } finally {
    await handle.close();
  }
}

async function readSmallFile(snapshot: LocalFileSnapshot): Promise<Buffer> {
  const handle = await fs.open(snapshot.path, 'r');
  try {
    const fileStats = await handle.stat();
    assertRegularFile(fileStats);
    if (fileStats.size !== snapshot.sizeBytes || fileStats.size >= QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES) {
      throw new Error('QQ Bot file changed while it was being read');
    }
    const buffer = Buffer.alloc(snapshot.sizeBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead <= 0) {
        throw new Error('QQ Bot file changed while it was being read');
      }
      offset += result.bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function hashFile(snapshot: LocalFileSnapshot): Promise<FileHashes> {
  const handle = await fs.open(snapshot.path, 'r');
  try {
    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    const md5_10m = crypto.createHash('md5');
    let offset = 0;
    let firstTenMb = 0;
    while (offset < snapshot.sizeBytes) {
      const length = Math.min(HASH_READ_CHUNK_BYTES, snapshot.sizeBytes - offset);
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
      offset += result.bytesRead;
    }
    return { md5: md5.digest('hex'), sha1: sha1.digest('hex'), md5_10m: md5_10m.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function hasValidBmpHeader(snapshot: LocalFileSnapshot): Promise<boolean> {
  if (snapshot.sizeBytes < 26) return false;
  const handle = await fs.open(snapshot.path, 'r');
  try {
    const header = Buffer.alloc(Math.min(snapshot.sizeBytes, 138));
    const result = await handle.read(header, 0, header.length, 0);
    if (result.bytesRead !== header.length || header.toString('ascii', 0, 2) !== 'BM') return false;
    const declaredSize = header.readUInt32LE(2);
    const pixelOffset = header.readUInt32LE(10);
    const dibSize = header.readUInt32LE(14);
    if (declaredSize < 26 || declaredSize > snapshot.sizeBytes || pixelOffset >= declaredSize) return false;
    let width: number;
    let height: number;
    let bitsPerPixel: number;
    if (dibSize === 12) {
      if (pixelOffset < 26 || header.readUInt16LE(22) !== 1) return false;
      width = header.readUInt16LE(18);
      height = header.readUInt16LE(20);
      bitsPerPixel = header.readUInt16LE(24);
      if (width <= 0 || height <= 0 || bitsPerPixel !== 24) return false;
    } else {
      if (dibSize < 40 || dibSize > 124 || header.length < 54 || pixelOffset < 14 + dibSize) return false;
      width = header.readInt32LE(18);
      height = header.readInt32LE(22);
      bitsPerPixel = header.readUInt16LE(28);
      if (width <= 0
        || height === 0
        || header.readUInt16LE(26) !== 1
        || ![24, 32].includes(bitsPerPixel)
        || header.readUInt32LE(30) !== 0) {
        return false;
      }
    }
    const rowStride = ((BigInt(width) * BigInt(bitsPerPixel) + 31n) / 32n) * 4n;
    const requiredPixelSpan = rowStride * BigInt(Math.abs(height));
    const requiredEnd = BigInt(pixelOffset) + requiredPixelSpan;
    return requiredPixelSpan > 0n
      && requiredEnd <= BigInt(declaredSize)
      && requiredEnd <= BigInt(snapshot.sizeBytes);
  } finally {
    await handle.close();
  }
}

async function probeOfficialQQImage(snapshot: LocalFileSnapshot): Promise<boolean> {
  try {
    const metadata = await sharp(snapshot.path, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
    if (metadata.format === 'png' || metadata.format === 'jpeg' || metadata.format === 'gif' || metadata.format === 'webp') {
      return true;
    }
  } catch {
    // This Sharp/libvips build may not include its optional BMP loader.
  }
  return hasValidBmpHeader(snapshot);
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
    const partBlockSize = part.block_size === undefined
      ? blockSize
      : parsePositiveInteger(part.block_size, 'part block_size', MAX_UPLOAD_BLOCK_BYTES);
    if (partBlockSize > blockSize) throw new Error('QQ Bot upload response has an oversized part range');
    return { index, url: validatePresignedUploadUrl(part.presigned_url ?? part.url), blockSize: partBlockSize };
  });
  return { uploadId, blockSize, parts };
}

function parseFileInfoResponse(raw: unknown, label: string): string {
  if (!raw || typeof raw !== 'object') throw new Error(`QQ Bot ${label} returned an invalid response`);
  const fileInfo = boundedString((raw as Record<string, unknown>).file_info, MAX_FILE_INFO_LENGTH);
  if (!fileInfo) throw new Error(`QQ Bot ${label} returned no file_info`);
  return fileInfo;
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
  if (!linkStats.isFile()) throw new Error('QQ Bot file source must be a regular file');
  const handle = await fs.open(snapshot.path, 'r');
  try {
    const fileStats = await handle.stat();
    assertRegularFile(fileStats);
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

function disposeResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // The response body is not part of the rich-media payload.
  }
}

async function uploadPart(
  snapshot: LocalFileSnapshot,
  part: PreparedPart,
  fileSize: number,
  blockSize: number,
  fetchFn: typeof fetch,
  isCurrent?: () => boolean,
  timeoutMs = QQBOT_MEDIA_PART_TIMEOUT_MS,
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
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  let fetchPromise: Promise<Response>;
  if (isCurrent && !isCurrent()) {
    await partBody.close().catch(() => {});
    throw new Error('QQ Bot media send was invalidated before final delivery');
  }
  try {
    fetchPromise = Promise.resolve(fetchFn(part.url, {
      method: 'PUT',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Length': String(length),
      },
      body: partBody.body as any,
      duplex: 'half',
    } as any));
  } catch (error) {
    await partBody.close().catch(() => {});
    throw new Error('QQ Bot media part upload failed');
  }
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void partBody.close().catch(() => {});
      reject(new Error('QQ Bot media part upload timed out'));
    }, timeoutMs);
  });
  void fetchPromise.then(lateResponse => {
    if (timedOut) disposeResponseBody(lateResponse);
  }).catch(() => {});
  try {
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    disposeResponseBody(response);
    if (!response.ok || response.status >= 300) {
      throw new Error(`QQ Bot media part upload failed (${response.status})`);
    }
  } catch (error) {
    await partBody.close().catch(() => {});
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) throw new Error('QQ Bot media part upload timed out');
    if (error instanceof Error && error.message.startsWith('QQ Bot media part upload failed')) throw error;
    throw new Error('QQ Bot media part upload failed');
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);
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
  assertUploadCurrent(deps);
  const snapshot = await inspectLocalFile(file);
  assertUploadCurrent(deps);
  const limits = resolveUploadLimits(config);
  if (snapshot.sizeBytes > QQBOT_MEDIA_OUTBOUND_HARD_MAX_BYTES) {
    throw new Error('QQ Bot file exceeds the configured media limit');
  }
  const safeImage = snapshot.sizeBytes <= limits.imageMaxBytes
    && await probeOfficialQQImage(snapshot);
  const sendAsImage = safeImage && snapshot.sizeBytes <= limits.imageMaxBytes;
  const fileType: 1 | 4 = sendAsImage ? 1 : 4;
  if (!sendAsImage && snapshot.sizeBytes > limits.fileMaxBytes) {
    throw new Error('QQ Bot file exceeds the configured media limit');
  }

  if (snapshot.sizeBytes < QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES) {
    assertUploadCurrent(deps);
    const data = await readSmallFile(snapshot);
    assertUploadCurrent(deps);
    const directBody: Record<string, unknown> = {
      file_type: fileType,
      srv_send_msg: false,
      file_data: data.toString('base64'),
      ...(fileType === 4 ? { file_name: safeFileName(file.name) } : {}),
    };
    const directRaw = await deps.request(buildPath(target, targetId, 'files'), directBody, QQBOT_MEDIA_UPLOAD_RESPONSE_MAX_BYTES);
    assertUploadCurrent(deps);
    const fileInfo = parseFileInfoResponse(directRaw, 'direct media upload');
    return { fileInfo, fileType, sizeBytes: snapshot.sizeBytes, isImage: sendAsImage };
  }

  if (!fetchFn) throw new Error('QQ Bot media upload requires a fetch-capable runtime');

  snapshot.hashes = await hashFile(snapshot);
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
    const md5 = await uploadPart(snapshot, part, snapshot.sizeBytes, prepared.blockSize, fetchFn, deps.isCurrent, deps.partTimeoutMs);
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
  const fileInfo = parseFileInfoResponse(completeRaw, 'media upload completion');
  return { fileInfo, fileType, sizeBytes: snapshot.sizeBytes, isImage: sendAsImage };
}
