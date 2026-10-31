// Project placement and recovery through a normal managed host and an official CLI Node.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const stage = message => console.log('Project targets: ' + message)
const codeAssets = resolve('dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets/vscode-web')
const hasCode = await access(join(codeAssets, 'out/vs/workbench/workbench.web.main.internal.js')).then(() => true, () => false)
const fixture = await createHostFixture('project-targets', { env: {} })
const remote = join(fixture.root, 'remote'), directory = join(remote, 'project space')
await mkdir(directory, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
await writeFile(join(directory, 'tracked.txt'), 'original Project file')
git('add', '.'); git('commit', '-qm', 'Project commit fixture')
const commit = git('rev-parse', 'HEAD')
await writeFile(join(fixture.data, 'state/config.yaml'), `bot: {httpPort: ${fixture.port}}\nvector: false\n`)
const errors = [], requests = []
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const output = body.input.some(item => item.type === 'function_call_output')
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `PROJECT-TARGET-DONE\n\n<foxwarm-commit node="project-cli" path="${directory}" id="${commit}" />` }] }]
      : [{ type: 'function_call', name: 'write', call_id: 'project-write', arguments: JSON.stringify({ filePath: 'first-turn.txt', content: 'remote project effect' }) }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 30, output_tokens: 5 } } }) + '\n\n')
  } catch (error) { errors.push(String(error)); response.destroy() }
})
provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${provider.address().port}`, models: ['wire'] } } }))
let client, output = '', page
const route = id => '/api/sessions/' + encodeURIComponent(id)
async function api(method, path, body) {
  const reply = await fixture.api(method, path, body)
  assert.equal(reply.status, 200, JSON.stringify({ method, path, reply }))
  return reply.body
}
async function clickText(text, selector = 'button') {
  await page.waitForFunction((text, selector) => [...document.querySelectorAll(selector)].some(node => node.textContent.trim() === text && node.getClientRects().length), {}, text, selector)
  assert(await page.evaluate((text, selector) => {
    const button = [...document.querySelectorAll(selector)].find(node => node.textContent.trim() === text && node.getClientRects().length)
    button?.click(); return !!button
  }, text, selector), 'visible ' + text)
}
try {
  stage('start managed Main')
  await fixture.start()
  const credential = await api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: 'project-cli' })
  const credentials = join(remote, 'credentials.json')
  await writeFile(credentials, JSON.stringify({ nodeId: 'project-cli', authToken: credential.authToken }), { mode: 0o600 })
  client = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', fixture.origin, '--credentials-file', credentials, '--no-local-trigger'], {
    cwd: remote, stdio: ['ignore', 'pipe', 'pipe'], env: { ...testEnvironment.isolatedApplicationEnv(join(remote, 'data')), FOXWARM_AGENTS_DIR: join(remote, 'agents') },
  })
  for (const stream of [client.stdout, client.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-10000) })
  await until(async () => (await api('GET', '/api/nodes')).nodes.some(node => node.id === 'project-cli' && node.online), 'official Project Node online')
  const defaultDirectory = await api('POST', '/api/projects/resolve-directory', { nodeId: 'project-cli' })
  assert.equal(defaultDirectory.rootPath, remote)
  const project = (await api('POST', '/api/projects', { nodeId: 'project-cli', rootPath: directory, name: 'Remote Project' })).project
  const work = (await api('POST', `/api/projects/${project.id}/sessions`, { title: 'Remote work' })).session
  const tabUrl = `/api/project-sessions/${work.id}/tabs`
  const tab = (await api('POST', tabUrl, { type: 'agent', requestId: 'first-agent' })).tab
  const id = tab.resourceId
  const initial = JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8'))
  assert.equal(initial.currentNode, 'project-cli'); assert.equal(initial.cwd, directory)
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'Write in the initial Project directory.' })).status, 202)
  await until(async () => (await api('GET', route(id) + '/history')).messages.some(row => row.parts?.some(part => part.text?.startsWith('PROJECT-TARGET-DONE'))), 'first Project turn completed')
  assert.equal(await readFile(join(directory, 'first-turn.txt'), 'utf8'), 'remote project effect')
  assert.equal(requests.length, 2); assert.deepEqual(errors, [])
  const hiddenClassic = (await api('POST', '/api/sessions', { sessionId: 'hidden-classic' })).sessionId
  stage('first remote turn completed; open original App')
  page = await fixture.openApp()
  page.on('dialog', dialog => console.error('Native dialog: ' + JSON.stringify({ type: dialog.type(), message: dialog.message().slice(0, 2048) })))
  page.on('error', error => console.error('Browser page error: ' + error.message))
  page.on('pageerror', error => console.error('Browser script error: ' + error.message))
  page.on('console', message => { if (message.type() === 'error') console.error('Browser console: ' + message.text().slice(0, 2000)) })
  page.on('requestfailed', request => console.error('Browser request failed: ' + request.url() + ' ' + request.failure()?.errorText))
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), hiddenClassic)
  await page.setViewport({ width: 1440, height: 900 })
  await page.evaluate(workId => {
    localStorage.setItem('foxwarm_workspace_mode_v1', 'project')
    localStorage.setItem('foxwarm_project_active_session_v1', workId)
    window.dispatchEvent(new Event('foxwarm-workspace-mode-changed'))
  }, work.id)
  await page.waitForSelector('[data-project-workspace] .foxwarm-chat-root', { visible: true })
  // Seed cold-start unread state only after classic is hidden. The preceding
  // asynchronous navigation may otherwise acknowledge its still-visible Chat.
  await page.evaluate(({projectId, hiddenClassic}) => {
    localStorage.setItem('foxwarm_session_idle_unread_v1', JSON.stringify({ version: 1, unread: { [projectId]: Date.now(), [hiddenClassic]: Date.now() } }))
  }, { projectId: id, hiddenClassic })
  await page.reload({ waitUntil: 'networkidle0' })
  await waitForWebUiReady(page)
  await page.waitForSelector('[data-project-workspace] .foxwarm-chat-root', { visible: true })
  const unread = () => page.evaluate(() => JSON.parse(localStorage.getItem('foxwarm_session_idle_unread_v1') || '{}').unread || {})
  await until(async () => !(await unread())[id], 'visible Project acknowledges its conversation')
  assert((await unread())[hiddenClassic], 'hidden classic selection must remain unread')
  await page.click('[data-project-workspace] [aria-label="New tab"]')
  await clickText('terminal', '[role="menuitem"]')
  const terminalTab = await until(async () => (await api('GET', '/api/projects')).projects[0].sessions[0].tabs.find(tab => tab.type === 'terminal' && tab.resourceId), 'remote Project terminal persisted')
  const terminal = (await api('GET', '/api/terminals/' + terminalTab.resourceId)).terminal
  assert.equal(terminal.nodeId, 'project-cli'); assert.equal(terminal.cwd, directory)
  await page.evaluate(id => {
    const key = 'foxwarm_session_idle_unread_v1'
    const stored = JSON.parse(localStorage.getItem(key) || '{"version":1,"unread":{}}')
    stored.unread[id] = Date.now(); localStorage.setItem(key, JSON.stringify(stored))
    window.dispatchEvent(new Event('foxwarm-idle-unread-changed'))
  }, id)
  await page.click(`[aria-label="Unassigned conversations"] button[title="${hiddenClassic}"]`)
  await until(async () => !(await unread())[hiddenClassic], 'visible auxiliary Chat acknowledges its conversation')
  assert((await unread())[id], 'underlying Project Chat is hidden by its auxiliary Chat')
  await clickText('Back to work session')
  await clickText('Agent', '[role="tab"]')
  await until(async () => !(await unread())[id], 'returning to Project acknowledges its conversation')
  if (hasCode) {
    await api('GET', '/vscode-web/?embedded=true&initialFolderUri=' + encodeURIComponent('foxwarm://node+project-cli' + directory))
    await page.waitForSelector('button[title="Open first-turn.txt in Code"]')
    stage('attention passed; open real auxiliary Code from tool path')
    await page.click('button[title="Open first-turn.txt in Code"]')
    let auxiliaryCode = await until(() => page.frames().find(frame => frame.parentFrame() === page.mainFrame() && frame.url().includes('/vscode-web/') && !frame.url().includes('workspaceId=')), 'Project tool-path auxiliary Code frame', 30000)
    stage('auxiliary Code iframe exists: ' + auxiliaryCode.url())
    await auxiliaryCode.waitForSelector('.editor-instance .view-lines', { timeout: 60000 })
    await auxiliaryCode.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('remote project effect'))
    await auxiliaryCode.click('.editor-instance .view-lines'); await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await page.keyboard.type(' saved in Project Code'); await page.keyboard.down('Control'); await page.keyboard.press('S'); await page.keyboard.up('Control')
    await until(async () => (await readFile(join(directory, 'first-turn.txt'), 'utf8')).includes('saved in Project Code'), 'Project tool-path editor saves on the exact remote Node')
    await clickText('Back to work session')
    stage('real Code file save passed; open commit')
    await page.waitForSelector('button[title="Open commit details in Code"]')
    await page.click('button[title="Open commit details in Code"]')
    const details = await until(async () => {
      for (const frame of page.frames()) {
        try { if ((await frame.evaluate(() => document.body.innerText)).includes('Project commit fixture') && (await frame.evaluate(() => document.body.innerText)).includes('Changed files')) return frame } catch {}
      }
    }, 'Project commit opens the real SCM details webview', 45000)
    assert((await details.evaluate(() => document.body.innerText)).includes(directory))
    await clickText('Back to work session')
    await clickText('Code', '[data-project-workspace] .foxwarm-chat-root button')
    const ownCode = await until(() => page.frames().find(frame => frame.parentFrame() === page.mainFrame() && frame.url().includes('workspaceId=' + work.id)), 'independent work-session Code frame', 30000)
    stage('work-session Code frame exists')
    await ownCode.waitForSelector('.monaco-workbench', { timeout: 60000 })
    const descriptor = JSON.parse(await readFile(join(fixture.data, 'state/vscode-web/project-workspaces', work.id + '.code-workspace'), 'utf8'))
    assert.equal(new URL(descriptor.folders[0].uri).hostname, 'node+project-cli')
    assert.equal(decodeURIComponent(new URL(descriptor.folders[0].uri).pathname), directory)
    assert.notEqual(ownCode, auxiliaryCode)
    await ownCode.waitForSelector('[role="treeitem"][aria-label="tracked.txt"]', { timeout: 30000 })
    await ownCode.click('[role="treeitem"][aria-label="tracked.txt"]')
    await ownCode.waitForSelector('.editor-instance .view-lines')
    await ownCode.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('original Project file'))
    await ownCode.click('.editor-instance .view-lines'); await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await page.keyboard.type(' retained Project editor draft')
    const review = (await api('POST', `/api/projects/${project.id}/sessions`, { title: 'Review work' })).session
    await page.click('[data-project-workspace] [aria-label="Refresh projects"]')
    await clickText('Review work', '[data-project-workspace] aside button')
    await page.click('[data-project-workspace] [aria-label="New tab"]')
    await clickText('code', '[role="menuitem"]')
    const reviewCode = await until(() => page.frames().find(frame => frame.parentFrame() === page.mainFrame() && frame.url().includes('workspaceId=' + review.id)), 'second work-session Code identity', 30000)
    await reviewCode.waitForSelector('.monaco-workbench', { timeout: 60000 })
    assert.notEqual(ownCode, reviewCode)
    await clickText('Remote work', '[data-project-workspace] aside button')
    await clickText('Code', '[role="tab"]')
    assert(page.frames().includes(ownCode), 'first Code frame stays mounted through work-session switching')
    await ownCode.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('retained Project editor draft'))
    await clickText('Agent', '[role="tab"]')
  } else stage('optional official Code assets are not prepared; editor actions not qualified')
  await page.click('[data-project-workspace] [aria-label="New tab"]')
  await clickText('agent', '[role="menuitem"]')
  const tabs = await until(async () => {
    const tabs = (await api('GET', '/api/projects')).projects[0].sessions[0].tabs
    return tabs.filter(tab => tab.type === 'agent').length === 2 && tabs
  }, 'second independent Agent')
  assert.notEqual(tabs.filter(tab => tab.type === 'agent')[1].resourceId, id)
  // A failed directory check reserves its identity before a genuine Main restart.
  const recoveryDirectory = join(fixture.work, 'recovery project 雪')
  await mkdir(recoveryDirectory)
  const recoveryProject = (await api('POST', '/api/projects', { nodeId: 'master', rootPath: recoveryDirectory, name: 'Recovery' })).project
  const recoveryWork = (await api('POST', `/api/projects/${recoveryProject.id}/sessions`, { title: 'Recover' })).session
  const recoveryUrl = `/api/project-sessions/${recoveryWork.id}/tabs`
  await rename(recoveryDirectory, recoveryDirectory + '.away')
  assert.equal((await fixture.api('POST', recoveryUrl, { type: 'agent', requestId: 'pending-after-restart' })).status, 404)
  const reserved = (await api('GET', '/api/projects')).projects.find(item => item.id === recoveryProject.id).sessions[0].tabs[0]
  assert.equal(reserved.state, 'pending')
  await assert.rejects(readFile(join(fixture.data, 'state/sessions', reserved.resourceId + '.json')), { code: 'ENOENT' })
  await page.close(); page = null
  await fixture.stop()
  await rename(recoveryDirectory + '.away', recoveryDirectory)
  await fixture.start()
  const restored = (await api('GET', '/api/projects')).projects.find(item => item.id === project.id)
  assert.equal(restored.id, project.id); assert.equal(restored.sessions.find(item => item.id === work.id).tabs.length, tabs.length)
  const recovered = (await api('POST', recoveryUrl, { type: 'agent', requestId: 'pending-after-restart' })).tab
  assert.equal(recovered.id, reserved.id); assert.equal(recovered.resourceId, reserved.resourceId); assert.equal(recovered.state, 'ready')
  assert.equal((await api('POST', recoveryUrl, { type: 'agent', requestId: 'pending-after-restart' })).tab.id, reserved.id)
  const recoveredOwner = (await api('GET', route(recovered.resourceId) + '/history')).session
  assert.equal(recoveredOwner.currentNode, 'master'); assert.equal(recoveredOwner.cwd, recoveryDirectory)
  assert.equal((await api('POST', tabUrl, { type: 'agent', requestId: 'first-agent' })).tab.resourceId, id)
  assert.equal((await api('GET', route(id) + '/history')).session.cwd, directory)
  await until(async () => (await api('GET', '/api/nodes')).nodes.some(node => node.id === 'project-cli' && node.online), 'official Node reconnect after Main restart')
  // Existing conversations are associated only at their current target, never rebound.
  const existing = (await api('POST', '/api/sessions', { sessionId: 'unassigned' })).sessionId
  assert.equal((await fixture.api('POST', tabUrl, { type: 'agent', existingSessionId: existing })).status, 409)
  await api('POST', route(existing) + '/node', { nodeId: 'project-cli' })
  await api('POST', route(existing) + '/cwd', { cwd: directory })
  assert.equal((await api('POST', tabUrl, { type: 'agent', existingSessionId: existing })).tab.resourceId, existing)
  await fixture.stop()
  console.log(JSON.stringify({ managedMain: true, officialNode: true, initialPlacement: true, firstTurnWrite: true, remoteTerminal: true, actualProjectCode: hasCode, fileAndCommitActions: hasCode, projectAndAuxiliaryAttention: true, restartMembership: true, pendingRestartRecovery: true, existingAssociation: true }))
} catch (error) {
  if (page) for (const frame of page.frames().filter(frame => frame.parentFrame() === page.mainFrame())) {
    console.error(await Promise.race([frame.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 9000), tree: [...document.querySelectorAll('[role="treeitem"]')].slice(0, 12).map(item => item.outerHTML.slice(0, 1500)) })).catch(() => null), new Promise(done => setTimeout(() => done('Frame diagnostics timed out.'), 3000))]))
  }
  if (page) console.error(await Promise.race([page.evaluate(() => ({text: document.body.innerText.slice(0, 7000), buttons: [...document.querySelectorAll('[data-project-workspace] button')].filter(button => button.getClientRects().length).map(button => ({label: button.getAttribute('aria-label'), text: button.textContent, expanded: button.getAttribute('aria-expanded')}))})).catch(() => null), new Promise(done => setTimeout(() => done('Page diagnostics timed out.'), 3000))]))
  throw error
} finally {
  await page?.close().catch(() => {})
  if (client && client.exitCode === null && client.signalCode === null) { const exited = once(client, 'exit'); client.kill('SIGTERM'); await exited }
  await fixture.cleanup()
  await new Promise(done => provider.close(done))
}
