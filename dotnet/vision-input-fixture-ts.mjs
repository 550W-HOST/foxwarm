// Execute the actual Source preflight/hydration owners with owned state before imports.
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
const [root, output] = process.argv.slice(2)
if (!root || !output) throw new Error('Owned root and output path are required.')
process.env.FOXWARM_DATA_DIR = path.join(root, 'source')
process.env.FOXWARM_AGENTS_DIR = path.join(root, 'source', 'agents')
const source = process.env.FOXWARM_TS_ROOT
const { oversizedVisionImages } = await import(pathToFileURL(path.join(source, 'lib/testFixtures/visionImages.js')))
const { inspectImageInput } = await import(pathToFileURL(path.join(source, 'lib/imageInputPolicy.js')))
const { putImageBlob, hydrateMessagesForProvider } = await import(pathToFileURL(path.join(source, 'lib/imageBlobs.js')))
const images = { small: await sharp({ create: { width: 3, height: 2, channels: 3, background: 'red' } }).png().toBuffer(), ...await oversizedVisionImages() }
images.atBytes = Buffer.concat([images.small, Buffer.alloc(32 * 1024 * 1024 - images.small.length)])
const refs = {}, cases = []
await fs.mkdir(root, { recursive: true })
for (const [name, buffer] of Object.entries(images)) {
  const sample = await sharp(buffer, { limitInputPixels: false }).resize(1, 1).raw().toBuffer()
  if (sample.length !== 3) throw new Error('A real raster must decode to a 1x1 RGB sample.')
  await fs.writeFile(path.join(root, name + '.png'), buffer)
  refs[name] = await putImageBlob({ buffer, mimeType: 'image/png', imageId: name })
  const inspection = await inspectImageInput(buffer, 'image/png', buffer.length)
  cases.push({ name, oversized: inspection.oversized })
}
const tiffCases = []
const normalTiff = await sharp(images.small).tiff({ compression: 'deflate' }).toBuffer()
const overTiff = await sharp(images.overPixels, { limitInputPixels: false }).tiff({ compression: 'deflate' }).toBuffer()
const bigTiff = await sharp(images.overPixels, { limitInputPixels: false }).tiff({ compression: 'deflate', bigtiff: true }).toBuffer()
// A first directory with dimensions but no image layout must not be accepted as metadata.
const headerOnly = Buffer.alloc(38); headerOnly.write('II'); headerOnly.writeUInt16LE(42, 2); headerOnly.writeUInt32LE(8, 4); headerOnly.writeUInt16LE(2, 8)
for (const [offset, tag] of [[10, 256], [22, 257]]) { headerOnly.writeUInt16LE(tag, offset); headerOnly.writeUInt16LE(4, offset + 2); headerOnly.writeUInt32LE(1, offset + 4); headerOnly.writeUInt32LE(8193, offset + 8) }
for (const [name, buffer] of Object.entries({ normal: normalTiff, over: overTiff, big: bigTiff, truncated: overTiff.subarray(0, 12), headerOnly })) {
  await fs.writeFile(path.join(root, name + '.tif'), buffer)
  try { tiffCases.push({ name, oversized: (await inspectImageInput(buffer, 'image/tiff', buffer.length)).oversized }) }
  catch { tiffCases.push({ name, invalid: true }) }
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
const prepared = await hydrateMessagesForProvider(messages, { protocol: 'openai-responses' })
await fs.writeFile(output, JSON.stringify({ cases, refs, messages, prepared, tiffCases }))
