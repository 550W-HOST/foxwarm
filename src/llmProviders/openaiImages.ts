import type { NormalizedOpenAIImageGenerationConfig } from '../config';
import { putImageBlob } from '../imageBlobs';
import type { MessagePart } from '../types';

/**
 * OpenAI Responses hosted `image_generation` tool support.
 *
 * This module owns the native tool declaration, strict result validation, and
 * the provider-neutral image part that canonical history/journals persist.
 * Raw provider base64 must never leave this boundary.
 */

export const OPENAI_IMAGE_GENERATION_TOOL_TYPE = 'image_generation';
export const OPENAI_IMAGE_GENERATION_CALL_ITEM_TYPE = 'image_generation_call';

/** Maximum decoded bytes accepted for a single generated image. */
export const IMAGE_GENERATION_MAX_DECODED_BYTES = 32 * 1024 * 1024;
/** Maximum decoded bytes accepted across every image item in one response. */
export const IMAGE_GENERATION_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Maximum number of final image items externalized from one response. */
export const IMAGE_GENERATION_MAX_IMAGE_ITEMS = 8;
/** Bound applied to any retained text metadata such as `revised_prompt`. */
export const IMAGE_GENERATION_MAX_META_TEXT_CHARS = 2000;

/** Output item fields that are safe to persist and replay. */
const SAFE_IMAGE_GENERATION_OUTPUT_ITEM_KEYS = [
  'type',
  'id',
  'status',
  'output_format',
  'output_compression',
  'background',
  'size',
  'quality',
  'action',
  'revised_prompt',
  'created_at',
  'model',
] as const;

const SAFE_IMAGE_GENERATION_OUTPUT_ITEM_KEY_SET = new Set<string>(SAFE_IMAGE_GENERATION_OUTPUT_ITEM_KEYS);

export type GeneratedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * Raised when a persisted generated image cannot be replayed because its local
 * bytes are missing or unreadable. The provider was never asked for anything at
 * that point, so this is a local recovery failure: callers must surface it
 * directly instead of retrying the request or failing over to another model.
 */
export class GeneratedImageReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratedImageReplayError';
  }
}

export type GeneratedImageFailure = {
  imageId: string;
  reason: string;
};

export type NormalizedGeneratedImage = {
  /** Index of the source output item, so callers can preserve output order. */
  index: number;
  callId?: string;
  part: MessagePart;
};

export type NormalizedGeneratedImages = {
  images: NormalizedGeneratedImage[];
  failures: GeneratedImageFailure[];
};

/**
 * Build the native Responses `image_generation` tool from normalized config.
 * Returns `undefined` when the tool must not be sent. `enabled` only controls
 * whether the tool is emitted; it is never forwarded to the provider.
 */
export function buildOpenAIImageGenerationTool(
  config: NormalizedOpenAIImageGenerationConfig | undefined,
): Record<string, any> | undefined {
  if (config?.enabled !== true) {
    return undefined;
  }

  const tool: Record<string, any> = { type: OPENAI_IMAGE_GENERATION_TOOL_TYPE };
  if (config.model) tool.model = config.model;
  if (config.action) tool.action = config.action;
  if (config.size) tool.size = config.size;
  if (config.quality) tool.quality = config.quality;
  if (config.background) tool.background = config.background;
  if (config.outputFormat) tool.output_format = config.outputFormat;
  if (typeof config.outputCompression === 'number') tool.output_compression = config.outputCompression;
  // V1 does not persist or stream partial previews; request the official default of none.
  tool.partial_images = 0;
  return tool;
}

export function isImageGenerationCallItem(item: unknown): item is Record<string, any> {
  return !!item
    && typeof item === 'object'
    && !Array.isArray(item)
    && (item as Record<string, any>).type === OPENAI_IMAGE_GENERATION_CALL_ITEM_TYPE;
}

