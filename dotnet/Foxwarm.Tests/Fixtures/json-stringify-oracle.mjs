// Platform JSON.stringify oracle for EcmaJson/EcmaNumber: no application code is loaded.
// Usage: node json-stringify-oracle.mjs <stringify|number-stringify> INPUT RESULT
import fs from 'node:fs/promises'
const [mode, inputPath, resultPath] = process.argv.slice(2)
if (!mode || !inputPath || !resultPath) throw new Error('usage: json-stringify-oracle.mjs MODE INPUT RESULT')
const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
let results
if (mode === 'stringify') {
  results = input.map(value => JSON.stringify(value))
} else if (mode === 'number-stringify') {
  results = input.map(hex => {
    const bytes = Buffer.allocUnsafe(8)
    bytes.writeBigUInt64LE(BigInt(`0x${hex}`))
    const value = bytes.readDoubleLE()
    return Number.isFinite(value) ? JSON.stringify(value) : null
  })
} else throw new Error(`Unsupported mode ${mode}`)
await fs.writeFile(resultPath, JSON.stringify(results), 'utf8')
