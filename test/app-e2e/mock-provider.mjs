import http from 'node:http'
import { WebSocketServer } from 'ws'

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

function writeSseEvent(res, event) {
  res.write(`data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`)
}

function responseText(id, chunks, { empty = false } = {}) {
  const text = empty ? '' : chunks.join('')
  const events = [{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }]
  for (const delta of chunks) events.push({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta })
  events.push({ type: 'response.output_text.done', output_index: 0, content_index: 0, text })
  events.push({ type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 12, output_tokens: empty ? 0 : 4 } } })
  events.push('[DONE]')
  return events
}

function responseTool(id, callId, name, args) {
  const argumentsText = JSON.stringify(args)
  return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: `${id}-item`, call_id: callId, name, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: argumentsText },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: argumentsText },
    { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [{ type: 'function_call', id: `${id}-item`, call_id: callId, name, arguments: argumentsText }], usage: { input_tokens: 12, output_tokens: 4 } } },
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

export async function startMockProvider({ toolFile, log, readyDelayMs = 0 }) {
  const expectedSequence = [
    'responses:INCREMENTAL',
    'responses:TOOL', 'responses:TOOL', 'responses:TOOL',
    'responses:STOP', 'responses:AFTER_STOP', 'responses:EMPTY',
    'chat:CHAT', 'chat:CHAT',
    'ws:WS_ONE', 'ws:WS_TWO', 'ws:WS_THREE', 'ws:FORK_CHILD',
    'responses:ATTACHMENT', 'responses:LONGPASTE',
    'ws:COMPACT_SYNC', 'ws:COMPACT_BACKGROUND', 'ws:BTW',
  ]
  let expectedIndex = 0
  const requests = []
  const wsRequests = []
  const wsConnections = []
  let unexpected = null
  let incrementalRelease = null
  let stopAborted = false
  const consumeExpected = (protocol, marker) => {
    const actual = `${protocol}:${marker || 'unexpected'}`
    const expected = expectedSequence[expectedIndex]
    if (actual !== expected) {
      unexpected = `provider request ${expectedIndex + 1} was ${actual}; expected ${expected || 'no further request'}`
      return false
    }
    expectedIndex += 1
    return true
  }
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__control/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ requests, wsRequests, unexpected, stopAborted }))
      return
    }
    if (req.method === 'POST' && req.url === '/__control/release-incremental') {
      if (!incrementalRelease) {
        unexpected = 'incremental release requested without a held response'
        res.writeHead(409).end(unexpected)
        return
      }
      incrementalRelease()
      incrementalRelease = null
      res.writeHead(204).end()
      return
    }
    if (req.method === 'POST' && req.url === '/__control/close-ws') {
      const current = wsConnections.at(-1)?.socket
      if (!current || current.readyState !== 1) {
        unexpected = 'WebSocket close requested without an open provider connection'
        res.writeHead(409).end(unexpected)
        return
      }
      current.close(1011, 'synthetic reconnect')
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'POST' || !['/v1/responses', '/v1/chat/completions'].includes(req.url || '')) {
      unexpected = `invalid provider request ${req.method} ${req.url}`
      res.writeHead(404).end(unexpected)
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
    const record = { protocol, marker: ['AFTER_STOP', 'INCREMENTAL', 'TOOL', 'STOP', 'EMPTY', 'CHAT', 'ATTACHMENT', 'LONGPASTE'].find(value => wire.includes(`APP_E2E_${value}`)) || null, body }
    requests.push(record)
    await log(`${protocol} ${record.marker || 'unexpected'} model=${body.model || ''} inputBytes=${wire.length}\n`)
    if (!consumeExpected(protocol, record.marker)) {
      res.writeHead(500).end(unexpected)
      return
    }

    if (protocol === 'responses' && wire.includes('APP_E2E_INCREMENTAL')) {
      const events = responseText('resp-incremental', ['streamed ', 'answer'])
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      for (const event of events.slice(0, 3)) writeSseEvent(res, event)
      incrementalRelease = () => {
        for (const event of events.slice(3)) writeSseEvent(res, event)
        res.end()
      }
    } else if (protocol === 'responses' && wire.includes('APP_E2E_TOOL')) {
      const outputs = Array.isArray(body.input) ? body.input.filter(item => item?.type === 'function_call_output') : []
      await log(`responses TOOL outputs=${JSON.stringify(outputs.map(item => ({ callId: item.call_id, output: JSON.stringify(item.output).slice(0, 160) })))}\n`)
      if (outputs.length === 0) sse(res, responseTool('resp-write', 'call_app_write', 'write', { filePath: toolFile, content: 'app e2e tool payload' }))
      else if (outputs.length === 1 && outputs[0].call_id === 'call_app_write' && JSON.stringify(outputs[0].output).includes('File written successfully')) {
        sse(res, responseTool('resp-read', 'call_app_read', 'read', { filePath: toolFile }))
      } else if (outputs.length === 2
        && outputs[0].call_id === 'call_app_write'
        && outputs[1].call_id === 'call_app_read'
        && JSON.stringify(outputs[1].output).includes('app e2e tool payload')) {
        sse(res, responseText('resp-tool-final', ['tool roundtrip complete']))
      } else {
        unexpected = 'Responses tool outputs were missing or not paired to the expected call IDs'
        res.writeHead(500).end(unexpected)
      }
    } else if (protocol === 'responses' && wire.includes('APP_E2E_AFTER_STOP')) {
      sse(res, responseText('resp-after-stop', ['after stop complete']))
    } else if (protocol === 'responses' && wire.includes('APP_E2E_STOP')) {
      res.once('close', () => { stopAborted = true })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' })
      for (const event of [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'held stream' },
      ]) writeSseEvent(res, event)
    } else if (protocol === 'responses' && wire.includes('APP_E2E_EMPTY')) {
      sse(res, responseText('resp-empty', [], { empty: true }))
    } else if (protocol === 'responses' && wire.includes('APP_E2E_ATTACHMENT')) {
      if (!wire.includes('attachment1_fixture-note.txt') || !wire.includes('attachment2_fixture-pixel.png') || !wire.includes('foxwarm-file')) {
        unexpected = 'attachment request did not expose the canonical file descriptor at the provider boundary'
        res.writeHead(500).end(unexpected)
      } else sse(res, responseText('resp-attachment', ['attachment accepted']))
    } else if (protocol === 'responses' && wire.includes('APP_E2E_LONGPASTE')) {
      if (!wire.includes('pasted-text') || !wire.includes('long paste exact tail')) {
        unexpected = 'long-paste request did not expose its opaque marker and exact content at the provider boundary'
        res.writeHead(500).end(unexpected)
      } else sse(res, responseText('resp-longpaste', ['long paste accepted']))
    } else if (protocol === 'chat' && wire.includes('APP_E2E_CHAT')) {
      const toolMessages = Array.isArray(body.messages) ? body.messages.filter(message => message?.role === 'tool') : []
      await log(`chat CHAT tools=${JSON.stringify(toolMessages.map(message => ({ callId: message.tool_call_id, content: JSON.stringify(message.content).slice(0, 160) })))}\n`)
      if (toolMessages.length === 0) sse(res, chatTool('chat-tool', 'call_chat_write', 'write', { filePath: `${toolFile}.chat`, content: 'chat tool payload' }))
      else if (toolMessages.length === 1
        && toolMessages[0].tool_call_id === 'call_chat_write'
        && JSON.stringify(toolMessages[0].content).includes('File written successfully')) {
        sse(res, chatText('chat-final', ['chat ', 'tool complete']), { delayMs: 100 })
      } else {
        unexpected = 'Chat tool result was missing or not paired to call_chat_write'
        res.writeHead(500).end(unexpected)
      }
    } else {
      unexpected = `unconsumed ${protocol} request`
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: unexpected }))
    }
  })
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', socket => {
    const connectionId = `ws-${wsConnections.length + 1}`
    wsConnections.push({ id: connectionId, socket })
    socket.on('message', raw => {
      let body
      try { body = JSON.parse(raw.toString('utf8')) } catch (error) {
        unexpected = `invalid WebSocket JSON: ${error.message}`
        socket.close(1003, 'invalid JSON')
        return
      }
      const wire = JSON.stringify(body)
      const marker = wire.includes('core-compact-background') ? 'COMPACT_BACKGROUND'
        : wire.includes('core-compact-sync') ? 'COMPACT_SYNC'
        : ['FORK_CHILD', 'WS_THREE', 'WS_TWO', 'WS_ONE', 'BTW'].find(value => wire.includes(`APP_E2E_${value}`)) || null
      const record = { protocol: 'ws', marker, connectionId, body }
      wsRequests.push(record)
      void log(`ws ${marker || 'unexpected'} connection=${connectionId} inputBytes=${wire.length}\n`)
      if (body.type !== 'response.create' || !marker) {
        unexpected = 'unexpected Responses WebSocket request'
        socket.close(1008, 'unexpected request')
        return
      }
      if (!consumeExpected('ws', marker)) {
        socket.close(1008, 'unexpected sequence')
        return
      }
      const completed = (id, text) => ({
        type: 'response.completed',
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: 11, output_tokens: 3 },
        },
      })
      if (marker === 'COMPACT_SYNC' || marker === 'COMPACT_BACKGROUND') {
        const callId = marker === 'COMPACT_SYNC' ? 'compact-sync-plan' : 'compact-background-plan'
        const argumentsText = JSON.stringify({ replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 4, summary: `${marker.toLowerCase()} summary` }] })
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: {
            id: `${callId}-response`, object: 'response', status: 'completed',
            output: [{ type: 'function_call', id: `${callId}-item`, call_id: callId, name: 'submit_compact_plan', arguments: argumentsText }],
            usage: { input_tokens: 20, output_tokens: 5 },
          },
        }))
      } else if (marker === 'BTW') socket.send(JSON.stringify(completed('ws-resp-btw', 'btw side answer')))
      else if (marker === 'WS_ONE') socket.send(JSON.stringify(completed('ws-resp-one', 'ws answer one')))
      else if (marker === 'WS_TWO') {
        if (body.previous_response_id !== 'ws-resp-one' || wire.includes('APP_E2E_WS_ONE')) {
          unexpected = 'WS_TWO did not reuse ws-resp-one with suffix-only input'
          socket.close(1008, 'invalid reuse')
          return
        }
        socket.send(JSON.stringify(completed('ws-resp-two', 'ws answer two')))
      } else if (marker === 'WS_THREE') {
        if (body.previous_response_id !== undefined || !wire.includes('APP_E2E_WS_ONE') || !wire.includes('APP_E2E_WS_TWO')) {
          unexpected = 'WS_THREE did not reconnect with a full replay and no previous response ID'
          socket.close(1008, 'invalid replay')
          return
        }
        socket.send(JSON.stringify(completed('ws-resp-three', 'ws answer three')))
      } else if (marker === 'FORK_CHILD') {
        if (body.previous_response_id !== undefined || !wire.includes('ws answer three')) {
          unexpected = 'fork child did not start an independent WS chain with inherited history'
          socket.close(1008, 'invalid fork chain')
          return
        }
        socket.send(JSON.stringify(completed('ws-resp-fork', 'fork child answer')))
      }
    })
  })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/v1/responses') {
      unexpected = `invalid provider upgrade ${request.url}`
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (readyDelayMs > 0) {
    await log('provider allocation listening\n')
    await new Promise(resolve => setTimeout(resolve, readyDelayMs))
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => {
      server.close(resolve)
      wss.close()
      for (const socket of sockets) socket.destroy()
    }),
    assertConsumed() {
      if (unexpected) throw new Error(unexpected)
      if (expectedIndex !== expectedSequence.length) {
        throw new Error(`provider consumed ${expectedIndex}/${expectedSequence.length} expected requests; next is ${expectedSequence[expectedIndex]}`)
      }
    },
  }
}