function boundedText(value: unknown, maxChars = IMAGE_GENERATION_MAX_META_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Copy only the non-binary, replay-relevant fields of an output item. The
 * provider `result` base64 and any other binary field are dropped.
 */
export function sanitizeImageGenerationOutputItem(item: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const key of SAFE_IMAGE_GENERATION_OUTPUT_ITEM_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    const value = item[key];
    if (value === undefined) continue;
    if (key === 'revised_prompt') {
      const text = boundedText(value);
      if (text !== undefined) sanitized[key] = text;
      continue;
    }
    sanitized[key] = value;
  }
  if (!sanitized.type) sanitized.type = OPENAI_IMAGE_GENERATION_CALL_ITEM_TYPE;
  return sanitized;
}

/**
 * Rebuild the provider input form of a generated image call. The call `result`
 * is filled from locally persisted bytes so `store:false` replay never depends
 * on provider-side history.
 */
export function buildImageGenerationReplayItem(
  outputItem: Record<string, any>,
  resultBase64: string,
): Record<string, any> {
  const replay = sanitizeImageGenerationOutputItem(outputItem);
  replay.type = OPENAI_IMAGE_GENERATION_CALL_ITEM_TYPE;
  replay.result = resultBase64;
  delete replay.quality;
  delete replay.background;
  delete replay.output_compression;
  delete replay.action;
  return replay;
}

export function isCompletedImageGenerationItem(item: unknown): item is Record<string, any> {
  if (!isImageGenerationCallItem(item)) return false;
  const record = item as Record<string, any>;
  if (record.status !== undefined && record.status !== 'completed') return false;
  return typeof record.result === 'string' && record.result.trim().length > 0;
}

/**
 * Strict base64 decode with pre-decode bounds. Loose `Buffer.from(value,
 * 'base64')` silently accepts malformed input, so validate shape, padding and
 * canonical round-trip before allocating the decoded buffer.
 */
export function decodeStrictImageBase64(value: unknown, maxDecodedBytes: number): Buffer {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('image result was not a non-empty base64 string');
  }
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0) {
    throw new Error('image result was empty after removing whitespace');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error('image result contained non-base64 characters');
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  if (compact.length % 4 !== 0 && padding !== 0) {
    throw new Error('image result had inconsistent base64 padding');
  }

  const estimatedBytes = Math.floor((compact.length - padding) * 3 / 4);
  if (estimatedBytes > maxDecodedBytes) {
    throw new Error(`image result exceeded the ${maxDecodedBytes}-byte decoded limit`);
  }

  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length === 0) {
    throw new Error('image result decoded to an empty buffer');
  }
  if (buffer.length > maxDecodedBytes) {
    throw new Error(`image result exceeded the ${maxDecodedBytes}-byte decoded limit`);
  }

  const canonicalInput = compact.replace(/=+$/u, '');
  if (buffer.toString('base64').replace(/=+$/u, '') !== canonicalInput) {
    throw new Error('image result was not canonical base64');
  }
  return buffer;
}

function detectImageMime(buffer: Buffer): GeneratedImageMime | undefined {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'image/gif';
  }
  return undefined;
}

function mimeFromDeclaredOutputFormat(value: unknown): GeneratedImageMime | undefined {
  if (value === 'png') return 'image/png';
  if (value === 'jpeg' || value === 'jpg') return 'image/jpeg';
  if (value === 'webp') return 'image/webp';
  if (value === 'gif') return 'image/gif';
  return undefined;
}

export function deriveGeneratedImageId(callId: unknown, index: number): string {
  const raw = typeof callId === 'string' ? callId.trim() : '';
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? `ig_${safe}` : `ig_image${index + 1}`;
}

/**
 * Validate and externalize every completed image item in a Responses output
 * array. Successful items become provider-neutral `MessagePart`s that hold a
 * Blob reference plus safe native metadata. Failures are reported, never
 * silently dropped, and never trigger a regeneration.
 */
