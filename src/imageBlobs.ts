import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import { IMAGE_BLOBS_DIR, STATE_DIR } from './config';
import { InlineData, InlineDataRef, Message, MessagePart, QueueItem } from './types';

const BLOB_ID_RE = /^([a-f0-9]{64})\.(png|jpg|gif|webp|svg|bin)$/;
const SAFE_RASTER_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const PROVIDER_NORMALIZED_HEIF_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

interface LibHeifEnumValue {
  value: number;
}

interface LibHeifError {
  code: LibHeifEnumValue;
  message?: string;
}

interface LibHeifChannel {
  id: LibHeifEnumValue;
  width: number;
  height: number;
  stride: number;
  data: Uint8Array;
}

interface LibHeifModule {
  heif_filetype_result: { heif_filetype_yes_supported: LibHeifEnumValue };
  heif_error_code: { heif_error_Ok: LibHeifEnumValue };
  heif_colorspace: { heif_colorspace_RGB: LibHeifEnumValue };
  heif_chroma: { heif_chroma_interleaved_RGBA: LibHeifEnumValue };
  heif_channel: { heif_channel_interleaved: LibHeifEnumValue };
  heif_js_check_filetype(data: Buffer): LibHeifEnumValue;
  heif_context_alloc(): object;
  heif_context_free(context: object): void;
  heif_context_read_from_memory(context: object, data: Buffer): LibHeifError;
  heif_js_context_get_primary_image_handle(context: object): object | LibHeifError;
  heif_image_handle_release(handle: object): void;
  heif_image_handle_get_width(handle: object): number;
  heif_image_handle_get_height(handle: object): number;
  heif_js_decode_image2(handle: object, colorspace: LibHeifEnumValue, chroma: LibHeifEnumValue): {
    image?: object;
    channels?: LibHeifChannel[];
    code?: LibHeifEnumValue;
    message?: string;
  };
  heif_image_release(image: object): void;
}

let cachedLibHeif: LibHeifModule | undefined;

function getLibHeif(): LibHeifModule {
  if (!cachedLibHeif) {
    // Lazy loading avoids initializing the bundled decoder for requests that
    // contain only provider-native image formats.
    cachedLibHeif = require('libheif-js/wasm-bundle') as LibHeifModule;
  }
  return cachedLibHeif;
}

function normalizeMimeType(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : 'application/octet-stream';
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/svg+xml') return 'svg';
  return 'bin';
}

export function getSafeRasterMimeType(blobId: string): string | null {
  const match = BLOB_ID_RE.exec(blobId);
  return match ? SAFE_RASTER_MIME_BY_EXTENSION[match[2]] || null : null;
}

export function resolveImageBlobPath(blobId: string): string {
  const match = BLOB_ID_RE.exec(blobId);
  if (!match) {
    throw new Error('Invalid image blob id.');
  }
  return path.join(IMAGE_BLOBS_DIR, match[1].slice(0, 2), blobId);
}

function decodeInlineData(inlineData: InlineData): Buffer {
  const compact = String(inlineData.data || '').replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('Invalid inline image base64 payload.');
  }
  const buffer = Buffer.from(compact, 'base64');
  const canonicalInput = compact.replace(/=+$/u, '');
  if (buffer.toString('base64').replace(/=+$/u, '') !== canonicalInput) {
    throw new Error('Invalid inline image base64 payload.');
  }
  return buffer;
}

async function probeSafeRaster(buffer: Buffer, mimeType: string): Promise<{ width?: number; height?: number }> {
  if (!Object.values(SAFE_RASTER_MIME_BY_EXTENSION).includes(mimeType)) return {};
  const metadata = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  const expected = extensionForMimeType(mimeType);
  const actual = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
  if (actual !== expected) {
    throw new Error(`Image bytes do not match declared MIME type ${mimeType}.`);
  }
  return {
    width: typeof metadata.width === 'number' ? metadata.width : undefined,
    height: typeof metadata.height === 'number' ? metadata.height : undefined,
  };
}

function isLibHeifError(value: object | LibHeifError): value is LibHeifError {
  return Object.prototype.hasOwnProperty.call(value, 'code');
}

