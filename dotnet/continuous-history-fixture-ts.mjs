// Seed original rows through the fixed Source persistence APIs in a caller-owned root.
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const [root, imagePath] = process.argv.slice(2)
if (!root || !imagePath) throw new Error('usage: continuous-history-fixture-ts.mjs DATA IMAGE')
process.env.FOXWARM_DATA_DIR = root
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '..')
const load = relative => import(pathToFileURL(path.join(repository, 'lib', relative)).href)
const sm = await load('sessionManager.js')
const { putImageBlob } = await load('imageBlobs.js')
await sm.loadSessions()
const parent = (await sm.createEmptySession('continuous-parent')).session
const image = await putImageBlob({ buffer: await fs.readFile(imagePath), mimeType: 'image/png', imageId: 'archive-original' })
for (let seq = 1; seq <= 240; seq++) {
  const parts = [{ text: `ORIGINAL-${String(seq).padStart(3, '0')}: ` + 'Original persisted conversation. '.repeat(8) }]
  if (seq === 150) parts.push({ inlineDataRef: image })
  await sm.appendSessionMessage(parent, { role: seq % 2 ? 'user' : 'model', parts, __meta: { timestamp: 1700000000000 + seq * 1000 } })
}
parent.aliases = ['continuous-alias']
await sm.saveSession(parent)
const child = await sm.forkSession(parent.id, 'fork')
await sm.appendSessionMessage(parent, { role: 'user', parts: [{ text: 'PARENT-AFTER-FORK-MUST-NOT-LEAK' }] })
console.log('CONTINUOUS_FIXTURE:' + JSON.stringify({ parent: parent.id, child, image }))
process.exit(0)
