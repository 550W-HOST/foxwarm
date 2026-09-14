import http from 'node:http'

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

function sse(res, events, { hold = false, delayMs = 0 } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  let index = 0
  const writeNext = () => {
    if (res.destroyed || index >= events.length) {
      if (!hold && !res.destroyed) res.end()
      return
    }
    const event = events[index++]
    res.write(`data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`)
    if (delayMs > 0) setTimeout(writeNext, delayMs).unref()
    else queueMicrotask(writeNext)
  }
  writeNext()
}

function responseText(id, chunks, { empty = false } = {}) {
  const events = [{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }]
  for (const delta of chunks) events.push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta })
  events.push({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: empty ? '' : chunks.join('') })
  events.push({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: empty ? 0 : 4 } } })
  events.push('[DONE]')
  return events
}

function responseTool(id, callId, name, args) {
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: `${id}-item`, call_id: callId, name, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(args) },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: JSON.stringify(args) },
    { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 4 } } },
    '[DONE]',
  ]
}

function chatText(id, chunks) {
  return [
    ...chunks.map((content, index) => ({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), content }, finish_reason: index === chunks.length - 1 ? 'stop' : null }] })),
    { id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    '[DONE]',
  ]
}

function chatTool(id, callId, name, args) {
  return [
    { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]
}

export async function startMockProvider({ toolFile, log }) {
  const requests = []
  let unexpected = null
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__control/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ requests, unexpected }))
      return
    }
    if (req.method !== 'POST' || !['/v1/responses', '/v1/chat/completions'].includes(req.url || '')) {
      res.writeHead(404).end()
      return
    }
    let body
    try { body = await collectBody(req) } catch (error) {
      unexpected = `invalid JSON: ${error.message}`
      res.writeHead(400).end(unexpected)
      return
    }
    const wire = JSON.stringify(body)
    const protocol = req.url.endsWith('/responses') ? 'responses' : 'chat'
    const record = { protocol, marker: ['AFTER_STOP', 'INCREMENTAL', 'TOOL', 'STOP', 'EMPTY', 'CHAT'].find(value => wire.includes(`APP_E2E_${value}`)) || null, body }
    requests.push(record)
    await log(`${protocol} ${record.marker || 'unexpected'} model=${body.model || ''} inputBytes=${wire.length}\n`)

    if (protocol === 'responses' && wire.includes('APP_E2E_INCREMENTAL')) {
      sse(res, responseText('resp-incremental', ['streamed ', 'answer']), { delayMs: 120 })
    } else if (protocol === 'responses' && wire.includes('APP_E2E_TOOL')) {
      if (!wire.includes('call_app_write')) sse(res, responseTool('resp-write', 'call_app_write', 'write', { filePath: toolFile, content: 'app e2e tool payload' }))
      else if (!wire.includes('call_app_read')) sse(res, responseTool('resp-read', 'call_app_read', 'read', { filePath: toolFile }))
      else sse(res, responseText('resp-tool-final', ['tool roundtrip complete']))
    } else if (protocol === 'responses' && wire.includes('APP_E2E_AFTER_STOP')) {
      sse(res, responseText('resp-after-stop', ['after stop complete']))
    } else if (protocol === 'responses' && wire.includes('APP_E2E_STOP')) {
      sse(res, [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'held stream' },
      ], { hold: true, delayMs: 150 })
    } else if (protocol === 'responses' && wire.includes('APP_E2E_EMPTY')) {
      sse(res, responseText('resp-empty', [], { empty: true }))
    } else if (protocol === 'chat' && wire.includes('APP_E2E_CHAT')) {
      if (!wire.includes('call_chat_write')) sse(res, chatTool('chat-tool', 'call_chat_write', 'write', { filePath: `${toolFile}.chat`, content: 'chat tool payload' }))
      else sse(res, chatText('chat-final', ['chat ', 'tool complete']), { delayMs: 100 })
    } else {
      unexpected = `unconsumed ${protocol} request`
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: unexpected }))
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => {
      server.close(resolve)
      for (const socket of sockets) socket.destroy()
    }),
    assertConsumed() { if (unexpected) throw new Error(unexpected) },
  }
}