async function normalizeHeifForProvider(buffer: Buffer, imageId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  let context: object | undefined;
  let handle: object | undefined;
  let decodedImage: object | undefined;
  try {
    const libheif = getLibHeif();
    const fileType = libheif.heif_js_check_filetype(buffer);
    if (fileType.value !== libheif.heif_filetype_result.heif_filetype_yes_supported.value) {
      throw new Error('invalid or unsupported HEIF data');
    }

    context = libheif.heif_context_alloc();
    const readResult = libheif.heif_context_read_from_memory(context, buffer);
    if (readResult.code.value !== libheif.heif_error_code.heif_error_Ok.value) {
      throw new Error('invalid or unsupported HEIF data');
    }

    const handleResult = libheif.heif_js_context_get_primary_image_handle(context);
    if (!handleResult || isLibHeifError(handleResult)) {
      throw new Error('missing primary HEIF image');
    }
    handle = handleResult;

    const width = libheif.heif_image_handle_get_width(handle);
    const height = libheif.heif_image_handle_get_height(handle);
    const pixels = width * height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error('invalid image dimensions');
    }
    if (!Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_PIXELS) {
      throw new Error('image exceeds the 64-megapixel limit');
    }

    const decoded = libheif.heif_js_decode_image2(
      handle,
      libheif.heif_colorspace.heif_colorspace_RGB,
      libheif.heif_chroma.heif_chroma_interleaved_RGBA,
    );
    if (!decoded || decoded.code || !decoded.image || !Array.isArray(decoded.channels)) {
      throw new Error('HEIF pixel decoding failed');
    }
    decodedImage = decoded.image;

    const channel = decoded.channels.find(item => (
      item.id.value === libheif.heif_channel.heif_channel_interleaved.value
    ));
    const rowBytes = width * 4;
    if (!channel
      || channel.width !== width
      || channel.height !== height
      || channel.stride < rowBytes
      || channel.data.length < channel.stride * height) {
      throw new Error('HEIF pixel decoding returned invalid data');
    }

    const rgba = Buffer.allocUnsafe(pixels * 4);
    for (let row = 0; row < height; row += 1) {
      rgba.set(channel.data.subarray(row * channel.stride, row * channel.stride + rowBytes), row * rowBytes);
    }
    let hasTransparency = false;
    for (let offset = 3; offset < rgba.length; offset += 4) {
      if (rgba[offset] !== 255) {
        hasTransparency = true;
        break;
      }
    }

    const raster = sharp(rgba, {
      raw: { width, height, channels: 4 },
      limitInputPixels: MAX_IMAGE_PIXELS,
    });
    if (hasTransparency) {
      return { buffer: await raster.png().toBuffer(), mimeType: 'image/png' };
    }
    return {
      buffer: await raster.jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer(),
      mimeType: 'image/jpeg',
    };
  } catch (error: any) {
    const detail = typeof error?.message === 'string' && error.message
      ? error.message
      : 'invalid or unsupported HEIF data';
    throw new Error(`Unable to normalize HEIC/HEIF image ${imageId || '(unknown)'} for provider: ${detail}.`);
  } finally {
    const libheif = cachedLibHeif;
    if (decodedImage && libheif) libheif.heif_image_release(decodedImage);
    if (handle && libheif) libheif.heif_image_handle_release(handle);
    if (context && libheif) libheif.heif_context_free(context);
  }
}

function buildImageId(message: Message, part: MessagePart, partIndex: number): string {
  if (part.imageMeta?.imageId) return part.imageMeta.imageId;
  if (part.inlineDataRef?.imageId) return part.inlineDataRef.imageId;
  const seq = message.__meta?.seq;
  if (typeof seq === 'number' && seq > 0) {
    return `msg${String(seq).padStart(8, '0')}_part${partIndex + 1}`;
  }
  return `image_${crypto.randomUUID()}`;
}

function normalizeNestedToolImage(value: any): InlineData | null {
  if (!value || typeof value !== 'object' || typeof value.data !== 'string') return null;
  const mimeType = normalizeMimeType(value.mimeType || value.mime_type);
  if (!mimeType.startsWith('image/')) return null;
  return { ...value, data: value.data, mimeType };
}

function hasNestedToolImages(part: MessagePart): boolean {
  const response = part.functionResponse?.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  if (normalizeNestedToolImage(response.inlineData)) return true;
  return Array.isArray(response.inlineDataItems)
    && response.inlineDataItems.some((item: any) => !!normalizeNestedToolImage(item));
}

function stripProviderImageHelperFields(part: MessagePart): { part: MessagePart; changed: boolean } {
  const hasIdentity = Object.prototype.hasOwnProperty.call(part, '__providerImageIdentity');
  const hasDeduplicated = Object.prototype.hasOwnProperty.call(part, '__providerImageDeduplicated');
  if (!hasIdentity && !hasDeduplicated) return { part, changed: false };
  const {
    __providerImageIdentity: _providerImageIdentity,
    __providerImageDeduplicated: _providerImageDeduplicated,
    ...clean
  } = part;
  return { part: clean, changed: true };
}

export function stripReservedProviderImageHelperFields(messages: Message[]): Message[] {
  let changed = false;
  const stripped = messages.map(message => {
    let messageChanged = false;
    const parts = message.parts.map(part => {
      const result = stripProviderImageHelperFields(part);
      messageChanged ||= result.changed;
      return result.part;
    });
    changed ||= messageChanged;
    return messageChanged ? { ...message, parts } : message;
  });
  return changed ? stripped : messages;
}

