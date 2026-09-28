import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import { STATE_DIR } from './config';

export type ProviderImageOutputFormat = 'webp' | 'jpeg';
export const PROVIDER_IMAGE_CACHE_DIR = path.join(STATE_DIR, 'provider-image-cache', 'v1');
const INPUT_PIXEL_LIMIT = 64 * 1024 * 1024;
const TARGET_PIXELS = 4 * 1024 * 1024;
const TARGET_EDGE = 4096;
const MAX_CACHED_ENTRY = 32 * 1024 * 1024;
const CACHE_CAPACITY = 512 * 1024 * 1024;
const CACHE_TRIM_TO = 384 * 1024 * 1024;
// Increment when conversion semantics change; old derived bytes must never
// survive an alpha or format-selection fix via a persistent cache hit.
const POLICY_VERSION = 2;
const inFlight = new Map<string, Promise<ProviderImageResult>>();
const lastCleanupByRoot = new Map<string, number>();
let cleanupPromise: Promise<void> | undefined;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const CLEANUP_LOCK_STALE_MS = 20 * 60 * 1000;

export interface ProviderImageResult {
  buffer: Buffer;
  mimeType: string;
}

export interface ProviderImageOptions {
  buffer: Buffer;
  mimeType: string;
  outputFormat?: ProviderImageOutputFormat;
  imageId?: string;
  /** The existing HEIF decoder validates and returns one primary image, never an animation. */
  decodeHeif?: () => Promise<{ rgba: Buffer; width: number; height: number; hasTransparency: boolean }>;
  /** A scoped directory can be supplied by isolated tests; production always uses the state directory. */
  cacheDir?: string;
}

type CacheHeader = {
  version: number;
  key: string;
  inputMime: string;
  inputLength: number;
  resultMime: string;
  resultLength: number;
  resultSha256?: string;
  passThrough: boolean;
};

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function cacheKey(buffer: Buffer, mimeType: string, outputFormat: ProviderImageOutputFormat): string {
  // Dimension limits, density threshold, orientation, GIF policy, and HEIF
  // conversion are versioned together so changing any of them invalidates hits.
  const policy = `provider-image-v${POLICY_VERSION}|${outputFormat}|quality=80|alphaQuality=100|bytes=1000000|density=98304+0.5px|pixels=${TARGET_PIXELS}|edge=${TARGET_EDGE}|gif=first|orientation=auto|heif=single-rgba`;
  return sha256(`${sha256(buffer)}\0${mimeType}\0${policy}`);
}

function location(root: string, key: string): string {
  return path.join(root, key.slice(0, 2), `${key}.cache`);
}

async function readCache(root: string, key: string, buffer: Buffer, mimeType: string): Promise<ProviderImageResult | undefined> {
  const filename = location(root, key);
  let saved: Buffer;
  let modifiedAt: number;
  try {
    const stat = await fs.stat(filename);
    if (stat.size > MAX_CACHED_ENTRY + 2049) throw new Error('Oversized provider image cache entry.');
    modifiedAt = stat.mtimeMs;
    saved = await fs.readFile(filename);
  } catch {
    return undefined;
  }
  try {
    const separator = saved.indexOf(10);
    if (separator < 0 || separator > 2048) throw new Error('Invalid provider image cache header.');
    const header = JSON.parse(saved.subarray(0, separator).toString('utf8')) as CacheHeader;
    const payload = saved.subarray(separator + 1);
    if (header.version !== POLICY_VERSION || header.key !== key || header.inputMime !== mimeType
      || header.inputLength !== buffer.length || !['image/png', 'image/jpeg', 'image/webp'].includes(header.resultMime)
      || header.resultLength !== (header.passThrough ? buffer.length : payload.length)
      || (header.passThrough ? payload.length !== 0 || header.resultMime !== mimeType
        : !header.resultSha256 || sha256(payload) !== header.resultSha256)) {
      throw new Error('Invalid provider image cache contents.');
    }
    // This stat is per entry, never a directory scan or capacity calculation.
    // mtime persists the throttle across workers and process restarts.
    const now = Date.now();
    if (now - modifiedAt >= CLEANUP_INTERVAL_MS) {
      void fs.utimes(filename, new Date(now), new Date(now)).catch(() => {});
    }
    return header.passThrough ? { buffer, mimeType } : { buffer: payload, mimeType: header.resultMime };
  } catch {
    // Another worker may replace this entry during our read; an unavailable or
    // malformed derived file is never authority over the original blob.
    await fs.remove(filename).catch(() => {});
    return undefined;
  }
}

