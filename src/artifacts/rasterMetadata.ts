import sharp from 'sharp';
import { IMAGE_ARTIFACT_MAX_BYTES, validateImageDocument, type ImageDocument } from '../../packages/shared/dist/artifacts/image';
/** Verify raster bytes before they become an inline resource; no SVG/HTML sniffing fallback. */
export async function describeImage(bytes: Buffer, title: string, alt?: string): Promise<ImageDocument> {
  if (!bytes.length || bytes.length > IMAGE_ARTIFACT_MAX_BYTES) throw new Error('Image must be at most 12 MiB');
  const allowed = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    || /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))
    || bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!allowed) throw new Error('Only PNG, JPEG, GIF and WebP image bytes are supported');
  const meta = await sharp(bytes, { limitInputPixels: 40000000, animated: true }).metadata();
  const mimeType = ({ png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const)[meta.format as 'png'];
  const height = meta.pageHeight || meta.height, pages = meta.pages || 1;
  if (!mimeType || pages > 120 || (meta.width || 0) * (height || 0) * pages > 80000000) throw new Error('Unsupported or oversized animated image');
  return validateImageDocument({ type: 'image', schemaVersion: 1, title, mimeType, width: meta.width, height, ...(alt ? { alt } : {}) });
}