function extractNestedToolImages(part: MessagePart): { part: MessagePart; imageParts: MessagePart[] } | null {
  const functionResponse = part.functionResponse;
  const response = functionResponse?.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;

  const images: InlineData[] = [];
  const single = normalizeNestedToolImage(response.inlineData);
  if (single) images.push(single);
  if (Array.isArray(response.inlineDataItems)) {
    for (const item of response.inlineDataItems) {
      const normalized = normalizeNestedToolImage(item);
      if (normalized) images.push(normalized);
    }
  }
  if (images.length === 0) return null;

  const { inlineData: _inlineData, inlineDataItems: _inlineDataItems, ...businessResponse } = response;
  const toolUseId = String(functionResponse.tool_use_id || part.toolUseId || 'tool');
  return {
    part: {
      ...part,
      functionResponse: { ...functionResponse, response: businessResponse },
    },
    imageParts: images.map((inlineData, index) => ({
      toolUseId,
      inlineData,
      imageMeta: {
        imageId: `${toolUseId.trim() || 'tool'}#${index + 1}`,
        mimeType: inlineData.mimeType,
      },
    })),
  };
}

export async function putImageBlob(options: {
  buffer: Buffer;
  mimeType: string;
  imageId: string;
  width?: number;
  height?: number;
}): Promise<InlineDataRef> {
  const mimeType = normalizeMimeType(options.mimeType);
  const detected = await probeSafeRaster(options.buffer, mimeType);
  const sha256 = crypto.createHash('sha256').update(options.buffer).digest('hex');
  const format = extensionForMimeType(mimeType);
  const blobId = `${sha256}.${format}`;
  const blobPath = resolveImageBlobPath(blobId);
  await fs.ensureDir(path.dirname(blobPath));

  if (await fs.pathExists(blobPath)) {
    const existing = await fs.readFile(blobPath);
    const existingHash = crypto.createHash('sha256').update(existing).digest('hex');
    if (existing.length !== options.buffer.length || existingHash !== sha256) {
      throw new Error(`Existing image blob ${blobId} failed integrity validation.`);
    }
  } else {
    const tempPath = `${blobPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tempPath, options.buffer, { flag: 'wx' });
    try {
      await fs.rename(tempPath, blobPath);
    } catch (error: any) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      const existing = await fs.readFile(blobPath);
      const existingHash = crypto.createHash('sha256').update(existing).digest('hex');
      if (existing.length !== options.buffer.length || existingHash !== sha256) throw error;
    } finally {
      await fs.remove(tempPath).catch(() => {});
    }
  }

  return {
    imageId: options.imageId,
    blobId,
    format,
    mimeType,
    byteLength: options.buffer.length,
    sha256,
    width: options.width ?? detected.width,
    height: options.height ?? detected.height,
  };
}

function resolveLegacyRefPath(refPath: string): string {
  const resolved = path.resolve(__dirname, refPath);
  const stateRoot = path.resolve(STATE_DIR);
  if (resolved !== stateRoot && !resolved.startsWith(`${stateRoot}${path.sep}`)) {
    throw new Error('Legacy image reference resolves outside the state directory.');
  }
  return resolved;
}

export async function readImageRef(ref: InlineDataRef): Promise<Buffer> {
  const target = ref.blobId
    ? resolveImageBlobPath(ref.blobId)
    : ref.path
      ? resolveLegacyRefPath(ref.path)
      : null;
  if (!target) throw new Error(`Image reference ${ref.imageId || '(unknown)'} has no blob location.`);
  const buffer = await fs.readFile(target);
  if (typeof ref.byteLength === 'number' && ref.byteLength >= 0 && buffer.length !== ref.byteLength) {
    throw new Error(`Image reference ${ref.imageId} failed byte-length validation.`);
  }
  if (ref.sha256) {
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actual !== ref.sha256) throw new Error(`Image reference ${ref.imageId} failed SHA-256 validation.`);
  }
  return buffer;
}

async function externalizePart(message: Message, part: MessagePart, partIndex: number): Promise<{ part: MessagePart; changed: boolean }> {
  const stripped = stripProviderImageHelperFields(part);
  part = stripped.part;
  if (part.inlineData?.data) {
    const imageId = buildImageId(message, part, partIndex);
    const mimeType = normalizeMimeType(part.inlineData.mimeType || part.inlineData.mime_type);
    const ref = await putImageBlob({
      buffer: decodeInlineData(part.inlineData),
      mimeType,
      imageId,
      width: part.imageMeta?.width,
      height: part.imageMeta?.height,
    });
    const { inlineData: _removed, ...rest } = part;
    return {
      changed: true,
      part: {
        ...rest,
        inlineDataRef: ref,
        imageMeta: { imageId, mimeType, width: ref.width, height: ref.height, sizeBytes: ref.byteLength, sha256: ref.sha256 },
      },
    };
  }

  if (part.inlineDataRef?.path && !part.inlineDataRef.blobId) {
    const legacy = part.inlineDataRef;
    const ref = await putImageBlob({
      buffer: await readImageRef(legacy),
      mimeType: legacy.mimeType,
      imageId: legacy.imageId || buildImageId(message, part, partIndex),
      width: legacy.width,
      height: legacy.height,
    });
    return {
      changed: true,
      part: {
        ...part,
        inlineDataRef: ref,
        imageMeta: part.imageMeta || {
          imageId: ref.imageId,
          mimeType: ref.mimeType,
          width: ref.width,
          height: ref.height,
          sizeBytes: ref.byteLength,
          sha256: ref.sha256,
        },
      },
    };
  }

  return { part, changed: stripped.changed };
}

export async function externalizeMessageImages(message: Message): Promise<{ message: Message; changed: boolean }> {
  const needsWork = message.parts.some(part => (
    !!part.inlineData?.data
    || !!(part.inlineDataRef?.path && !part.inlineDataRef.blobId)
    || hasNestedToolImages(part)
    || Object.prototype.hasOwnProperty.call(part, '__providerImageIdentity')
    || Object.prototype.hasOwnProperty.call(part, '__providerImageDeduplicated')
  ));
  if (!needsWork) return { message, changed: false };

  const parts: MessagePart[] = [];
  let changed = false;
  for (let index = 0; index < message.parts.length; index += 1) {
    const nested = extractNestedToolImages(message.parts[index]);
    const result = await externalizePart(message, nested?.part || message.parts[index], index);
    parts.push(result.part);
    changed ||= result.changed || !!nested;
    if (nested) {
      for (const imagePart of nested.imageParts) {
        const imageResult = await externalizePart(message, imagePart, parts.length);
        parts.push(imageResult.part);
        changed ||= imageResult.changed;
      }
    }
  }
  return changed ? { message: { ...message, parts }, changed } : { message, changed };
}

export async function externalizeMessages(messages: Message[]): Promise<{ messages: Message[]; changed: boolean }> {
  const converted: Message[] = [];
  let changed = false;
  for (const message of messages) {
    const result = await externalizeMessageImages(message);
    converted.push(result.message);
    changed ||= result.changed;
  }
  return changed ? { messages: converted, changed } : { messages, changed };
}

export async function externalizeQueueItemImages(item: QueueItem): Promise<{ item: QueueItem; changed: boolean }> {
  let changed = false;
  let next: QueueItem = item;
  if (Array.isArray(item.parts)) {
    const result = await externalizeMessageImages({ role: 'user', parts: item.parts });
    if (result.changed) {
      next = { ...next, parts: result.message.parts };
      changed = true;
    }
  }
  if (item.message) {
    const result = await externalizeMessageImages(item.message);
    if (result.changed) {
      next = { ...next, message: result.message };
      changed = true;
    }
  }
  return { item: next, changed };
}

export async function externalizeQueueItems(items: QueueItem[]): Promise<{ items: QueueItem[]; changed: boolean }> {
  const converted: QueueItem[] = [];
  let changed = false;
  for (const item of items) {
    const result = await externalizeQueueItemImages(item);
    converted.push(result.item);
    changed ||= result.changed;
  }
  return changed ? { items: converted, changed } : { items, changed };
}

export async function hydrateMessagesForProvider(messages: Message[]): Promise<Message[]> {
  const hydrated: Message[] = [];
  for (const message of messages) {
    let changed = false;
    const parts: MessagePart[] = [];
    for (const part of message.parts) {
      if (!part.inlineData && part.inlineDataRef) {
        const buffer = await readImageRef(part.inlineDataRef);
        const declaredMimeType = normalizeMimeType(part.inlineDataRef.mimeType);
        const providerImage = PROVIDER_NORMALIZED_HEIF_MIME_TYPES.has(declaredMimeType)
          ? await normalizeHeifForProvider(buffer, part.inlineDataRef.imageId)
          : { buffer, mimeType: declaredMimeType };
        const stripped = stripProviderImageHelperFields(part).part;
        parts.push({
          ...stripped,
          inlineData: { data: providerImage.buffer.toString('base64'), mimeType: providerImage.mimeType },
        });
        changed = true;
      } else {
        parts.push(part);
      }
    }
    hydrated.push(changed ? { ...message, parts } : message);
  }
  return hydrated;
}