import fs from 'fs-extra';
import sharp from 'sharp';

export const MAX_VISION_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

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

function isLibHeifError(value: object | LibHeifError): value is LibHeifError {
  return Object.prototype.hasOwnProperty.call(value, 'code');
}

async function inspectHeif(buffer: Buffer, imageId: string, decodePixels: boolean): Promise<{
  width: number; height: number; rgba?: Buffer; hasTransparency?: boolean;
}> {
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
    if (!Number.isSafeInteger(pixels)) throw new Error('invalid image dimensions');
    if (!decodePixels) return { width, height };
    if (pixels > MAX_IMAGE_PIXELS) {
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

    return { rgba, width, height, hasTransparency };
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

export async function decodeHeifForProvider(buffer: Buffer, imageId: string): Promise<{
  rgba: Buffer; width: number; height: number; hasTransparency: boolean;
}> {
  const decoded = await inspectHeif(buffer, imageId, true);
  return { width: decoded.width, height: decoded.height, rgba: decoded.rgba!, hasTransparency: decoded.hasTransparency! };
}

export interface ImageInputInspection {
  oversized: boolean;
  metadata?: sharp.Metadata;
}

/** Probe source metadata only. The byte gate runs before opening or decoding an image. */
export async function inspectImageInput(source: Buffer | string, mimeType: string, sizeBytes: number, imageId = ''): Promise<ImageInputInspection> {
  if (sizeBytes > MAX_VISION_IMAGE_BYTES) return { oversized: true };
  const mime = mimeType.trim().toLowerCase();
  if (mime === 'image/heic' || mime === 'image/heif') {
    const bytes = typeof source === 'string' ? await fs.readFile(source) : source;
    const { width, height } = await inspectHeif(bytes, imageId, false);
    return { oversized: width * height > MAX_IMAGE_PIXELS };
  }
  // Removing Sharp's pixel rejection here allows metadata inspection of a real
  // over-limit raster without allocating its pixels. Encoding retains its cap.
  const metadata = await sharp(source, { page: 0, pages: 1, limitInputPixels: false }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Image has invalid dimensions.');
  const expected = mime === 'image/jpeg' ? 'jpeg' : mime.slice('image/'.length);
  if (metadata.format !== expected) throw new Error(`Image bytes do not match declared MIME type ${mime}.`);
  return { oversized: metadata.width * metadata.height > MAX_IMAGE_PIXELS, metadata };
}
