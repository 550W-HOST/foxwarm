// A scripted OpenAI Responses endpoint for demo fixture generation. The real
// runtime sends ordinary model requests; this server answers them from turns
// declared in gallery-script.mjs, so every tool runs through the real runtime.
import { createServer } from 'node:http'
import { once } from 'node:events'

export const text = (value, phase = 'final_answer') => ({ type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text: value }] })
export const commentary = value => text(value, 'commentary')
export const reasoning = (...summaries) => ({ type: 'reasoning', summary: summaries.map(value => ({ type: 'summary_text', text: value })) })
export const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })

function userTexts(input) {
  const result = []
  input.forEach((item, index) => {
    if (item.role !== 'user' && item.role !== 'developer' && item.role !== 'system') return
    const content = Array.isArray(item.content) ? item.content.map(part => part.text || '').join('\n') : String(item.content || '')
    result.push({ index, content })
  })
  return result
}

function callIds(input, fromIndex) {
  const ids = new Set()
  input.forEach((item, index) => {
    if (index > fromIndex && item.type === 'function_call') ids.add(item.call_id)
  })
  return ids
}

// Picks the turn whose `match` text appears in the latest matching user input,
// then the first step whose calls have not yet been answered.
export function selectStep(turns, input) {
  const texts = userTexts(input)
  let best
  for (const turn of turns) {
    for (const entry of texts) {
      if (!entry.content.includes(turn.match)) continue
      if (!best || entry.index > best.index) best = { turn, index: entry.index }
    }
  }
  if (!best) return null
  const answered = callIds(input, best.index)
  for (const [stepIndex, step] of best.turn.steps.entries()) {
    const ids = (step.callIds || stepItems(step, input).filter(item => item.type === 'function_call').map(item => item.call_id))
    if (ids.length && ids.some(id => answered.has(id))) continue
    return { turn: best.turn, step, stepIndex }
  }
  return null
}

// Function call outputs by call ID, so later steps can use runtime results such
// as background exec IDs or created task IDs.
export function callOutputs(input) {
  const outputs = {}
  for (const item of input) {
    if (item.type === 'function_call_output') outputs[item.call_id] = typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
  }
  return outputs
}

function stepItems(step, input) {
  if (typeof step.items !== 'function') return step.items || []
  try { return step.items({ input, outputs: callOutputs(input) }) } catch (error) { console.error(`Scripted step failed: ${error.message}`); return [] }
}

function estimateTokens(value) {
  return Math.max(1, Math.round(JSON.stringify(value).length / 4))
}

export async function startScriptedModel({ turns, log = () => {}, defaultDelayMs = 700 }) {
  const held = new Map()
  const unmatched = []
  const served = new Set()
  const seen = new Set()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const bytes of req) chunks.push(bytes)
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { res.writeHead(400); res.end(); return }
    const input = Array.isArray(body.input) ? body.input : []
    const selected = selectStep(turns, input)
    const last = userTexts(input).at(-1)?.content || ''
    log(`request items=${input.length} -> ${selected ? `${selected.turn.match.slice(0, 50)}#${selected.stepIndex}` : 'UNMATCHED'} | ${last.slice(-200).replace(/\n/g, ' ')}`)
    if (!selected) {
      unmatched.push(last.slice(-400))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [text('(unscripted)')], usage: { input_tokens: 10, output_tokens: 2 } } })}\n\n`)
      res.end()
      return
    }
    const { step } = selected
    const final = step.hold || step.fail || (step.callIds ? step.callIds.length === 0 : !stepItems(step, input).some(item => item.type === 'function_call'))
    await new Promise(done => setTimeout(done, step.delayMs ?? defaultDelayMs))
    seen.add(selected.turn.match)
    if (final) served.add(selected.turn.match)
    if (step.fail) {
      res.writeHead(step.fail.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(step.fail.body))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const items = stepItems(step, input)
    if (step.hold) {
      // Stream partial text, then keep the request open until the turn is stopped.
      const key = step.holdKey || selected.turn.match
      res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: step.hold })}\n\n`)
      held.set(key, res)
      res.on('close', () => held.delete(key))
      return
    }
    const inputTokens = estimateTokens(input) + 4200
    const usage = {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: Math.max(0, Math.round(inputTokens * 0.82) - 400) },
      output_tokens: estimateTokens(items) + (step.reasoningTokens || 0),
      output_tokens_details: { reasoning_tokens: step.reasoningTokens || 0 },
    }
    res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { output: items, usage } })}\n\n`)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    unmatched,
    held,
    done: match => served.has(match),
    seen: match => seen.has(match),
    async close() {
      for (const res of held.values()) res.destroy()
      server.closeAllConnections?.()
      await new Promise(done => server.close(done))
    },
  }
}
