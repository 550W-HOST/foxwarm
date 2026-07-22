import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import * as sessionManager from './sessionManager';
import { ImageMeta, InlineData, Message, MessagePart } from './types';

export interface NormalizedToolResultImage {
  inlineData: InlineData;
  imageMeta: ImageMeta;
}

export interface NormalizedToolResultImages {
  result: any;
  imageParts: MessagePart[];
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isImageMimeType(mimeType: unknown): mimeType is string {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

function normalizeMimeTypeFromFormat(format: unknown): string | undefined {
  if (typeof format !== 'string') return undefined;
  const normalized = format.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('/')) {
    return normalized;
  }
  if (normalized === 'jpg') return 'image/jpeg';
  return `image/${normalized}`;
}

function normalizeInlineData(item: any): InlineData | null {
  if (!item || typeof item !== 'object') return null;
  const mimeType = item.mimeType || item.mime_type;
  if (typeof item.data === 'string' && isImageMimeType(mimeType)) {
    return {
      ...item,
      data: item.data,
      mimeType,
    };
  }
  return null;
}

function normalizeLegacyImagePayload(result: Record<string, any>): { inlineData: InlineData; consumedKeys: string[] } | null {
  if (typeof result.image === 'string' && typeof result.encoding === 'string' && result.encoding.toLowerCase() === 'base64') {
    const mimeType = typeof result.mimeType === 'string'
      ? result.mimeType
      : normalizeMimeTypeFromFormat(result.format) || 'image/png';
    return {
      inlineData: {
        data: result.image,
        mimeType,
      },
      consumedKeys: ['image', 'encoding', 'format'],
    };
  }

  return null;
}

function parseLegacyOutputImage(output: string): InlineData | null {
  if (output.startsWith('__IMAGE__:')) {
    const [, mimeType, base64] = output.split(':', 3);
    if (!mimeType || !base64) return null;
    return {
      data: base64,
      mimeType,
    };
  }

  if (output.startsWith('__SCREENSHOT__:')) {
    return {
      data: output.substring('__SCREENSHOT__:'.length),
      mimeType: 'image/png',
    };
  }

  return null;
}

export function buildToolImageId(toolUseId: string, imageIndex: number): string {
  const safeToolUseId = String(toolUseId || 'tool').trim() || 'tool';
  return `${safeToolUseId}#${imageIndex + 1}`;
}

async function probeImageMetadata(inlineData: InlineData): Promise<Omit<ImageMeta, 'imageId'>> {
  const buffer = Buffer.from(inlineData.data, 'base64');
  const metadata = await sharp(buffer, { limitInputPixels: 64 * 1024 * 1024 }).metadata();

  return {
    mimeType: inlineData.mimeType || inlineData.mime_type,
    width: typeof metadata.width === 'number' ? metadata.width : undefined,
    height: typeof metadata.height === 'number' ? metadata.height : undefined,
    sizeBytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

async function buildNormalizedToolResultImage(toolUseId: string, imageIndex: number, inlineData: InlineData): Promise<NormalizedToolResultImage> {
  const imageMeta = await probeImageMetadata(inlineData);
  return {
    inlineData,
    imageMeta: {
      imageId: buildToolImageId(toolUseId, imageIndex),
      ...imageMeta,
    },
  };
}

export async function normalizeToolResultImages(result: any, toolUseId: string, fallbackLabel: string): Promise<NormalizedToolResultImages> {
  if (!isObject(result)) {
    return { result, imageParts: [] };
  }

  const normalizedInlineItems: InlineData[] = [];
  const inlineItem = normalizeInlineData(result.inlineData);
  if (inlineItem) {
    normalizedInlineItems.push(inlineItem);
  }

  if (Array.isArray(result.inlineDataItems)) {
    for (const item of result.inlineDataItems) {
      const normalized = normalizeInlineData(item);
      if (normalized) {
        normalizedInlineItems.push(normalized);
      }
    }
  }

  const legacyPayload = normalizeLegacyImagePayload(result);
  if (legacyPayload) {
    normalizedInlineItems.push(legacyPayload.inlineData);
  }

  if (typeof result.output === 'string') {
    const legacyOutputImage = parseLegacyOutputImage(result.output);
    if (legacyOutputImage) {
      normalizedInlineItems.push(legacyOutputImage);
    }
  }

  if (normalizedInlineItems.length === 0) {
    return { result, imageParts: [] };
  }

  const imageParts: MessagePart[] = [];
  for (let index = 0; index < normalizedInlineItems.length; index += 1) {
    const normalized = await buildNormalizedToolResultImage(toolUseId, index, normalizedInlineItems[index]);
    imageParts.push({
      toolUseId,
      inlineData: normalized.inlineData,
      imageMeta: normalized.imageMeta,
    });
  }

  const {
    inlineData,
    inlineDataItems,
    ...rest
  } = result;

  if (legacyPayload) {
    for (const key of legacyPayload.consumedKeys) {
      delete rest[key];
    }
  }

  if (typeof rest.output === 'string' && parseLegacyOutputImage(rest.output)) {
    delete rest.output;
  }

  if (rest.output === undefined) {
    rest.output = fallbackLabel;
  }

  return {
    result: rest,
    imageParts,
  };
}

export function getImageMetaFromPart(part: MessagePart | undefined | null): ImageMeta | null {
  if (!part) return null;

  if (part.imageMeta?.imageId) {
    return {
      imageId: part.imageMeta.imageId,
      mimeType: part.imageMeta.mimeType || part.inlineData?.mimeType || part.inlineData?.mime_type || part.inlineDataRef?.mimeType,
      width: part.imageMeta.width ?? part.inlineDataRef?.width,
      height: part.imageMeta.height ?? part.inlineDataRef?.height,
      sizeBytes: part.imageMeta.sizeBytes ?? part.inlineDataRef?.byteLength,
      sha256: part.imageMeta.sha256 || part.inlineDataRef?.sha256,
    };
  }

  if (part.inlineDataRef?.imageId) {
    return {
      imageId: part.inlineDataRef.imageId,
      mimeType: part.inlineDataRef.mimeType,
      width: part.inlineDataRef.width,
      height: part.inlineDataRef.height,
      sizeBytes: part.inlineDataRef.byteLength,
      sha256: part.inlineDataRef.sha256,
    };
  }

  return null;
}

function formatImageSize(meta: ImageMeta): string {
  const width = typeof meta.width === 'number' ? meta.width : '?';
  const height = typeof meta.height === 'number' ? meta.height : '?';
  return `${width}x${height}`;
}

function sanitizeSuggestedFileName(imageId: string): string {
  return imageId.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export function buildImageGuidanceLabel(meta: ImageMeta): string {
  const imageId = meta.imageId || 'image';
  const sampleFileName = `${sanitizeSuggestedFileName(imageId)}.png`;
  return `[IMAGE: id=${imageId}, size=${formatImageSize(meta)}] you can use image_crop({ id: \"${imageId}\", x: 0, y: 0, width: 100, height: 100 }) and image_write_to_file({ id: \"${imageId}\", filePath: \"artifacts/${sampleFileName}\" })`;
}

export function buildImageGuidanceText(parts: MessagePart[]): string {
  const labels = parts
    .map(getImageMetaFromPart)
    .filter((meta): meta is ImageMeta => !!meta?.imageId)
    .map(buildImageGuidanceLabel);

  return labels.join('\n');
}

export function appendImageGuidanceText(parts: MessagePart[], existingText: string): string {
  const guidanceText = buildImageGuidanceText(parts);
  if (!guidanceText) {
    return existingText;
  }
  if (!existingText) {
    return guidanceText;
  }
  return `${guidanceText}\n${existingText}`;
}

export function resolveArchiveInlineDataPath(refPath: string): string {
  return path.resolve(__dirname, refPath);
}

async function buildResolvedImageFromPart(part: MessagePart): Promise<ResolvedImage | null> {
  const meta = getImageMetaFromPart(part);
  if (!meta?.imageId) {
    return null;
  }

  if (part.inlineData?.data) {
    const buffer = Buffer.from(part.inlineData.data, 'base64');
    return {
      imageId: meta.imageId,
      mimeType: meta.mimeType || part.inlineData.mimeType || part.inlineData.mime_type || 'application/octet-stream',
      buffer,
      width: meta.width,
      height: meta.height,
      sizeBytes: meta.sizeBytes ?? buffer.length,
      sha256: meta.sha256,
    };
  }

  if (part.inlineDataRef?.path) {
    const fullPath = resolveArchiveInlineDataPath(part.inlineDataRef.path);
    const buffer = await fs.readFile(fullPath);
    return {
      imageId: meta.imageId,
      mimeType: meta.mimeType || part.inlineDataRef.mimeType || 'application/octet-stream',
      buffer,
      width: meta.width,
      height: meta.height,
      sizeBytes: meta.sizeBytes ?? part.inlineDataRef.byteLength ?? buffer.length,
      sha256: meta.sha256,
    };
  }

  return null;
}

export interface ResolvedImage {
  imageId: string;
  mimeType: string;
  buffer: Buffer;
  width?: number;
  height?: number;
  sizeBytes: number;
  sha256?: string;
}

function findImagePartInMessage(message: Message | undefined, imageId: string): MessagePart | null {
  if (!message?.parts?.length) {
    return null;
  }

  for (const part of message.parts) {
    const meta = getImageMetaFromPart(part);
    if (meta?.imageId === imageId) {
      return part;
    }
  }

  return null;
}

export async function resolveImageById(sessionId: string, imageId: string): Promise<ResolvedImage> {
  const session = await sessionManager.getExistingSession(sessionId);
  if (session) {
    for (let index = session.history.length - 1; index >= 0; index -= 1) {
      const match = findImagePartInMessage(session.history[index], imageId);
      if (!match) continue;
      const resolved = await buildResolvedImageFromPart(match);
      if (resolved) {
        return resolved;
      }
    }
  }

  const archivedMessages = await sessionManager.getArchivedMessages(sessionId, {});
  for (let index = archivedMessages.records.length - 1; index >= 0; index -= 1) {
    const match = findImagePartInMessage(archivedMessages.records[index].message, imageId);
    if (!match) continue;
    const resolved = await buildResolvedImageFromPart(match);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(`Image id \`${imageId}\` not found in session \`${sessionId}\`.`);
}

export async function cropImageById(sessionId: string, imageId: string, crop: { x: number; y: number; width: number; height: number }): Promise<{ inlineData: InlineData; imageMeta: Omit<ImageMeta, 'imageId'> }> {
  const resolved = await resolveImageById(sessionId, imageId);
  const { x, y, width, height } = crop;
  if (![x, y, width, height].every(value => Number.isInteger(value))) {
    throw new Error('image_crop requires integer x, y, width, and height values.');
  }
  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    throw new Error('image_crop requires x >= 0, y >= 0, width > 0, and height > 0.');
  }

  const image = sharp(resolved.buffer, { limitInputPixels: 64 * 1024 * 1024 });
  const metadata = await image.metadata();
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.height;
  if (typeof sourceWidth !== 'number' || typeof sourceHeight !== 'number') {
    throw new Error(`Unable to determine dimensions for image \`${imageId}\`.`);
  }
  if (x + width > sourceWidth || y + height > sourceHeight) {
    throw new Error(`Crop rectangle (${x}, ${y}, ${width}, ${height}) exceeds source image bounds ${sourceWidth}x${sourceHeight}.`);
  }

  const extracted = await image
    .extract({ left: x, top: y, width, height })
    .toFormat(metadata.format === 'jpeg' ? 'jpeg' : metadata.format === 'webp' ? 'webp' : metadata.format === 'gif' ? 'gif' : 'png')
    .toBuffer({ resolveWithObject: true });

  const outputMimeType = extracted.info.format === 'jpeg'
    ? 'image/jpeg'
    : extracted.info.format === 'webp'
    ? 'image/webp'
    : extracted.info.format === 'gif'
    ? 'image/gif'
    : 'image/png';

  return {
    inlineData: {
      data: extracted.data.toString('base64'),
      mimeType: outputMimeType,
    },
    imageMeta: {
      mimeType: outputMimeType,
      width: extracted.info.width,
      height: extracted.info.height,
      sizeBytes: extracted.info.size,
      sha256: crypto.createHash('sha256').update(extracted.data).digest('hex'),
    },
  };
}
