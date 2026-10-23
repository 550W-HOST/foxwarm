// Normal Main resource/configuration and prompt boundaries, with only owned loopback peers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from '../../packages/webui/test/experimentHostFixture.mjs'
import { writeModelFixture } from '../../packages/webui/test/experimentModelFixture.mjs'

const source = process.argv.includes('--source')
const options = { env: {}, ...(source ? { runtime: 'source' } : {}) }
const fixture = await createHostFixture('retired-controls', options)
const requests = [], failures = [], rounds = new Map()
const retired = join(fixture.root, 'retired'), skills = join(fixture.root, 'configured-skills')
for (const name of ['FOXWARM_APP_ROOT', 'FOXWARM_EXPERIMENT_DATA_ROOT', 'FOXWARM_EXPERIMENT_TOOL_ROOT', 'FOXWARM_EXPERIMENT_SKILLS_ROOT', 'FOXWARM_EXPERIMENT_WEBUI_DIST', 'FOXWARM_EXPERIMENT_MONTY_BINARY']) options.env[name] = retired
options.env.FOXWARM_EXPERIMENT_INSTRUCTIONS = 'RETIRED-INSTRUCTION-SENTINEL'
await mkdir(join(skills, 'owned-skill'), { recursive: true })
await writeFile(join(skills, 'owned-skill/SKILL.md'), '---\nname: owned-skill\ndescription: Owned resource fixture.\n---\nOWNED-SKILL-BODY\n')
await mkdir(join(fixture.data, 'agents/main/memory'), { recursive: true })
await writeFile(join(fixture.data, 'agents/00_SYSTEM.md'), 'OWNED-FRAMEWORK\n')
await writeFile(join(fixture.work, 'memory/MEMORY.md'), 'OWNED-MEMORY\n')
await writeFile(join(fixture.work, 'input.txt'), 'OWNED-NATIVE-READ')
await writeFile(join(fixture.data, 'state/config.yaml'), JSON.stringify({ bot: { httpPort: fixture.port }, paths: { skillsDir: skills }, vector: false, dbWorkers: false }))
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] })
let planned = false, side = false
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), input = JSON.stringify(body.input)
    requests.push(body)
    assert(!body.instructions.includes('RETIRED-INSTRUCTION-SENTINEL'))
    assert(body.instructions.includes('OWNED-FRAMEWORK'))
    assert(body.instructions.includes('OWNED-MEMORY'))
    let output
    if (input.includes('COMPACTION STARTED:')) {
      planned = true
      const prompt = body.input.flatMap(row => row.content || []).map(part => part.text || '').filter(value => value.includes('COMPACTION STARTED:')).at(-1)
      const blocks = prompt.split(/(?=Segment \d+:)/).flatMap(section => {
        const ranges = [...section.split('Previously preserved raw messages')[0].matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)]
        return ranges.length ? [{ level: 1, sourceKind: 'message', sourceStart: +ranges[0][1], sourceEnd: +(ranges.at(-1)[2] || ranges.at(-1)[1]), summary: 'Owned completed conversation.' }] : []
      })
      output = [call('owned-plan', 'submit_compact_plan', { replaceAsBlocks: blocks })]
    } else if (input.includes('kind=\\"btw\\"') || input.includes('RETIREMENT-SIDE')) {
      side = true
      output = [text('OWNED-SIDE-DONE')]
    } else {
      const key = [...input.matchAll(/RETIREMENT:(tools|seed-\d+)/g)].at(-1)?.[1]
      assert(key, input.slice(-500))
      const n = rounds.get(key) || 0; rounds.set(key, n + 1)
      output = key === 'tools' && n === 0
        ? [call('owned-script', 'run_script', { code: "v=call_tool('read', {'filePath':'input.txt'})\nprint(v['content'])\nreturn 42" }), call('owned-skill', 'skill', { action: 'load', skillName: 'owned-skill' })]
        : [text('DONE-RETIREMENT-' + key)]
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'owned-' + requests.length, status: 'completed', output, usage: { input_tokens: 300, output_tokens: 20 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const route = '/api/sessions/owned-boundary'
async function history() { return (await fixture.api('GET', route + '/history')).body.messages }
async function settled(marker) {
  await until(async () => {
    assert.deepEqual(failures, [])
    const rows = await history(), state = await fixture.api('POST', '/api/session-list/by-id', { ids: ['owned-boundary'] })
    return !state.body.results[0].session.busy && JSON.stringify(rows).includes(marker)
  }, marker)
}
try {
  await writeModelFixture(fixture.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000, asyncCompact: false } } })
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'owned-boundary' })).status, 200)
  async function send(value, status = source ? 200 : 202) { const result = await fixture.api('POST', route + '/message', { text: value }); assert.equal(result.status, status, JSON.stringify(result)) }
  await send('RETIREMENT:tools'); await settled('DONE-RETIREMENT-tools')
  const rows = await history(), pairs = rows.flatMap(row => row.parts || []).map(part => part.functionResponse).filter(Boolean)
  assert(JSON.stringify(pairs.find(pair => pair.tool_use_id === 'owned-script')).includes('OWNED-NATIVE-READ'))
  assert(JSON.stringify(pairs.find(pair => pair.tool_use_id === 'owned-script')).includes('42'))
  assert(JSON.stringify(pairs.find(pair => pair.tool_use_id === 'owned-skill')).includes('OWNED-SKILL-BODY'))
  await send('/btw RETIREMENT-SIDE', 200); await settled('OWNED-SIDE-DONE'); assert(side)
  for (let n = 0; n < 5; n++) { await send('RETIREMENT:seed-' + n + ' ' + 'owned context '.repeat(300)); await settled('DONE-RETIREMENT-seed-' + n) }
  const compact = await fixture.api('POST', route + '/message', { text: '/compact' })
  assert.equal(compact.status, 200, JSON.stringify(compact))
  await until(() => { assert.deepEqual(failures, []); return planned }, 'normal Main planner request')
  await until(async () => !(await fixture.api('POST', '/api/session-list/by-id', { ids: ['owned-boundary'] })).body.results[0].session.busy, 'planner settlement')
  assert((await history()).some(row => row.__meta?.contextBlock), 'The actual planner must commit a compact block')
  assert((await readFile(join(fixture.data, 'state/sessions/owned-boundary.json'), 'utf8')).includes('OWNED-MEMORY'))
  await fixture.stop()
  console.log(JSON.stringify({ runtime: source ? 'source' : 'managed', requests: requests.length, normal: true, nativeMonty: true, configuredSkill: true, btw: side, compact: planned, canonicalMain: fixture.work, retiredControlsIgnored: true }))
} finally { await fixture.cleanup(); peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve)) }
