import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

const largeSummary = (index) => `Source-bound summary ${index}: ` + ('detail-continued-' + index + '; ').repeat(350)
const text = value => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: value }] })
function event(res, payload) { res.write(`data: ${JSON.stringify(payload)}\n\n`) }
function completed(res, output, usage = { input_tokens: 100, output_tokens: 12 }) {
  event(res, { type: 'response.completed', response: { output, usage } }); res.end()
}
function call(res, id, name, args) {
  completed(res, [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }])
}
function promptOf(input) {
  const messages = input.filter(item => item.type === 'message').flatMap(item => item.content || [])
    .map(content => content.text || '')
  return messages.findLast(item => item.includes('COMPACTION STARTED:')) || ''
}
function plannerBlocks(prompt, index) {
  const raw = [...prompt.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)]
    .map(item => ({ start: Number(item[1]), end: Number(item[2] || item[1]) }))
  const levelOne = [...prompt.matchAll(/^- B#(\d+) L1 raw#/gm)].map(item => Number(item[1]))
  const plans = []
  if (index >= 3 && levelOne.length >= 2)
    plans.push({ level: 2, sourceKind: 'block', sourceStart: levelOne[0], sourceEnd: levelOne[1],
      summary: 'The first two older source-bound L1 summaries were summarized into this L2 block. Continue using the later blocks and current context.',
      memoryFacts: [{ kind: 'decision', text: 'Local synthetic scenario retained two nested blocks as source evidence.', attributedTo: 'assistant' }] })
  const count = index <= 2 ? 3 : raw.length >= 5 ? 1 : 0
  for (let block = 0; block < count; block++) {
    const slice = raw.slice(block * 5, block * 5 + 5)
    if (slice.length < 5) break
    plans.push({ level: 1, sourceKind: 'message', sourceStart: slice[0].start,
      sourceEnd: slice.at(-1).end, summary: largeSummary(`${index}-${block}`) })
  }
  return plans
}

export async function startScriptedProvider({ alphaToken, betaToken }) {
  const requests = []
  const failed = []
  let invalidSent = false
  let layerPlanCount = 0
  let heldSwitch = null
  let heldSwitchHandled = false
  let heldSettings = null
  let heldStop = null
  let heldSwitchClosed = false
  let heldStopClosed = false
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/responses')
      const chunks = []
      for await (const part of req) chunks.push(part)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(req.headers.authorization, `Bearer ${body.model === 'alpha-wire' ? alphaToken : betaToken}`)
      const input = JSON.stringify(body.input)
      const calls = body.input.filter(item => item.type === 'function_call')
      const planPrompt = promptOf(body.input)
      const users = body.input.filter(item => item.type === 'message' && item.role === 'user')
        .map(item => item.content?.map(part => part.text || '').join('\n') || '')
      const latestUser = users.findLast(value => value.includes('<foxwarm-message type="channel"')) || users.at(-1) || ''
      requests.push({ model: body.model, authorization: req.headers.authorization,
        reasoning: body.reasoning, include: body.include, input, planner: Boolean(planPrompt), tools: body.tools })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close', 'Cache-Control': 'no-cache' })
      if (latestUser.includes('SETTINGS-TASK ')) {
        const task = JSON.parse(latestUser.split('\n').find(line => line.startsWith('SETTINGS-TASK ')).slice('SETTINGS-TASK '.length))
        if (!calls.some(item => item.call_id === task.id)) call(res, task.id, task.name, task.args)
        else completed(res, [text('SETTINGS-DONE-' + task.id)])
        return
      }
      if (latestUser.includes('EXACT-RECALL ')) {
        const args = JSON.parse(latestUser.split('\n').find(line => line.startsWith('EXACT-RECALL ')).slice('EXACT-RECALL '.length));
        const callId = 'exact-' + args.testId; delete args.testId
        if (!calls.some(item => item.call_id === callId)) call(res, callId, 'recall', args)
        else completed(res, [text('EXACT-DONE-' + callId)])
        return
      }
      if (latestUser.includes('OLD-RECALL-RESTORE')) {
        assert(input.includes('totalCharacters') && input.includes('nextOffset') && input.includes('LEGACY-RECALL-CONTENT'))
        completed(res, [text('OLD-RESULT-RESTORED')]); return
      }
      if (planPrompt && input.includes('seed-stop')) {
        heldStop = res
        res.on('close', () => { heldStopClosed = true; heldStop = null })
        event(res, { type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', role: 'assistant', content: [] } })
        return
      }
      if (planPrompt && input.includes('seed-l1')) {
        if (!invalidSent) {
          invalidSent = true
          call(res, 'invalid-l1-plan', 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message',
            sourceStart: 99999, sourceEnd: 100000, summary: 'Invalid source range.' }] })
          return
        }
        if (layerPlanCount === 0) assert(input.includes('compact_plan_invalid'), 'The invalid plan must receive actual validation feedback')
        const blocks = plannerBlocks(planPrompt, layerPlanCount + 1)
        assert(blocks.length > 0, { index: layerPlanCount, prompt: planPrompt.slice(0, 700) })
        layerPlanCount++
        call(res, `valid-plan-${layerPlanCount}`, 'submit_compact_plan', { replaceAsBlocks: blocks })
        return
      }
      if (input.includes('seed-prune')) {
        if (input.includes('find-pruned-middle')) {
          assert(input.includes('historical tool response pruned') && input.includes('msg#3'),
            'Normal provider received the pruned output with an exact recall source marker')
          if (input.includes('SENTINEL_MIDDLE')) completed(res, [text('The archived original contains SENTINEL_MIDDLE.')])
          else if (calls.some(call => call.name === 'recall'))
            call(res, 'recall-middle-page', 'recall', { target: 'msg#3', contentFilter: 'SENTINEL_MIDDLE', toolDetail: 'snippets', previewLength: 2000 })
          else call(res, 'recall-first-page', 'recall', { target: 'msg#3' })
          return
        }
        if (input.includes('prune-trigger')) {
          completed(res, [text('pruning threshold reached')], { input_tokens: 17000, output_tokens: 20 }); return
        }
        if (input.includes('seed-prune read')) {
          if (!calls.some(call => call.name === 'read')) call(res, 'read-prune', 'read', { filePath: 'long.txt' })
          else completed(res, [text('long file read')])
          return
        }
        completed(res, [text('short prune follow-up')]); return
      }
      if (latestUser.includes('seed-l1-tool read')) {
        if (!calls.some(item => item.call_id === 'layered-read-pair'))
          call(res, 'layered-read-pair', 'read', { filePath: 'toolpair.txt' })
        else completed(res, [text('synthetic response')])
        return
      }
      if (latestUser.includes('hold-settings') && !calls.length) { heldSettings = res; res.on('close', () => { heldSettings = null }); return }
      if (latestUser.includes('hold-switch') && !heldSwitchHandled) {
        heldSwitchHandled = true
        heldSwitch = res
        res.on('close', () => { heldSwitchClosed = true; heldSwitch = null })
        event(res, { type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', role: 'assistant', content: [] } })
        return
      }
      completed(res, [text(input.includes('queued-stop') ? 'queued input resumed after compact cancellation' : 'synthetic response')],
        latestUser.includes('seed-l1-25') ? { input_tokens: 17000, output_tokens: 12 } : undefined)
    } catch (error) {
      failed.push(String(error.stack || error))
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port, requests, failed,
    get layerPlanCount() { return layerPlanCount },
    get invalidSent() { return invalidSent },
    get heldSwitch() { return Boolean(heldSwitch) },
    get heldSettings() { return Boolean(heldSettings) },
    get heldStop() { return Boolean(heldStop) },
    get heldStopClosed() { return heldStopClosed },
    get heldSwitchClosed() { return heldSwitchClosed },
    releaseSwitch() { if (heldSwitch) completed(heldSwitch, [text('held alpha request completed')]) },
    async close() { heldSettings?.end(); heldSwitch?.end(); heldStop?.end(); server.closeAllConnections(); await new Promise(done => server.close(done)) },
  }
}
