#!/usr/bin/env node
// Regenerates the WebUI demo snapshot.
//
// 1. Copies the showcase data directory (fixtures/showcase) into a disposable root.
// 2. Starts managed Main from this checkout with a scripted model and drives the
//    gallery Sessions through the real runtime (gallery-script.mjs).
// 3. Loads the real WebUI in Chromium and records every API response and realtime
//    snapshot the demo needs (record.mjs), then writes fixtures/snapshot.json.
//
// Needs a Debug build of dotnet/Foxwarm, DOTNET_ROOT, a built WebUI (packages/webui/dist),
// root and WebUI dependencies, and Chromium in FOXWARM_E2E_CHROMIUM or FOXWARM_CHROMIUM.
// Options: --serve keeps Main running after generation for manual inspection,
// --keep retains the data root, --verbose logs model and Matrix traffic.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startMain, stopMain, demoToken, repoRoot } from './main-host.mjs'
import { startScriptedModel } from './scripted-model.mjs'
import { createWorkspace, gitIdentity } from './workspace.mjs'
import * as gallery from './gallery-script.mjs'
import { recordSnapshot } from './record.mjs'
import { matrixBot, matrixRoom, matrixToken, startMatrixStub } from './matrix-stub.mjs'
import { sanitizeSnapshot } from './sanitize.mjs'

const demoRoot = resolve(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const verbose = args.has('--verbose')
const sleep = ms => new Promise(done => setTimeout(done, ms))

async function waitFor(check, label, timeoutMs = 60000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(intervalMs)
  }
}

export async function generateData({ root, log = console.log }) {
  const dataRoot = root
  const startedAt = Date.now()
  await cp(join(demoRoot, 'fixtures/showcase'), dataRoot, { recursive: true })
  const workspace = join(root, 'work/tidepool')
  await createWorkspace(workspace)
  const providerLog = []
  const model = await startScriptedModel({
    turns: gallery.turns({ workspace }),
    log: line => { providerLog.push(line); if (verbose) log(`  model: ${line}`) },
  })
  Object.assign(process.env, gitIdentity)
  // A Matrix room bound to the channel gallery Session supplies a message from another app.
  const matrix = await startMatrixStub({ log: line => { if (verbose) log(`  ${line}`) } })
  const channelsFile = join(dataRoot, 'state/channels.json')
  const bindings = JSON.parse(await readFile(channelsFile, 'utf8'))
  bindings.channels[`matrix:${matrixRoom}`] = { sessionId: gallery.channelSessionId }
  await writeFile(channelsFile, JSON.stringify(bindings))
  const extraConfig = `channels:\n  matrix: ${JSON.stringify({ type: 'matrix', homeserver: matrix.url, accessToken: matrixToken, botUserId: matrixBot, allowedUsers: [gallery.channelSender] })}\n`
  const host = await startMain({ dataRoot, providerUrl: model.url, extraConfig })
  const { api } = host
  const sessionPath = id => `/sessions/${encodeURIComponent(id)}`
  const state = async id => api('GET', `${sessionPath(id)}/state`)
  const ctx = {
    api, workspace, host, model, dataRoot, matrix,
    async createAgent(agentId) {
      const agents = await api('GET', '/agents')
      if (!JSON.stringify(agents).includes(`"${agentId}"`)) await api('POST', '/agents', { agentId })
    },
    async createSession({ id, displayName, parentSessionId, existing, cwd = workspace }) {
      const [agentId, sessionId] = id.split('/')
      await ctx.createAgent(agentId)
      if (!existing) await api('POST', '/sessions', { agentId, sessionId, ...(parentSessionId ? { parentSessionId } : {}) })
      if (displayName) await api('POST', `${sessionPath(id)}/name`, { name: displayName })
      if (cwd) await api('POST', `${sessionPath(id)}/cwd`, { cwd })
    },
    async send(id, textValue) {
      await api('POST', `${sessionPath(id)}/message`, { text: textValue })
      await waitFor(async () => {
        const value = await state(id)
        return value.busy || value.queueLength > 0 || value.runtimeState?.state !== 'idle'
      }, `${id} to accept input`, 5000).catch(() => {})
    },
    async waitIdle(id, { quietMs = 1200, timeoutMs = 90000 } = {}) {
      let idleSince = 0
      await waitFor(async () => {
        const value = await state(id)
        const idle = !value.busy && !(value.queueLength > 0)
        if (!idle) { idleSince = 0; return false }
        idleSince ||= Date.now()
        return Date.now() - idleSince >= quietMs
      }, `${id} to become idle`, timeoutMs)
    },
    async waitHeld(key) {
      await waitFor(() => model.held.has(key), `held model request ${key}`)
      await sleep(800)
    },
    async questions(id) {
      return api('GET', `${sessionPath(id)}/questions`)
    },
    async waitForOpenQuestion(id) {
      return waitFor(async () => {
        const view = await ctx.questions(id)
        return view.questions?.find(question => question.status === 'open')
      }, `${id} open question`)
    },
    async answerQuestions(id, selections) {
      const question = await ctx.waitForOpenQuestion(id)
      await api('POST', `${sessionPath(id)}/questions/${encodeURIComponent(question.id)}/answer`, {
        answers: selections.map(selection => ({ selected: [selection] })),
      })
    },
    sleep,
    waitFor,
  }
  try {
    await gallery.drive(ctx)
  } catch (error) {
    log(providerLog.slice(-30).join('\n'))
    log(host.output.slice(-4000))
    throw error
  }
  if (model.unmatched.length) {
    log(`Unscripted model requests:\n${model.unmatched.join('\n---\n')}`)
  }
  return { host, model, matrix, providerLog, dataRoot, startedAt }
}