async function trimCache(root: string): Promise<void> {
  const entries: Array<{ filename: string; size: number; atime: number }> = [];
  let total = 0;
  for (const shard of await fs.readdir(root).catch((): string[] => [])) {
    if (!/^[a-f0-9]{2}$/.test(shard)) continue;
    const directory = path.join(root, shard);
    for (const name of await fs.readdir(directory).catch((): string[] => [])) {
      if (!/^[a-f0-9]{64}\.cache$/.test(name)) continue;
      const filename = path.join(directory, name);
      const stat = await fs.stat(filename).catch((): undefined => undefined);
      if (!stat?.isFile()) continue;
      total += stat.size;
      entries.push({ filename, size: stat.size, atime: stat.mtimeMs });
    }
  }
  if (total <= CACHE_CAPACITY) return;
  entries.sort((a, b) => a.atime - b.atime);
  for (const entry of entries) {
    if (total <= CACHE_TRIM_TO) break;
    await fs.remove(entry.filename).catch(() => {});
    total -= entry.size;
  }
}

async function maybeTrimCache(root: string): Promise<void> {
  if (Date.now() - (lastCleanupByRoot.get(root) || 0) < CLEANUP_INTERVAL_MS) return;
  lastCleanupByRoot.set(root, Date.now());
  if (lastCleanupByRoot.size > 8) lastCleanupByRoot.delete(lastCleanupByRoot.keys().next().value!);
  const lock = path.join(root, '.cleanup-lock');
  const stamp = path.join(root, '.cleanup-last');
  let acquired = false;
  try {
    await fs.mkdir(lock);
    acquired = true;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') return;
    // A process that exits mid-cleanup leaves this directory behind. It is
    // safe to reclaim after the bounded lease; ordinary competing workers
    // simply return instead of queueing or scanning.
    const age = await fs.stat(lock).then(stat => Date.now() - stat.mtimeMs).catch(() => 0);
    if (age <= CLEANUP_LOCK_STALE_MS) return;
    await fs.remove(lock).catch(() => {});
    try { await fs.mkdir(lock); acquired = true; } catch { return; }
  }
  if (!acquired) return;
  try {
    const last = await fs.stat(stamp).then(stat => stat.mtimeMs).catch(() => 0);
    if (Date.now() - last < CLEANUP_INTERVAL_MS) return;
    await trimCache(root);
    await fs.writeFile(stamp, '', { flag: 'w' });
  } finally {
    await fs.remove(lock).catch(() => {});
  }
}

async function writeCache(root: string, key: string, source: ProviderImageResult, result: ProviderImageResult): Promise<void> {
  const passThrough = source.buffer === result.buffer && source.mimeType === result.mimeType;
  const payload = passThrough ? Buffer.alloc(0) : result.buffer;
  if (payload.length > MAX_CACHED_ENTRY) return;
  const header: CacheHeader = {
    version: POLICY_VERSION,
    key,
    inputMime: source.mimeType,
    inputLength: source.buffer.length,
    resultMime: result.mimeType,
    resultLength: result.buffer.length,
    ...(passThrough ? {} : { resultSha256: sha256(payload) }),
    passThrough,
  };
  const filename = location(root, key);
  const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.ensureDir(path.dirname(filename));
    await fs.writeFile(temp, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), payload]), { flag: 'wx' });
    await fs.rename(temp, filename);
    // No resident image cache or periodic process is created. Cleanup is
    // opportunistic, and competing workers may temporarily exceed the cap.
    if (!cleanupPromise && Date.now() - (lastCleanupByRoot.get(root) || 0) >= CLEANUP_INTERVAL_MS) {
      cleanupPromise = maybeTrimCache(root).catch(() => {}).finally(() => { cleanupPromise = undefined; });
    }
  } catch {
    // Derived cache failures must not fail an otherwise valid model request.
  } finally {
    await fs.remove(temp).catch(() => {});
  }
}

