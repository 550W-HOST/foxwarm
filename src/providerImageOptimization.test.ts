import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { optimizeProviderImage } from './providerImageOptimization';

async function withCache(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-provider-image-'));
  try { await run(root); } finally { await fs.remove(root); }
}

async function opaque(width: number, height: number): Promise<Buffer> {
  const noise = crypto.randomBytes(width * height * 3);
  return sharp(noise, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function transparent(): Promise<Buffer> {
  return sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 30, g: 80, b: 120, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="100" height="80"><text x="3" y="32" fill="red" font-size="24">Foxwarm</text></svg>'), left: 40, top: 10 }])
    .png().toBuffer();
}

async function entryCount(root: string): Promise<number> {
  let count = 0;
  for (const shard of await fs.readdir(root).catch((): string[] => [])) {
    if (/^[0-9a-f]{2}$/.test(shard)) count += (await fs.readdir(path.join(root, shard))).filter(name => name.endsWith('.cache')).length;
  }
  return count;
}

async function eventually(assertion: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await assertion()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Background cache cleanup did not complete.');
}

test('pixel density, exact-byte threshold, and final-size acceptance use one output encode', async () => withCache(async root => {
  const small = await opaque(512, 512);
  assert.ok(small.length > Math.min(1_000_000, 96 * 1024 + 0.5 * 512 * 512));
  const compressed = await optimizeProviderImage({ buffer: small, mimeType: 'image/png', cacheDir: root });
  assert.equal(compressed.mimeType, 'image/webp');
  assert.ok(compressed.buffer.length < small.length);
  assert.deepEqual(await sharp(compressed.buffer).metadata().then(meta => [meta.width, meta.height]), [512, 512]);

  const large = await opaque(2048, 2048);
  const stillLarge = await optimizeProviderImage({ buffer: large, mimeType: 'image/png', cacheDir: root });
  assert.equal(stillLarge.mimeType, 'image/webp');
  assert.ok(stillLarge.buffer.length > 1_000_000, '1 MB is an input trigger, not an output limit');
  assert.deepEqual(await sharp(stillLarge.buffer).metadata().then(meta => [meta.width, meta.height]), [2048, 2048]);
}));

test('resize respects both independent caps and auto-oriented first-frame dimensions', async () => withCache(async root => {
  const original = await sharp({ create: { width: 4200, height: 1200, channels: 3, background: 'red' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const converted = await optimizeProviderImage({ buffer: original, mimeType: 'image/jpeg', cacheDir: root });
  const metadata = await sharp(converted.buffer).metadata();
  assert.equal(metadata.format, 'webp');
  assert.ok(metadata.width! <= 1200 && metadata.height! <= 4096);
  assert.ok(metadata.width! < metadata.height!, 'orientation must be applied before resize');
  assert.ok(metadata.width! * metadata.height! <= 4 * 1024 * 1024);
  assert.equal(metadata.orientation, undefined, 'output should not require a second orientation transform');
  const tiny = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
  assert.equal((await optimizeProviderImage({ buffer: tiny, mimeType: 'image/png', cacheDir: root })).buffer, tiny);
}));

test('JPEG option emits JPEG for opaque pixels and PNG for actual transparency', async () => withCache(async root => {
  const photo = await opaque(512, 512);
  const result = await optimizeProviderImage({ buffer: photo, mimeType: 'image/png', outputFormat: 'jpeg', cacheDir: root });
  assert.equal(result.mimeType, 'image/jpeg');
  const alpha = await transparent();
  // GIF, too, must be encoded regardless of its input size.
  const rgba = await sharp(alpha).raw().toBuffer({ resolveWithObject: true });
  const gif = await sharp(rgba.data, { raw: rgba.info }).gif().toBuffer();
  const png = await optimizeProviderImage({ buffer: gif, mimeType: 'image/gif', outputFormat: 'jpeg', cacheDir: root });
  assert.equal(png.mimeType, 'image/png');
  const pixel = await sharp(png.buffer).ensureAlpha().raw().toBuffer();
  assert.ok(pixel.some((_value, index) => index % 4 === 3 && pixel[index] === 0));
  const webp = await optimizeProviderImage({ buffer: gif, mimeType: 'image/gif', cacheDir: root });
  assert.equal(webp.mimeType, 'image/webp');
  assert.equal((await sharp(webp.buffer).metadata()).pages, undefined);
}));

test('JPEG mode converts even small WebP input for endpoints without WebP support', async () => withCache(async root => {
  const opaqueWebp = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).webp({ quality: 20 }).toBuffer();
  const converted = await optimizeProviderImage({ buffer: opaqueWebp, mimeType: 'image/webp', outputFormat: 'jpeg', cacheDir: root });
  assert.equal(converted.mimeType, 'image/jpeg');
  assert.equal((await sharp(converted.buffer).metadata()).format, 'jpeg');
  const alphaWebp = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).webp().toBuffer();
  const transparentResult = await optimizeProviderImage({ buffer: alphaWebp, mimeType: 'image/webp', outputFormat: 'jpeg', cacheDir: root });
  assert.equal(transparentResult.mimeType, 'image/png');
  assert.equal((await sharp(transparentResult.buffer).metadata()).hasAlpha, true);
}));

test('cache hits skip decode and encode, policy changes invalidate, corruption rebuilds, and in-flight requests coalesce', async () => withCache(async root => {
  const rgba = Buffer.alloc(40 * 40 * 4, 255);
  let decodes = 0;
  const decoder = async () => { decodes += 1; return { rgba, width: 40, height: 40, hasTransparency: false }; };
  const options = { buffer: Buffer.from('fake-heif-unique'), mimeType: 'image/heif', decodeHeif: decoder, cacheDir: root };
  const first = await Promise.all(Array.from({ length: 8 }, () => optimizeProviderImage(options)));
  assert.equal(decodes, 1);
  assert.ok(first.every(item => item.buffer.equals(first[0].buffer)));
  const again = await optimizeProviderImage(options);
  assert.ok(again.buffer.equals(first[0].buffer));
  assert.equal(decodes, 1, 'persistent hit must avoid even the HEIF decoder');
  assert.equal((await optimizeProviderImage({ ...options, outputFormat: 'jpeg' })).mimeType, 'image/jpeg');
  assert.equal(decodes, 2);
  assert.equal(await entryCount(root), 2);

  const shard = (await fs.readdir(root)).find(name => /^[0-9a-f]{2}$/.test(name))!;
  const entries = await fs.readdir(path.join(root, shard));
  await fs.writeFile(path.join(root, shard, entries[0]), 'broken cache');
  await optimizeProviderImage(options);
  assert.equal(decodes, 3, 'corrupt derived bytes must rebuild');
}));

test('cache hits never scan and miss writes clean an over-capacity directory to the lower watermark', async () => withCache(async root => {
  const first = await opaque(180, 180);
  await optimizeProviderImage({ buffer: first, mimeType: 'image/png', cacheDir: root });
  const stamp = path.join(root, '.cleanup-last');
  await eventually(() => fs.pathExists(stamp));
  const past = new Date(Date.now() - 11 * 60 * 1000);
  await fs.utimes(stamp, past, past);
  const fake = path.join(root, 'ff', `${'f'.repeat(64)}.cache`);
  await fs.ensureDir(path.dirname(fake));
  await fs.writeFile(fake, 'sparse');
  await fs.truncate(fake, 520 * 1024 * 1024);
  await fs.utimes(fake, past, past);
  const stamped = (await fs.stat(stamp)).mtimeMs;
  await optimizeProviderImage({ buffer: first, mimeType: 'image/png', cacheDir: root });
  assert.equal((await fs.stat(stamp)).mtimeMs, stamped, 'cache hit must not trigger capacity scan');
  assert.equal(await fs.pathExists(fake), true);
  const second = await opaque(181, 181);
  const actualNow = Date.now;
  try {
    // Advance the process-level ten-minute throttle without sleeping.
    Date.now = () => actualNow() + 11 * 60 * 1000;
    await optimizeProviderImage({ buffer: second, mimeType: 'image/png', cacheDir: root });
    await eventually(async () => !(await fs.pathExists(fake)));
  } finally {
    Date.now = actualNow;
  }
  assert.ok((await fs.stat(stamp)).mtimeMs > past.getTime());
  assert.equal(await fs.pathExists(path.join(root, '.cleanup-lock')), false);
}));

test('unwritable cache falls back to provider output without modifying source bytes', async () => withCache(async root => {
  const input = await opaque(420, 420);
  const snapshot = Buffer.from(input);
  const blocked = path.join(root, 'blocked');
  await fs.writeFile(blocked, 'not a directory');
  const image = await optimizeProviderImage({ buffer: input, mimeType: 'image/png', cacheDir: blocked });
  assert.equal(image.mimeType, 'image/webp');
  assert.deepEqual(input, snapshot);
}));

test('animated GIF emits only its first actual frame', async () => withCache(async root => {
  const frameSize = 20 * 15 * 4;
  const first = Buffer.alloc(frameSize);
  const second = Buffer.alloc(frameSize);
  for (let i = 0; i < frameSize; i += 4) {
    first.set([255, 0, 0, 255], i);
    second.set([0, 0, 255, 255], i);
  }
  const original = await sharp(Buffer.concat([first, second]), {
    raw: { width: 20, height: 30, pageHeight: 15, channels: 4 },
  }).gif({ loop: 0 }).toBuffer();
  assert.equal((await sharp(original, { animated: true }).metadata()).pages, 2);
  const result = await optimizeProviderImage({ buffer: original, mimeType: 'image/gif', cacheDir: root });
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(metadata.format, 'webp');
  assert.deepEqual([metadata.width, metadata.height, metadata.pages], [20, 15, undefined]);
  const pixel = await sharp(result.buffer).raw().toBuffer();
  assert.ok(pixel[0] > pixel[2] * 3, 'first (red) frame must win over second (blue) frame');
}));

test('density-only conversion which is not smaller retains the original JPEG bytes', async () => withCache(async root => {
  const noise = crypto.randomBytes(1200 * 1200 * 3);
  const source = await sharp(noise, { raw: { width: 1200, height: 1200, channels: 3 } }).jpeg({ quality: 76 }).toBuffer();
  assert.ok(source.length > Math.min(1_000_000, 96 * 1024 + 0.5 * 1200 * 1200));
  const output = await optimizeProviderImage({ buffer: source, mimeType: 'image/jpeg', outputFormat: 'jpeg', cacheDir: root });
  assert.strictEqual(output.buffer, source, 'the density-only result is optional when it gains no bytes');
  assert.equal(output.mimeType, 'image/jpeg');
  assert.equal((await optimizeProviderImage({ buffer: source, mimeType: 'image/jpeg', outputFormat: 'jpeg', cacheDir: root })).mimeType, 'image/jpeg');
  assert.equal(await entryCount(root), 1, 'pass-through outcome is persisted as metadata');
}));

test('competing processes share the derived directory and stale cleanup lease recovers', async () => withCache(async root => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runChild = promisify(execFile);
  const input = path.join(root, 'source.png');
  await fs.writeFile(input, await opaque(64, 64));
  const lock = path.join(root, '.cleanup-lock');
  await fs.ensureDir(lock);
  const old = new Date(Date.now() - 21 * 60 * 1000);
  await fs.utimes(lock, old, old);
  const script = `const fs=require('fs'); const { optimizeProviderImage }=require(process.argv[1]); optimizeProviderImage({ buffer:fs.readFileSync(process.argv[2]), mimeType:'image/png', cacheDir:process.argv[3] }).then(r=>console.log(r.mimeType+':'+r.buffer.length)).catch(e=>{console.error(e);process.exitCode=1});`;
  const moduleFile = path.join(__dirname, 'providerImageOptimization.js');
  const results = await Promise.all([runChild(process.execPath, ['-e', script, moduleFile, input, root]), runChild(process.execPath, ['-e', script, moduleFile, input, root])]);
  assert.equal(results[0].stdout, results[1].stdout);
  assert.equal(await entryCount(root), 1);
  await eventually(async () => (await fs.pathExists(path.join(root, '.cleanup-last'))) && !(await fs.pathExists(lock)));
}));
