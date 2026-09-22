import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const corpusPath = process.argv[2]
if (!corpusPath) throw new Error('usage: responses-request-parity-ts.mjs CORPUS')
const foxwarmRoot = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '../..')
const moduleUrl = pathToFileURL(path.join(foxwarmRoot, 'lib/llmProviders/openai.js')).href
const { convertToOpenAIResponsesFormat } = await import(moduleUrl)
const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'))
const results = corpus.map(item => ({
  name: item.name,
  input: convertToOpenAIResponsesFormat(
    item.messages.filter(message => message?.modelVisible !== false),
    item.modelId,
  ),
}))
process.stdout.write(JSON.stringify(results))
