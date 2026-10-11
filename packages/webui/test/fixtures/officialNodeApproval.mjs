// Uses the unchanged official CLI's supported interactive approval hook.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { NodeClient } = require(resolve(import.meta.dirname, '../../../cli-node/dist/client.js'))
const options = JSON.parse(process.env.FOXWARM_OWNED_CLIENT_OPTIONS)
const client = new NodeClient({
  ...options,
  localTrigger: false,
  toolCallInterceptor: async (tool, args) => {
    if (tool === 'exec' && args.command.includes('approval-held')) {
      console.log('OFFICIAL-APPROVAL-HELD')
      return await new Promise(() => {})
    }
    return true
  },
})
await client.connect()
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await client.disconnect(); process.exit(0) })
