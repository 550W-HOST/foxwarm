#!/usr/bin/env node
// A scripted OpenAI Responses provider for the hosted drills. Every model request is keyed by
// the last `DRILL:<key>` marker in its user input; a key's rounds can be scripted to hold the
// request open (so a replica can be killed or cut off mid-turn) or to answer with a given text.
// Unscripted rounds answer `FINAL:<key>:<round>`. Rounds count turn requests only (requests that
// offer tools); auxiliary requests such as title generation answer at once and aren't counted.
//
// Control API (same port, under /__drill/):
//   GET  /__drill/requests        every request seen: key, round, time, whether it carried the
//                                 session-resumed event, and whether the client closed it
//   POST /__drill/script          {key, rounds: [{hold?: boolean, text?: string}, ...]}
//   POST /__drill/release         {key} answers every held request of the key
//
// Usage: node mock-llm.mjs [--port <n>] [--host <address>]
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const port = Number(option('--port', process.env.PORT || '8080'))
const host = option('--host', '0.0.0.0')

const requests = []
const rounds = new Map()
const scripts = new Map()
const held = new Map()

const userText = body =>
  (body.input || [])
    .filter(row => row.role === 'user')
    .flatMap(row => (Array.isArray(row.content) ? row.content : [{ text: row.content }]))
    .map(part => (typeof part === 'string' ? part : part?.text || ''))
    .join('\n')

const answer = (res, text, call) => {
  const output = call
    ? [{ type: 'function_call', call_id: 'master-' + call.name, name: call.name, arguments: JSON.stringify(call.args) }]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n')
}

// A fixed, local tool sequence for the master host acceptance turn. The script control API
// accepts text and holds only; it cannot supply commands to the operator's shell.
const masterCalls = [
  { name: 'exec', args: { command: "printf 'persisted by master exec' > master-restart.txt; printf 'master-exec-ok'" } },
  {
    name: 'ctl',
    args: {
      command: 'mcp set mastercheck --transport stdio --command python3 --args @peer --enable',
      values: { peer: [fileURLToPath(new URL('master-peer.py', import.meta.url))] },
    },
  },
  { name: 'run_script', args: { code: "return call_tool('mcp:mastercheck/receipt', {})" } },
]

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw
}

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/__drill/')) {
      if (req.method === 'GET' && req.url === '/__drill/requests')
        return json(res, 200, requests.map(({ res: _res, ...row }) => row))
      const body = JSON.parse((await readBody(req)) || '{}')
      if (req.method === 'POST' && req.url === '/__drill/script') {
        scripts.set(body.key, body.rounds || [])
        return json(res, 200, { ok: true })
      }
      if (req.method === 'POST' && req.url === '/__drill/release') {
        const waiting = held.get(body.key) || []
        held.delete(body.key)
        for (const release of waiting) release()
        return json(res, 200, { released: waiting.length })
      }
      return json(res, 404, { error: 'unknown control route' })
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'not a model route' })
    const body = JSON.parse(await readBody(req))
    const text = userText(body)
    const input = JSON.stringify(body.input || [])
    const key = [...text.matchAll(/DRILL:([\w.-]+)/g)].at(-1)?.[1] || 'unknown'
    const turn = (body.tools || []).length > 0
    const round = turn ? rounds.get(key) || 0 : null
    if (turn) rounds.set(key, round + 1)
    const step = turn ? (scripts.get(key) || [])[round] || {} : { text: 'Drill title' }
    const row = {
      key,
      round,
      turn,
      at: Date.now(),
      resumed: input.includes('type=\\"session-resumed\\"') || input.includes('type="session-resumed"'),
      userMessages: (text.match(/DRILL:[\w.-]+/g) || []).length,
      closed: false,
      answered: false,
    }
    requests.push(row)
    res.once('close', () => {
      if (!row.answered) row.closed = true
    })
    if (step.hold) {
      await new Promise(resolve => {
        const list = held.get(key) || []
        list.push(resolve)
        held.set(key, list)
        res.once('close', resolve)
      })
    }
    if (res.destroyed || row.closed) return
    row.answered = true
    answer(res, step.text || `FINAL:${key}:${round}`, key === 'master-acceptance' && turn ? masterCalls[round] : null)
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: String(error?.stack || error) })
  }
})

server.listen(port, host, () => {
  console.log(`mock-llm listening on ${host}:${server.address().port}`)
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))