async function convert(options: ProviderImageOptions): Promise<ProviderImageResult> {
  const { buffer, mimeType } = options;
  const outputFormat = options.outputFormat || 'webp';
  const source = { buffer, mimeType };
  let width: number;
  let height: number;
  let input: sharp.Sharp;
  let hasTransparency: boolean | undefined;
  const isHeif = mimeType === 'image/heic' || mimeType === 'image/heif';
  const isGif = mimeType === 'image/gif';
  // JPEG mode is also used for endpoints without WebP input support. Do not
  // leave an existing WebP unconverted just because it is small or compact.
  const formatCompatibility = outputFormat === 'jpeg' && mimeType === 'image/webp';
  if (isHeif) {
    if (!options.decodeHeif) throw new Error('HEIF decoder is unavailable.');
    const decoded = await options.decodeHeif();
    width = decoded.width;
    height = decoded.height;
    hasTransparency = decoded.hasTransparency;
    input = sharp(decoded.rgba, { raw: { width, height, channels: 4 }, limitInputPixels: INPUT_PIXEL_LIMIT });
  } else {
    input = sharp(buffer, { page: 0, pages: 1, limitInputPixels: INPUT_PIXEL_LIMIT });
    const metadata = await input.metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Image ${options.imageId || '(unknown)'} has invalid dimensions.`);
    const rotated = metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8;
    width = rotated ? metadata.height : metadata.width;
    height = rotated ? metadata.width : metadata.height;
    const format = mimeType === 'image/jpeg' ? 'jpeg' : mimeType.slice('image/'.length);
    if (metadata.format !== format) throw new Error(`Image bytes do not match declared MIME type ${mimeType}.`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > INPUT_PIXEL_LIMIT) throw new Error('Image exceeds the 64-megapixel limit.');
  const scale = Math.min(1, TARGET_EDGE / Math.max(width, height), Math.sqrt(TARGET_PIXELS / pixels));
  const resize = scale < 1;
  const byteThreshold = Math.min(1_000_000, 96 * 1024 + 0.5 * pixels);
  if (!isHeif && !isGif && !resize && !formatCompatibility && buffer.length <= byteThreshold) return source;

  if (outputFormat === 'jpeg' && hasTransparency === undefined) {
    const metadata = await input.metadata();
    // stats().isOpaque checks the actual alpha channel independently of its
    // position (gray+alpha has two channels, RGBA has four).
    hasTransparency = !!metadata.hasAlpha && !(await sharp(buffer, {
      page: 0, pages: 1, limitInputPixels: INPUT_PIXEL_LIMIT,
    }).stats()).isOpaque;
  }
  if (!isHeif) input = input.rotate();
  if (resize) input = input.resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), fit: 'inside', withoutEnlargement: true });
  const mime = outputFormat === 'webp' ? 'image/webp' : hasTransparency ? 'image/png' : 'image/jpeg';
  const converted = mime === 'image/webp'
    ? await input.webp({ quality: 80, alphaQuality: 100 }).toBuffer()
    : mime === 'image/png'
      ? await input.png().toBuffer()
      : await input.jpeg({ quality: 80 }).toBuffer();
  if (!isHeif && !isGif && !resize && !formatCompatibility && converted.length >= buffer.length) return source;
  return { buffer: converted, mimeType: mime };
}

export async function optimizeProviderImage(options: ProviderImageOptions): Promise<ProviderImageResult> {
  const normalized = options.mimeType.trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'].includes(normalized)) {
    return { buffer: options.buffer, mimeType: normalized };
  }
  const outputFormat = options.outputFormat || 'webp';
  const key = cacheKey(options.buffer, normalized, outputFormat);
  const root = options.cacheDir || PROVIDER_IMAGE_CACHE_DIR;
  const existing = inFlight.get(`${root}\0${key}`);
  if (existing) return existing;
  const operation = (async () => {
    const cached = await readCache(root, key, options.buffer, normalized);
    if (cached) return cached;
    const result = await convert({ ...options, mimeType: normalized, outputFormat });
    await writeCache(root, key, { buffer: options.buffer, mimeType: normalized }, result);
    return result;
  })();
  inFlight.set(`${root}\0${key}`, operation);
  try { return await operation; }
  finally { inFlight.delete(`${root}\0${key}`); }
}
