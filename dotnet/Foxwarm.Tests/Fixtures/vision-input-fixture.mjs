// Real raster inputs for VisionInputParityTests, with the TypeScript preflight and hydration
// results recorded at the final TypeScript revision (80f740477c25d3b42165bb0d201e74ebc5fd4479):
// imageInputPolicy.inspectImageInput, imageBlobs.putImageBlob and
// imageBlobs.hydrateMessagesForProvider(..., { protocol: 'openai-responses' }).
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
const [root, output] = process.argv.slice(2)
if (!root || !output) throw new Error('Owned root and output path are required.')

// Recorded inspectImageInput(...).oversized per case; `invalid` means it threw.
const recordedCases = { small: false, overBytes: true, overPixels: true, atBytes: false }
const recordedTiffCases = [
  { name: 'normal', oversized: false },
  { name: 'over', oversized: true },
  { name: 'big', oversized: true },
  { name: 'truncated', invalid: true },
  { name: 'headerOnly', invalid: true },
]
const file = '<foxwarm-file name="source &amp; original.png" node="other" path="original.png" mime="image/png" />'
const recordedPrepared = [
  { role: 'user', parts: [{ text: file }] },
  { role: 'user', parts: [{ text: file }] },
  { role: 'user', parts: [{ text: 'Image content was not sent because it exceeds the image input limit. The original is retained as image "stable\\"id"; save it as a file with `ctl image save \'stable"id\' <file-path>`.' }] },
  { role: 'tool', parts: [
    { functionResponse: { name: 'read', tool_use_id: 'first', response: { output: `first result\n${file}` } } },
    { functionResponse: { name: 'read', tool_use_id: 'second', response: { output: 'second result\nImage content was not sent because it exceeds the image input limit. The original is retained as image "overPixels"; save it as a file with `ctl image save overPixels <file-path>`.' } } },
  ] },
]

// Genuine PNGs: an uncompressed normal-resolution image and a compressible large raster.
const small = await sharp({ create: { width: 3, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
const images = {
  small,
  overBytes: await sharp({ create: { width: 4096, height: 3072, channels: 3, background: 'red' } }).png({ compressionLevel: 0 }).toBuffer(),
  overPixels: await sharp({ create: { width: 8193, height: 8193, channels: 3, background: 'blue' }, limitInputPixels: false }).png().toBuffer(),
  atBytes: Buffer.concat([small, Buffer.alloc(32 * 1024 * 1024 - small.length)]),
}
const refs = {}, cases = []
await fs.mkdir(root, { recursive: true })
for (const [name, buffer] of Object.entries(images)) {
  const sample = await sharp(buffer, { limitInputPixels: false }).resize(1, 1).raw().toBuffer()
  if (sample.length !== 3) throw new Error('A real raster must decode to a 1x1 RGB sample.')
  await fs.writeFile(path.join(root, name + '.png'), buffer)
  // The persisted TypeScript image reference shape: content-addressed `<sha256>.<format>`.
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  const { width, height } = await sharp(buffer, { limitInputPixels: false }).metadata()
  refs[name] = { imageId: name, blobId: `${sha256}.png`, format: 'png', mimeType: 'image/png', byteLength: buffer.length, sha256, width, height }
  cases.push({ name, oversized: recordedCases[name] })
}
const normalTiff = await sharp(images.small).tiff({ compression: 'deflate' }).toBuffer()
const overTiff = await sharp(images.overPixels, { limitInputPixels: false }).tiff({ compression: 'deflate' }).toBuffer()
const bigTiff = await sharp(images.overPixels, { limitInputPixels: false }).tiff({ compression: 'deflate', bigtiff: true }).toBuffer()
// A first directory with dimensions but no image layout must not be accepted as metadata.
const headerOnly = Buffer.alloc(38); headerOnly.write('II'); headerOnly.writeUInt16LE(42, 2); headerOnly.writeUInt32LE(8, 4); headerOnly.writeUInt16LE(2, 8)
for (const [offset, tag] of [[10, 256], [22, 257]]) { headerOnly.writeUInt16LE(tag, offset); headerOnly.writeUInt16LE(4, offset + 2); headerOnly.writeUInt32LE(1, offset + 4); headerOnly.writeUInt32LE(8193, offset + 8) }
for (const [name, buffer] of Object.entries({ normal: normalTiff, over: overTiff, big: bigTiff, truncated: overTiff.subarray(0, 12), headerOnly })) {
  await fs.writeFile(path.join(root, name + '.tif'), buffer)
}
const image = (name, extra = {}) => ({ inlineDataRef: refs[name], ...extra })
const descriptor = '<foxwarm-image name="source &amp; original.png" node="other" path="original.png" />'
const messages = [
  { role: 'user', parts: [{ text: descriptor }, image('overBytes')] },
  { role: 'user', parts: [image('overPixels', { text: descriptor })] },
  { role: 'user', parts: [image('overPixels', { imageMeta: { imageId: 'stable"id' } })] },
  { role: 'tool', parts: [
    { functionResponse: { name: 'read', tool_use_id: 'first', response: { output: 'first result' } } },
    image('overBytes', { toolUseId: 'first', text: descriptor }),
    { functionResponse: { name: 'read', tool_use_id: 'second', response: { output: 'second result' } } },
    image('overPixels', { toolUseId: 'second' }),
  ] },
]
await fs.writeFile(output, JSON.stringify({ cases, refs, messages, prepared: recordedPrepared, tiffCases: recordedTiffCases }))
