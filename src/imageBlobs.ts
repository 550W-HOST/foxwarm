import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import { IMAGE_BLOBS_DIR, STATE_DIR } from './config';
import { optimizeProviderImage, ProviderImageOutputFormat } from './providerImageOptimization';
import { decodeHeifForProvider } from './imageInputPolicy';
import { InlineData, InlineDataRef, Message, MessagePart, QueueItem } from './types';
import { buildFoxwarmAttachmentText } from '../packages/shared/dist/foxwarmMarkup';
import { parseFoxwarmTagLine } from './utils/promptWrappers';
import { formatToolResponsePayload } from '../packages/shared/dist/toolResponseFormatting';

const BLOB_ID_RE = /^([a-f0-9]{64})\.(png|jpg|gif|webp|svg|bin)$/;
const SAFE_RASTER_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const PROVIDER_NORMALIZED_HEIF_MIME_TYPES = new Set(['image/heic', 'image/heif']);

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
  const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
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

function imageDescriptorAsFile(text: string | undefined, mimeType: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const tag = parseFoxwarmTagLine(lines[index]);
    if (!tag || tag.closing || tag.tagName !== 'foxwarm-image' || !tag.attrs.name || !tag.attrs.node || !tag.attrs.path) continue;
    lines[index] = buildFoxwarmAttachmentText({
      kind: 'file', name: tag.attrs.name || 'image', node: tag.attrs.node, path: tag.attrs.path, mime: mimeType,
    });
    return lines.join('\n');
  }
  return undefined;
}

function appendImageFileFallback(parts: MessagePart[], part: MessagePart, mimeType: string): MessagePart {
  const { inlineData: _inline, inlineDataRef: _ref, imageMeta: _meta, ...filePart } = stripProviderImageHelperFields(part).part;
  const ownDescriptor = imageDescriptorAsFile(part.text, mimeType);
  const previous = parts[parts.length - 1];
  const previousDescriptor = !ownDescriptor && previous && !previous.inlineData && !previous.inlineDataRef
    ? imageDescriptorAsFile(previous.text, mimeType) : undefined;
  if (ownDescriptor) {
    const result = { ...filePart, text: ownDescriptor };
    parts.push(result);
    return result;
  } else if (previousDescriptor) {
    const result = { ...previous, text: previousDescriptor };
    parts[parts.length - 1] = result;
    if (filePart.text || filePart.functionCall || filePart.functionResponse) parts.push(filePart);
    return result;
  } else {
    // Reference-only images have no ordinary file locator. Keep the real
    // image ID actionable without exposing a private Main blob path or
    // materializing a new attachment during provider preparation.
    const imageId = part.imageMeta?.imageId || part.inlineDataRef?.imageId;
    const note = 'Image content was not sent because it exceeds the image input limit. '
      + (imageId
        ? `The original is retained as image ${JSON.stringify(imageId)}; use image_write_to_file to save it as a file.`
        : 'The original remains in the source message.');
    const descriptor = [filePart.text, note].filter(Boolean).join('\n');
    const result = { ...filePart, text: descriptor };
    parts.push(result);
    return result;
  }
}

