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
await fs.writeFile(output, JSON.stringify({ cases, refs, messages, prepared }))
