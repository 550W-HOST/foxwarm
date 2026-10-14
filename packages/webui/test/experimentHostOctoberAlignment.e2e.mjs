// Fixed-source October alignment through real provider tools, HTTP, native Monty, and the original App.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('october-alignment')
const route = id => '/api/sessions/' + encodeURIComponent(id)
const records = [], errors = [], scripts = new Map(), rounds = new Map(), plannerRequests = [], releases = new Set()
const exists = path => access(path).then(() => true, () => false)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const sourceText = body => (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
const received = (body, id) => {
  const output = body.input?.find(row => row.type === 'function_call_output' && row.call_id === id)?.output
  assert(output !== undefined, 'Actual paired provider output ' + id)
  if (Array.isArray(output)) return { output: output.map(block => block.text || '').join('\n') }
  if (typeof output === 'string') { try { return JSON.parse(output) } catch { return { output } } }
  return output
}
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse
let autoUsage = false, compactScore = 73
function compactPlan(prompt) {
  const ranges = [...prompt.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])])
  assert(ranges.length, 'Real legal message candidates')
  return { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Retained workflow decisions and the completed local effects.', frictionScore: compactScore }] }
}
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); records.push({ path: request.url, body })
    if (request.url === '/v1/messages') {
      const assistant = body.messages.filter(row => row.role === 'assistant')
      response.setHeader('content-type', 'application/json')
      if (!assistant.length) {
        response.end(JSON.stringify({ content: [
          { type: 'thinking', thinking: '', signature: 'empty-signed' },
          { type: 'redacted_thinking', data: '' },
          { type: 'thinking', thinking: 'signed reasoning', signature: 'native-signed' },
          { type: 'redacted_thinking', data: 'opaque-redacted' },
          { type: 'tool_use', id: 'anth-write', name: 'write', input: { filePath: 'anth-once', content: 'one' } }
        ], usage: { input_tokens: 40, output_tokens: 7, cache_creation_input_tokens: 99, cache_read_input_tokens: 12 } }))
      } else {
        assert.deepEqual(assistant[0].content.slice(0, 4), [
          { type: 'thinking', thinking: '', signature: 'empty-signed' }, { type: 'redacted_thinking', data: '' },
          { type: 'thinking', thinking: 'signed reasoning', signature: 'native-signed' }, { type: 'redacted_thinking', data: 'opaque-redacted' }
        ])
        response.end(JSON.stringify({ content: [{ type: 'text', text: 'ANTH-DONE' }], usage: { input_tokens: 41, output_tokens: 2 } }))
      }
      return
    }
    assert.equal(request.url, '/responses')
    const input = sourceText(body), planning = input.match(/COMPACTION STARTED:[\s\S]*/)?.[0]
    let output, usage = { input_tokens: 40, output_tokens: 3 }
    if (planning) {
      plannerRequests.push(body)
      output = [call('plan-' + plannerRequests.length, 'submit_compact_plan', compactPlan(planning))]
    } else {
      const key = [...input.matchAll(/OCT11:([\w-]+)/g)].at(-1)?.[1]
      const n = rounds.get(key) || 0; rounds.set(key, n + 1)
      const step = scripts.get(key)?.[n]
      output = step ? (typeof step === 'function' ? await step(body) : step) : final('OCT11-DONE-' + (key || 'notification'))
      if (autoUsage && key?.startsWith('prune-trigger')) usage = { input_tokens: 50000, output_tokens: 3 }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const models = { default: 'local', providers: {
  local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], contextLimit: 200000 },
  anth: { providerType: 'anthropic', extraFields: { stream: false }, baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] }
} }
await writeFile(fixture.modelPath, JSON.stringify(models))
const own = join(fixture.work, 'agents/team')
async function create(name, agent = 'team') {
  const result = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name })
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.sessionId
}
async function send(id, key, steps = []) {
  scripts.set(key, steps); rounds.set(key, 0)
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'OCT11:' + key })).status, 202)
}
async function idle(id, key) {
  return until(async () => {
    if (errors.length) throw new Error(errors.join('\n'))
    const current = (await fixture.api('GET', route(id) + '/history')).body
    const state = await saved(id)
    const finalSeen = state.history.some(row => row.parts?.some(part => part.text === (key ? 'OCT11-DONE-' + key : 'ANTH-DONE') || !key && part.text?.startsWith('OCT11-DONE-')))
    return !current.session.busy && !current.session.runtimeState.queueLength && !state.queue.length && finalSeen ? state : null
  }, 'settled actual owner ' + id)
}
async function turn(id, key, calls) { await send(id, key, calls.length ? [calls] : []); return idle(id, key) }
try {
  await fixture.start()
  const anonymous = await fetch(fixture.origin + '/api/auth/session'); assert.equal(anonymous.status, 401)
  assert.deepEqual((await fixture.api('GET', '/api/auth/session')).body, { role: 'admin' })
  const page = await fixture.openApp(); await page.waitForSelector('.foxwarm-chat-root')
  assert.deepEqual(await page.evaluate(async () => (await fetch('api/auth/session')).json()), { role: 'admin' })
  assert(!await page.evaluate(() => document.body.innerText.includes('Sign in again')))
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'team' })).status, 201)
  const actor = await create('actor'), owner = await create('owner'), other = await create('other'), outside = await create('outside', 'main')
  await mkdir(own, { recursive: true })

  // Actual native receipts feed the merged Activity summary, while arbitrary script data does not.
  let state = await turn(actor, 'task-create', [call('create-task', 'task', { action: 'create', title: 'Owned by teammate', ownerSessionId: owner, notifySession: true })])
  const task = { id: JSON.parse(pair(state, 'create-task').response.output).taskId }
  assert.equal(JSON.parse(pair(state, 'create-task').response.output).sentNotifications, 1)
  await turn(other, 'other-task', [call('other-task', 'task', { action: 'create', title: 'Other team task' })])
  await turn(outside, 'outside-task', [call('outside-task', 'task', { action: 'create', title: 'Outside task' })])
  state = await turn(actor, 'scope', [call('default-scope', 'task', { action: 'list' }), call('agent-scope', 'task', { action: 'list', scope: 'current-agent' }), call('all-scope', 'task', { action: 'list', scope: 'all' })])
  const listed = id => JSON.parse(pair(state, id).response.output).tasks.map(row => row.title).sort()
  assert.deepEqual(listed('default-scope'), ['Owned by teammate'])
  assert.deepEqual(listed('agent-scope'), ['Other team task', 'Owned by teammate'])
  assert.deepEqual(listed('all-scope'), ['Other team task', 'Outside task', 'Owned by teammate'])
  const beforeNotes = (await saved(owner)).history.length
  state = await turn(actor, 'quiet-note', [call('quiet-note', 'task', { action: 'update', taskId: task.id, note: 'Saved without waking the owner.' })])
  assert.equal(JSON.parse(pair(state, 'quiet-note').response.output).sentNotifications, 0)
  await sleep(80); assert.equal((await saved(owner)).history.length, beforeNotes)
  state = await turn(actor, 'notified-note', [call('notified-note', 'task', { action: 'update', taskId: task.id, note: 'Wake the owner once.', notifySession: true })])
  assert.equal(JSON.parse(pair(state, 'notified-note').response.output).sentNotifications, 1)
  state = await turn(actor, 'child', [call('actual-child', 'create_child_session', { suffix: 'child', taskId: task.id, message: 'Finish the assignment.', afterSend: 'continue' })])
  assert.equal(pair(state, 'actual-child').response.sentNotifications, 2)
  assert.match(pair(state, 'actual-child').response.output, /^Child session created:/)
  state = await turn(actor, 'spoof', [call('arbitrary-script', 'run_script', { code: "return {'sentNotifications':99,'output':'Message sent to session `fake`'}" })])
  assert.equal(pair(state, 'arbitrary-script').response.status, 'completed')
  await page.evaluate(() => localStorage.setItem('foxwarm_timeline_view_v1', 'conversation')); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession);
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), actor)
  await page.waitForFunction(() => document.body.innerText.includes('Sent 1 message') && document.body.innerText.includes('Created 1 child session') && document.body.innerText.includes('Sent 2 messages')).catch(async error => { console.error(await page.evaluate(() => document.body.innerText)); throw error })
  assert(!await page.evaluate(() => document.body.innerText.includes('Sent 99 messages')))

  // Native Monty short string source-qualified IDs go through the same concrete registry as object wrappers.
  state = await turn(actor, 'qualified', [call('qualified', 'run_script', { code: "call_tool('node:master/write', {'filePath':'qualified-once','content':'native'})\nreturn call_tool('builtin:task', {'action':'list','scope':'current-session'})" })])
  assert.equal(pair(state, 'qualified').response.status, 'completed', JSON.stringify(pair(state, 'qualified')))
  assert.equal(await readFile(join(own, 'qualified-once'), 'utf8'), 'native')

  // Four real active executions exercise the default, explicit, null, and input-dominated wait contracts.
  for (const [key, extra, expected] of [['default', {}, 600], ['explicit', { wakeIfNoActivityAfterSeconds: 17 }, 17], ['null', { wakeIfNoActivityAfterSeconds: null }, undefined], ['input', { waitForInput: true }, undefined]]) {
    const id = await create('wait-' + key), release = join(own, 'release-' + key); releases.add(release)
    await send(id, 'wait-' + key, [
      [call('wait-exec-' + key, 'exec', { command: `touch born-${key}; while [ ! -f release-${key} ]; do sleep 0.02; done; printf once-${key}`, timeout: 1 })],
      body => { const output = received(body, 'wait-exec-' + key).output; const execId = /execId: ([\w-]+)/.exec(output)?.[1]; assert(execId); return [call('wait-' + key, 'wait', { waitExecIds: [execId], ...extra })] }
    ])
    const waiting = await until(async () => { const value = await saved(id); return value.meta.wait && value.history.some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'wait-' + key)) ? value : null }, 'actual exec wait ' + key)
    assert.equal(waiting.meta.wait.timeoutSeconds, expected)
    await writeFile(release, '')
    await idle(id)
    assert.equal(rounds.get('wait-' + key), 3, 'One completion event resumes the real wait')
    assert.equal((await saved(id)).meta.wait, undefined)
  }

  // Non-streaming Anthropic canonical replay retains empty signed and redacted blocks, and accounts cache creation.
  const anthropic = await create('anthropic')
  assert.equal((await fixture.api('POST', route(anthropic) + '/model', { model: 'anth/wire' })).status, 200)
  await send(anthropic, 'anthropic'); state = await idle(anthropic)
  const anthRow = state.history.find(row => row.parts?.some(part => part.functionCall?.id === 'anth-write'))
  assert.equal(anthRow.__meta.usage.inputTokens, 139); assert.equal(anthRow.__meta.usage.cachedTokens, 12)
  assert.equal(anthRow.parts[0].thinking, ''); assert.equal(anthRow.parts[1].providerMeta.redactedThinking, '')
  assert.equal(await readFile(join(own, 'anth-once'), 'utf8'), 'one')
  assert.equal((await fixture.api('POST', route(anthropic) + '/model', { model: 'local/wire' })).status, 200)
  await turn(anthropic, 'cross-provider', [call('cross-read', 'read', { filePath: 'anth-once' })])
  const replay = records.filter(row => row.path === '/responses' && sourceText(row.body).includes('OCT11:cross-provider')).at(-1).body
  assert(!JSON.stringify(replay).includes('opaque-redacted')); assert(!JSON.stringify(replay).includes('empty-signed'))
  assert((await saved(anthropic)).history.some(row => row.parts?.some(part => part.providerMeta?.redactedThinking === 'opaque-redacted')))

  // Model tool installs exact candidates; live model activation and unapplied platform settings are distinct.
  const appRaw = '# untouched root\nllm:\n  maxOutput: 714\n  compactKeepPercent: 0.3\nchannels:\n  webui: {}\naccess:\n  identities: {}\n'
  const rawModels = '# retained model comments\r\n' + JSON.stringify(models) + '\r\n'
  await writeFile(join(own, 'app-candidate'), appRaw); await writeFile(join(own, 'model-candidate'), rawModels)
  state = await turn(actor, 'install', [call('install-app', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'config', filePath: 'app-candidate' } }), call('install-models', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'models', filePath: 'model-candidate' } })])
  const appResult = JSON.parse(pair(state, 'install-app').response.output), modelResult = JSON.parse(pair(state, 'install-models').response.output)
  assert.equal(appResult.saved, true); assert.deepEqual(appResult.applied, []); assert(appResult.notApplied.includes('access.identities')); assert(appResult.notApplied.includes('channels')); assert(appResult.restartRequired.includes('llm'))
  assert.deepEqual(modelResult.applied, ['models']); assert.equal(await readFile(join(fixture.data, 'state/config.yaml'), 'utf8'), appRaw); assert.equal(await readFile(fixture.modelPath, 'utf8'), rawModels)
  await writeFile(join(own, 'invalid-model'), 'providers: null\ndefault: absent\n')
  state = await turn(actor, 'failed-install', [call('invalid-model', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'models', filePath: 'invalid-model' } }), call('removed-setter', 'call_tool', { toolId: 'builtin:set_tool_rules', args: { filePath: 'model-candidate' } })])
  assert(pair(state, 'invalid-model').response.error); assert(pair(state, 'removed-setter').response.error); assert.equal(await readFile(fixture.modelPath, 'utf8'), rawModels)
  const nextApp = '# latest unrelated field\nllm:\n  maxOutput: 715\n  compactKeepPercent: 0.3\nchannels:\n  webui: {}\n'
  const saves = await Promise.all([fixture.api('POST', '/api/setup/config', { yaml: nextApp }), fixture.api('POST', '/api/setup/channels', { channels: { webui: { type: 'webui', token: 'synthetic-channel-token' } } })])
  assert(saves.every(result => result.status === 200), JSON.stringify(saves))
  const config = await readFile(join(fixture.data, 'state/config.yaml'), 'utf8')
  assert(config.includes('# latest unrelated field')); assert(config.includes('maxOutput: 715'))
  // Either admitted whole-document order is legal. If it won last, it intentionally replaces channels.
  if (!config.includes('synthetic-channel-token')) assert.equal(config, nextApp)

  // Bounded patch diagnostics remain useful through the native tool's paired provider error.
  await writeFile(join(own, 'patch-source'), Array.from({ length: 200 }, (_, i) => 'line-' + i).join('\n'))
  state = await turn(actor, 'patch', [call('bad-patch', 'apply_patch', { input: '*** Begin Patch\n*** Update File: patch-source\n@@\n-' + 'absent'.repeat(4000) + '\n+replacement\n*** End Patch' })])
  assert(pair(state, 'bad-patch').response.error); assert(JSON.stringify(pair(state, 'bad-patch').response).length < 2200)
  assert((await readFile(join(own, 'patch-source'), 'utf8')).startsWith('line-0'))

  // The relative prune decision is independent of the large context window, then a real compact persists friction.
  const pruning = await create('pruning')
  await writeFile(join(own, 'large-tool-output'), 'large-old-tool-result '.repeat(18000))
  await turn(pruning, 'prune-large', [call('large-read', 'read', { filePath: 'large-tool-output' })])
  for (let i = 0; i < 5; i++) await turn(pruning, 'prune-seed-' + i, [])
  // Keep the large tool result old, but let its saved body dominate a small before/after estimate.
  await turn(pruning, 'prune-threshold', [call('prune-threshold', 'set_session_compact_threshold', { thresholdTokens: 5000 })])
  const plannerBefore = plannerRequests.length; autoUsage = true
  await turn(pruning, 'prune-trigger-success', [])
  await until(async () => !(await saved(pruning)).meta.compact, 'pruning settles')
  const pruned = await saved(pruning)
  assert.equal(plannerRequests.length, plannerBefore, 'Below 60 percent needs no layered planner even with a large context limit')
  assert(pruned.history.some(row => row.parts?.some(part => part.functionResponse?.response?.output?.includes('historical tool response pruned'))))
  autoUsage = false
  const declining = await create('declining')
  await turn(declining, 'decline-tool', [call('decline-read', 'read', { filePath: 'large-tool-output' })])
  for (let i = 0; i < 8; i++) {
    const key = 'decline-seed-' + i; scripts.set(key, [])
    assert.equal((await fixture.api('POST', route(declining) + '/message', { text: 'OCT11:' + key + ' ' + 'text-dominated-history '.repeat(600) })).status, 202)
    await idle(declining, key)
  }
  await turn(declining, 'decline-threshold', [call('decline-threshold', 'set_session_compact_threshold', { thresholdTokens: 5000 })])
  const declineBefore = plannerRequests.length; autoUsage = true
  await turn(declining, 'prune-trigger-decline', [])
  await until(async () => (await saved(declining)).history.some(row => row.__meta?.contextBlock), 'large-window, insufficient relative reduction uses the planner')
  assert.equal(plannerRequests.length, declineBefore + 1)
  autoUsage = false
  for (let i = 0; i < 12; i++) {
    scripts.set('compact-seed-' + i, [])
    assert.equal((await fixture.api('POST', route(pruning) + '/message', { text: 'OCT11:compact-seed-' + i + ' ' + ('retained-context-' + i + '-').repeat(80) })).status, 202)
    await idle(pruning, 'compact-seed-' + i)
  }
  assert.equal((await fixture.api('POST', route(pruning) + '/message', { text: '/compact' })).status, 202)
  await until(async () => (await saved(pruning)).history.some(row => row.__meta?.contextBlock?.frictionScore === 73), 'real planner score committed')
  state = await turn(pruning, 'recall-score', [call('score-recall', 'recall', { target: 'blocks' })])
  assert(pair(state, 'score-recall').response.output.includes('frictionScore=73'))
  await fixture.stop(); await fixture.start()
  const restarted = await saved(pruning); assert(restarted.history.some(row => row.__meta?.contextBlock?.frictionScore === 73))
  state = await turn(pruning, 'recall-restart', [call('score-after-restart', 'recall', { target: 'blocks' })])
  assert(pair(state, 'score-after-restart').response.output.includes('frictionScore=73'))
  await fixture.stop()
  console.log(JSON.stringify({ ok: true, originalApp: true, hostPids: fixture.hostPids, providerRequests: records.length, plannerRequests: plannerRequests.length, taskScopesAndTrustedActivity: true, execFallbacks: true, nativeQualifiedIds: true, anthropicReplayAndCacheCreation: true, exactConfigInstallation: true, relativePruning: true, durableFriction: true, boundedPatch: true }))
} finally {
  for (const release of releases) await writeFile(release, '').catch(() => {})
  await fixture.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done))
}