export async function externalizeGeneratedImageItems(
  outputItems: unknown,
  options: { sourceModelId: string },
): Promise<NormalizedGeneratedImages> {
  const images: NormalizedGeneratedImage[] = [];
  const failures: GeneratedImageFailure[] = [];
  const items = Array.isArray(outputItems) ? outputItems : [];
  const usedImageIds = new Set<string>();
  let accumulatedBytes = 0;
  let externalizedCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isImageGenerationCallItem(item)) continue;

    let imageId = deriveGeneratedImageId(item.id, index);
    while (usedImageIds.has(imageId)) imageId = `${imageId}_${index + 1}`;
    usedImageIds.add(imageId);

    if (item.status !== undefined && item.status !== 'completed') {
      failures.push({ imageId, reason: `image generation item ended with status ${String(item.status)}` });
      continue;
    }
    if (typeof item.result !== 'string' || item.result.trim().length === 0) {
      failures.push({ imageId, reason: 'image generation result was missing or empty' });
      continue;
    }
    if (externalizedCount >= IMAGE_GENERATION_MAX_IMAGE_ITEMS) {
      failures.push({ imageId, reason: `response exceeded the ${IMAGE_GENERATION_MAX_IMAGE_ITEMS}-image limit` });
      continue;
    }

    try {
      const buffer = decodeStrictImageBase64(item.result, IMAGE_GENERATION_MAX_DECODED_BYTES);
      if (accumulatedBytes + buffer.length > IMAGE_GENERATION_MAX_RESPONSE_BYTES) {
        throw new Error(`response exceeded the ${IMAGE_GENERATION_MAX_RESPONSE_BYTES}-byte cumulative limit`);
      }
      const detectedMime = detectImageMime(buffer);
      if (!detectedMime) {
        throw new Error('image result bytes were not a recognized raster image');
      }
      const declaredMime = mimeFromDeclaredOutputFormat(item.output_format);
      if (declaredMime && declaredMime !== detectedMime) {
        throw new Error(`image result bytes (${detectedMime}) did not match declared output_format ${String(item.output_format)}`);
      }

      const ref = await putImageBlob({
        buffer,
        mimeType: declaredMime || detectedMime,
        imageId,
      });
      accumulatedBytes += buffer.length;
      externalizedCount += 1;

      const outputItem = sanitizeImageGenerationOutputItem(item);
      if (!outputItem.output_format && detectedMime) {
        outputItem.output_format = detectedMime === 'image/jpeg' ? 'jpeg' : detectedMime.slice('image/'.length);
      }

      images.push({
        index,
        ...(typeof item.id === 'string' && item.id.trim() ? { callId: item.id.trim() } : {}),
        part: {
        inlineDataRef: ref,
        imageMeta: {
          imageId,
          origin: 'generated',
          mimeType: ref.mimeType,
          width: ref.width,
          height: ref.height,
          sizeBytes: ref.byteLength,
          sha256: ref.sha256,
        },
        providerMeta: {
          openaiResponses: {
            sourceModelId: options.sourceModelId,
            outputItem,
          },
        },
        },
      });
    } catch (error: any) {
      failures.push({
        imageId,
        reason: typeof error?.message === 'string' && error.message ? error.message : 'image validation failed',
      });
    }
  }

  return { images, failures };
}

/** Bounded, non-deceptive description of a generated image that failed. */
export function formatGeneratedImageFailureNote(failures: GeneratedImageFailure[]): string | undefined {
  if (failures.length === 0) return undefined;
  const details = failures
    .map(failure => `${failure.imageId}: ${failure.reason}`)
    .join('; ');
  const bounded = details.length > 600 ? `${details.slice(0, 600)}…` : details;
  return `[image generation did not produce a usable image: ${bounded}]`;
}

/** Honest placeholder used when an incompatible model receives a generated image. */
export function formatGeneratedImageModelPlaceholder(): string {
  return '[an assistant-generated image is present earlier in this conversation; the current model does not receive its image content]';
}
