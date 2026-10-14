// Owned loopback AS and official SDK resource from the canonical Source scenarios.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const source = process.env.FOXWARM_TS_ROOT
if (!source) throw new Error('Set FOXWARM_TS_ROOT to the built repository checkout')
const { createMcpOAuthFixture } = require(resolve(source, 'lib/mcpOAuthTestFixture.js'))
const fixture = await createMcpOAuthFixture()
let releaseRefresh, releaseSlow, releaseMetadata, releaseInitialize401, releaseInitializeResult
let slowEntered = false, refreshEntered = false, metadataEntered = false
let initializePhase = 0, initialize401Entered = false, initializeResultEntered = false, initializeCredential
// Gate real initialization after body parsing, before the SDK resource dispatch.
fixture.app.use((req, res, next) => {
  if (req.path === '/mcp' && req.body?.method === 'initialize') {
    if (initializePhase === 1) {
      initialize401Entered = true
      releaseInitialize401 = () => {
        initializePhase = 2
        res.set('WWW-Authenticate', 'Bearer error="invalid_token"').status(401).json({ error: 'invalid_token' })
      }
      return
    }
    if (initializePhase === 2) {
      initializePhase = 3
      initializeResultEntered = true
      initializeCredential = String(req.headers.authorization).replace(/^Bearer /, '')
      releaseInitializeResult = () => {
        initializePhase = 0
        if (fixture.state.initializeError) {
          res.json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32603, message: 'Remote initialization failed using ' + initializeCredential } })
        } else next()
      }
      return
    }
  }
  next()
})
const stack = fixture.app._router?.stack || fixture.app.router.stack
const initializeGate = stack.pop()
stack.splice(stack.findIndex(layer => !!layer.route), 0, initializeGate)
const handle = fixture.app.handle.bind(fixture.app)
fixture.app.handle = (req, res, next) => {
  if (req.url.startsWith('/.well-known/oauth-authorization-server/') && fixture.state.metadataGate) {
    metadataEntered = true
    fixture.state.metadataGate.then(() => handle(req, res, next))
    return
  }
  if (req.url === '/token') {
    const json = fixture.app.response.json.bind(res)
    res.json = body => {
      if (fixture.state.omitRefreshToken && req.body?.grant_type === 'refresh_token' && body.access_token) {
        fixture.refreshTokens.set(req.body.refresh_token, { resource: req.body.resource, scope: body.scope || 'read' })
        delete body.refresh_token
      }
      return json(body)
    }
  }
  return handle(req, res, next)
}
fixture.state.delayedTool = async access => {
  slowEntered = true
  const gate = fixture.state.slowGate
  if (gate) await gate
  return { text: fixture.state.slowEcho ? access : 'ordinary completed effect', error: fixture.state.slowError || false }
}
fixture.state.refreshEntered = () => { refreshEntered = true }
fixture.app.post('/fixture/client-metadata', (req, res) => {
  fixture.state.fetchClientMetadata = async url => req.body.client_id === url ? req.body : undefined
  res.json({ ok: true })
})
fixture.app.get('/fixture/state', (_req, res) => res.json({
  ...Object.fromEntries(Object.entries(fixture.state).filter(([, value]) => typeof value !== 'function' && !(value instanceof Promise))),
  slowEntered, refreshEntered, metadataEntered, initialize401Entered, initializeResultEntered, initializeCredential,
  accessTokens: [...fixture.tokens.keys()], refreshTokens: [...fixture.refreshTokens.keys()],
}))
fixture.app.post('/fixture/state', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    if (!['registration', 'force401', 'requiredScope', 'mismatchIssuer', 'mismatchResource', 'pkce', 'invalidRefresh',
      'echoCredential', 'issueRefreshTokens', 'tokenLifetime', 'omitRefreshScope', 'slowEcho', 'slowError', 'deepResult', 'imageData', 'omitRefreshToken', 'initializeError'].includes(key)) {
      res.status(400).json({ error: 'Unknown fixture setting' }); return
    }
    fixture.state[key] = value
  }
  res.json({ ok: true })
})
fixture.app.post('/fixture/gate/:kind', (req, res) => {
  if (req.params.kind === 'refresh') {
    refreshEntered = false
    fixture.state.refreshGate = new Promise(done => { releaseRefresh = done })
  } else if (req.params.kind === 'slow') {
    slowEntered = false
    fixture.state.slowGate = new Promise(done => { releaseSlow = done })
  } else if (req.params.kind === 'metadata') {
    metadataEntered = false
    fixture.state.metadataGate = new Promise(done => { releaseMetadata = done })
  } else if (req.params.kind === 'initialize') {
    initializePhase = 1
    initialize401Entered = false
    initializeResultEntered = false
  } else { res.sendStatus(400); return }
  res.json({ ok: true })
})
fixture.app.post('/fixture/release/:kind', (req, res) => {
  if (req.params.kind === 'refresh') releaseRefresh?.()
  else if (req.params.kind === 'slow') { fixture.state.slowGate = undefined; releaseSlow?.() }
  else if (req.params.kind === 'metadata') { fixture.state.metadataGate = undefined; releaseMetadata?.() }
  else if (req.params.kind === 'initialize401') releaseInitialize401?.()
  else if (req.params.kind === 'initializeResult') releaseInitializeResult?.()
  else { res.sendStatus(400); return }
  res.json({ ok: true })
})
process.stdout.write(JSON.stringify({ url: fixture.baseUrl }) + '\n')
process.once('SIGTERM', async () => { releaseRefresh?.(); releaseSlow?.(); releaseMetadata?.(); await fixture.close(); process.exit(0) })