export async function generateSnapshot({ root, log = console.log }) {
  const result = await generateData({ root, log })
  try {
    log('Recording snapshot')
    const recordedAt = Date.now()
    const recorded = await recordSnapshot({ baseUrl: result.host.baseUrl, token: demoToken, log, crawlFirst: ['gallery/live'] })
    const snapshot = sanitizeSnapshot({ format: 1, recordedAt, ...recorded }, {
      window: { start: result.startedAt, end: Date.now() },
      replacements: [[join(root, 'work'), '/app/test/work'], [root, '/app/test'], [repoRoot, '/app'], [result.model.url, 'https://models.example.com/v1'], [result.host.baseUrl, 'http://127.0.0.1:3001'], [result.matrix.url, 'https://matrix.example.org'], ['demo-provider-key', 'YOUR_API_KEY'], [matrixToken, 'YOUR_MATRIX_TOKEN']],
      forbidden: [demoToken, matrixToken, root, repoRoot, tmpdir(), '/tmp', process.env.npm_config_cache, 'demo-provider-key', process.env.HOME, process.env.USER && `/${process.env.USER}/`],
    })
    return { ...result, snapshot }
  } catch (error) {
    await stopMain(result.host)
    await result.model.close()
    await result.matrix.close()
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = await mkdtemp(join(process.env.FOXWARM_DEMO_TEMP || tmpdir(), 'fw-demo-'))
  let result
  try {
    result = await generateSnapshot({ root })
    await writeFile(join(root, 'model.log'), result.providerLog.join('\n') + '\n')
    const out = join(demoRoot, 'fixtures/snapshot.json')
    await writeFile(out, JSON.stringify(result.snapshot) + '\n')
    console.log(`Wrote ${out} (${Math.round(JSON.stringify(result.snapshot).length / 1024)} KiB)`)
    if (args.has('--serve')) {
      console.log(`Main: ${result.host.baseUrl}/ token ${demoToken} data ${root}`)
      await new Promise(done => process.once('SIGINT', done))
    }
  } finally {
    await stopMain(result?.host)
    await result?.model.close()
    await result?.matrix.close()
    if (!args.has('--keep')) await rm(root, { recursive: true, force: true })
    else console.log(`Kept ${root}`)
  }
}
