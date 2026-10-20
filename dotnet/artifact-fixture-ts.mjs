// Original Source storage oracle. Every caller supplies an owned root; no installation state.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = process.env.FOXWARM_TS_ROOT
if (!root) throw new Error('FOXWARM_TS_ROOT is required')
const { ArtifactStore } = require(path.join(root, 'lib/artifacts/store.js'))
const { describeImage } = require(path.join(root, 'lib/artifacts/image.js'))
let text = ''
for await (const part of process.stdin) text += part
const input = JSON.parse(text)
const store = new ArtifactStore(input.root)
if (input.action === 'publish') {
  const bytes = input.image ? Buffer.from(input.image, 'base64') : undefined
  const document = bytes ? await describeImage(bytes, 'Source image', 'Original bytes') : input.document
  const result = await store.publish(input.sessionId, document, input.artifactId, input.expectedRevision, bytes ? { image: bytes } : undefined)
  console.log(JSON.stringify(result))
} else if (input.action === 'read') {
  const record = await store.read(input.artifactId, input.revision, input.sessionId)
  const resource = record.resources?.image ? (await store.resource(input.artifactId, input.revision, input.sessionId, 'image')).bytes.toString('base64') : undefined
  console.log(JSON.stringify({ record, resource }))
} else if (input.action === 'animated') {
  const sharp = require(path.join(root, 'node_modules/sharp'))
  const images = []
  for (const pages of [2, 121]) {
    const bytes = Buffer.alloc(8 * 8 * pages * 3)
    for (let frame = 0; frame < pages; frame++) for (let pixel = 0; pixel < 64; pixel++) bytes.fill(frame & (1 << (pixel % 7)) ? 255 : 0, (frame * 64 + pixel) * 3, (frame * 64 + pixel + 1) * 3)
    const image = await sharp(bytes, { raw: { width: 8, height: 8 * pages, channels: 3, pageHeight: 8 } }).gif({ colours: 2, interFrameMaxError: 0, interPaletteMaxError: 0 }).toBuffer()
    if ((await sharp(image, { animated: true }).metadata()).pages !== pages) throw new Error('Fixture did not produce the requested animation')
    images.push(image.toString('base64'))
  }
  console.log(JSON.stringify({ images }))
} else throw new Error('Unsupported fixture action')