export async function hydrateMessagesForProvider(messages: Message[], options: {
  protocol?: 'openai-responses' | 'openai-chat-completions' | 'anthropic';
  concreteModelId?: string;
  outputFormat?: ProviderImageOutputFormat;
} = {}): Promise<Message[]> {
  const hydrated: Message[] = [];
  for (const message of messages) {
    let changed = false;
    let parts: MessagePart[] = [];
    const toolFiles: Array<{ part: MessagePart; toolUseId?: string }> = [];
    for (const part of message.parts) {
      if (part.inlineDataRef || part.inlineData?.data) {
        // Always check a referenced original, including image history that the
        // selected serializer later describes with a text-only placeholder.
        let buffer: Buffer;
        if (part.inlineDataRef) {
          buffer = await readImageRef(part.inlineDataRef);
        } else {
          // Historical low-level callers can supply inline image payloads
          // without going through canonical raster validation. Leave invalid
          // legacy inline bytes to the old serializer rather than introducing
          // a new local decode error for a previously accepted request.
          try {
            buffer = decodeInlineData(part.inlineData!);
          } catch {
            parts.push(part);
            continue;
          }
        }
        const declaredMimeType = normalizeMimeType(part.inlineDataRef?.mimeType || part.inlineData?.mimeType);
        const nativeReplay = message.role === 'model'
          && options.protocol === 'openai-responses'
          && part.providerMeta?.openaiResponses?.sourceModelId === options.concreteModelId
          && part.providerMeta?.openaiResponses?.outputItem?.type === 'image_generation_call';
        // A generated assistant image on another concrete model is rendered
        // as a text-only placeholder. Responses drops other assistant images.
        // Still read references above to preserve the existing unreadable-blob
        // failure contract; do not optimize pixels the protocol cannot send.
        const nonVisualAssistant = message.role === 'model' && !nativeReplay
          && (part.imageMeta?.origin === 'generated' || options.protocol === 'openai-responses');
        if (nonVisualAssistant && PROVIDER_NORMALIZED_HEIF_MIME_TYPES.has(declaredMimeType)) {
          // Earlier hydration validated every referenced HEIF even when the
          // serializer later dropped that assistant image. Keep that local
          // malformed/oversized-input failure without emitting a variant.
          await decodeHeifForProvider(buffer, part.inlineDataRef?.imageId || part.imageMeta?.imageId || '');
        }
        let providerImage: Awaited<ReturnType<typeof optimizeProviderImage>> = { buffer, mimeType: declaredMimeType };
        if (!nativeReplay && !nonVisualAssistant) {
          try {
            providerImage = await optimizeProviderImage({
              buffer,
              mimeType: declaredMimeType,
              imageId: part.inlineDataRef?.imageId || part.imageMeta?.imageId,
              outputFormat: options.outputFormat,
              ...(PROVIDER_NORMALIZED_HEIF_MIME_TYPES.has(declaredMimeType) ? {
                decodeHeif: () => decodeHeifForProvider(buffer, part.inlineDataRef?.imageId || part.imageMeta?.imageId || ''),
              } : {}),
            });
          } catch (error) {
            if (part.inlineDataRef || PROVIDER_NORMALIZED_HEIF_MIME_TYPES.has(declaredMimeType)) throw error;
            // Unvalidated legacy inline bytes used to pass directly to the
            // serializer. Do not turn their invalid raster into a new error.
          }
        }
        if (providerImage.asFile) {
          const filePart = appendImageFileFallback(parts, part, declaredMimeType);
          if (message.role === 'tool') toolFiles.push({ part: filePart, toolUseId: part.toolUseId });
          changed = true;
          continue;
        }
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
    // OpenAI tool serializers consume function responses, not arbitrary text
    // siblings. Put each file descriptor into its existing result occurrence
    // so all protocols retain the file without a serializer/capture change.
    for (const file of toolFiles) {
      const fileIndex = parts.indexOf(file.part);
      let responseIndex = -1;
      for (let index = 0; index < parts.length; index += 1) {
        const response = parts[index].functionResponse;
        if (!response || (file.toolUseId && (response.tool_use_id || parts[index].toolUseId) !== file.toolUseId)) continue;
        if (!file.toolUseId && index < fileIndex) continue;
        if (responseIndex < 0 || Math.abs(index - fileIndex) < Math.abs(responseIndex - fileIndex)) responseIndex = index;
      }
      if (responseIndex < 0) continue;
      const responsePart = parts[responseIndex];
      parts[responseIndex] = { ...responsePart, functionResponse: {
        ...responsePart.functionResponse,
        response: { output: [formatToolResponsePayload(responsePart.functionResponse.response || {}), file.part.text].filter(Boolean).join('\n') },
      } };
      if (fileIndex !== responseIndex) parts = parts.filter(part => part !== file.part);
    }
    hydrated.push(changed ? { ...message, parts } : message);
  }
  return hydrated;
}