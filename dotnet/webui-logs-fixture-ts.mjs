// Differential oracle: execute the original bounded reader, never a replica.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { WebUiLogFile } = await import(pathToFileURL(path.join(process.env.FOXWARM_TS_ROOT, 'lib/channels/webuiLogs.js')))
const input = JSON.parse(await new Promise(resolve => { let text = ''; process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => resolve(text)) }))
const logs = new WebUiLogFile(input.path)
const results = []
let cursor
try {
  for (const operation of input.operations) {
    try {
      const result = operation.time !== undefined
        ? await logs.seek(operation.time, cursor.fileId)
        : { window: await logs.read({ direction: operation.direction, offset: operation.offset === 'start' ? cursor.startOffset : operation.offset === 'end' ? cursor.endOffset : operation.offset, fileId: operation.direction === 'latest' ? undefined : cursor?.fileId }) }
      cursor = result.window
      results.push({ ...result, window: { ...cursor, fileId: cursor.fileId ? 'file' : null } })
    } catch (error) { results.push({ error: error.message }) }
  }
  process.stdout.write(JSON.stringify(results))
} finally { logs.dispose() }
