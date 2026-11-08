// Owned .NET Main, an independent executable Provider whose service channel only relays to the
// real CLI Node `--stdio`, the original WebUI and the prepared official Code workbench.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const NODE = 'relay/svc'
const workbenchDir = resolve('dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets/vscode-web')
await access(join(workbenchDir, 'out/vs/workbench/workbench.web.main.internal.js'))
const cli = process.env.FOXWARM_CLI_EXECUTABLE || resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode')
await access(cli)
const options = { onPage: page => page.setViewport({ width: 1440, height: 1000 }), env: {} }
const fixture = await createHostFixture('provider-code', options)
options.cwd = fixture.root
const target = join(fixture.root, 'target'), repo = join(target, 'work', 'repository')
await mkdir(repo, { recursive: true })
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
git('init', '-q'); git('config', 'user.name', 'Provider Code Fixture'); git('config', 'user.email', 'fixture@example.invalid')
await mkdir(join(repo, 'src'))
await writeFile(join(repo, 'notes.txt'), 'alpha\nbeta\n')
await writeFile(join(repo, 'src', 'main.txt'), 'main original\n')
git('add', '.'); git('commit', '-qm', 'provider fixture root')
await writeFile(join(repo, 'notes.txt'), 'alpha\nbeta changed in worktree\n')
const provider = {
  type: 'executable',
  command: 'python3',
  args: [resolve('dotnet/Foxwarm.Tests/Tools/Fixtures/node-provider-services.py'), target, 'cli-stdio', cli, process.env.DOTNET_ROOT],
  timeoutSeconds: 10,
}
await writeFile(join(fixture.data, 'state/config.yaml'), JSON.stringify({ url: fixture.origin, bot: { httpPort: fixture.port }, vector: false, llm: { maxOutput: 713 }, nodeProviders: { relay: provider } }))
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'] } } }))

const errors = [], notFound = []
let page
const channelLog = async () => (await readFile(join(target, 'channel.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const codeFrame = () => until(() => page.frames().find(frame => new URL(frame.url() || 'about:blank').pathname.endsWith('/vscode-web/') && frame.parentFrame() === page.mainFrame()), 'embedded official workbench', 40000)
const text = frame => frame.evaluate(() => document.body.innerText)
async function palette(frame, command) {
  await frame.click('.monaco-workbench'); await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('P'); await page.keyboard.up('Shift'); await page.keyboard.up('Control')
  await frame.waitForSelector('.quick-input-widget input'); await frame.type('.quick-input-widget input', command); await page.keyboard.press('Enter')
}
const chord = async (...keys) => { for (const key of keys.slice(0, -1)) await page.keyboard.down(key); await page.keyboard.press(keys.at(-1)); for (const key of keys.slice(0, -1).reverse()) await page.keyboard.up(key) }

try {
  await fixture.start()
  // Directory: the Provider's declaration reaches the web interface as a Node with the fixed services.
  const directory = (await fixture.api('GET', '/api/nodes')).body.nodes
  const entry = directory.find(node => node.id === NODE)
  assert(entry?.online, JSON.stringify(directory))
  assert.deepEqual(entry.services, { 'vscode-fs': 1, 'vscode-git': 2, 'vscode-pty': 1 })
  assert.equal((await channelLog()).filter(row => row.connect).length, 0, 'discovery must not start the service channel')

  page = await fixture.openApp()
  page.on('pageerror', error => errors.push(error.stack))
  page.on('response', response => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname.slice(0, 160)) })
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()) })
  await page.waitForSelector('[data-sidebar-nav="code"]')
  assert.equal((await fixture.api('GET', '/api/terminals')).body.terminals.length, 0)
  assert.equal((await channelLog()).filter(row => row.connect).length, 0, 'the page-load terminal list must not start the channel')

  // Open the Provider Node folder through the original Code launcher.
  await page.click('button[aria-label="Open code options"]')
  const nodeSelect = await page.waitForSelector('select')
  await until(() => nodeSelect.evaluate((select, node) => [...select.options].some(option => option.value === node && !option.disabled), NODE), 'Provider Node offered for Code')
  await nodeSelect.select(NODE)
  await page.evaluate(path => {
    const input = [...document.querySelectorAll('input')].find(item => item.placeholder === '/')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, path); input.dispatchEvent(new Event('input', { bubbles: true }))
  }, repo)
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Open code').click())
  await page.waitForSelector(`iframe[data-code-node="${NODE}"]`)
  const frameUrl = new URL(await page.$eval(`iframe[data-code-node="${NODE}"]`, frame => frame.src))
  assert.equal(frameUrl.searchParams.get('nodeId'), NODE)
  const folder = frameUrl.searchParams.get('initialFolderUri')
  assert.equal(folder, 'foxwarm://node+relay%2Fsvc' + repo.split('/').map(encodeURIComponent).join('/'))
  let code = await codeFrame()
  await code.waitForSelector('.explorer-folders-view .monaco-list-row', { timeout: 60000 })
  await until(async () => (await text(code)).includes('notes.txt') && (await text(code)).includes('src'), 'Provider directory listing in the Explorer', 40000)
  const workspaceFile = join(fixture.data, 'state/vscode-web/node-relay%2Fsvc.code-workspace')
  const workspace = JSON.parse(await readFile(workspaceFile, 'utf8'))
  assert(JSON.stringify(workspace.folders).includes('relay%2Fsvc'), JSON.stringify(workspace))
  assert.equal((await channelLog()).filter(row => row.connect).length, 1)

  // Open, edit and save a file; the bytes land on the target through the CLI.
  const explorerRow = name => code.evaluateHandle(name => [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find(row => row.innerText.trim() === name), name)
  await (await explorerRow('src')).asElement().click()
  await until(async () => (await explorerRow('main.txt')).asElement(), 'src children in the Explorer', 30000)
  await (await explorerRow('main.txt')).asElement().click()
  await code.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.replaceAll('\u00a0', ' ').includes('main original'), { timeout: 30000 })
  await code.click('.editor-instance .view-lines')
  await chord('Control', 'End'); await page.keyboard.type('\nedited in the workbench'); await chord('Control', 'S')
  await until(async () => (await readFile(join(repo, 'src', 'main.txt'), 'utf8')) === 'main original\n\nedited in the workbench', 'saved bytes on the target')

  // Source control shows both changes; the diff has base content from the Provider's Git.
  await chord('Control', 'Shift', 'G')
  await code.waitForSelector('.scm-view', { timeout: 30000 })
  // Git status is read-only and refreshed on demand, so the edit saved above needs an explicit refresh.
  await palette(code, 'Foxwarm SCM: Refresh Git Status')
  const scmRows = () => code.evaluate(() => [...document.querySelectorAll('.scm-view .monaco-list-row')].map(row => row.innerText.trim()))
  await until(async () => { const rows = await scmRows(); return rows.some(row => row.includes('notes.txt')) && rows.some(row => row.includes('main.txt')) }, 'SCM rows for both changed files from the Provider Node', 40000)
  const rowFor = name => code.evaluateHandle(name => [...document.querySelectorAll('.scm-view .monaco-list-row')].find(row => row.innerText.includes(name)), name)
  await (await rowFor('notes.txt')).asElement().click()
  await code.waitForSelector('.monaco-diff-editor', { timeout: 30000 })
  await until(async () => {
    const lines = await code.evaluate(() => [...document.querySelectorAll('.monaco-diff-editor .view-line')].map(line => line.textContent.replaceAll('\u00a0', ' ')))
    // Base content comes from the Provider's Git (`beta`); the working side is the target file.
    return lines.includes('beta') && lines.includes('beta changed in worktree') && lines.includes('alpha') ? lines : null
  }, 'diff base and working content', 30000)

  // A terminal from the workbench on the same Node.
  await palette(code, 'Foxwarm: New Terminal')
  const codeTerminal = await until(async () => (await fixture.api('GET', '/api/terminals')).body.terminals.find(row => row.nodeId === NODE), 'workbench terminal on the Provider Node')
  assert(codeTerminal.id.startsWith('pn.') && !codeTerminal.id.includes('/'), codeTerminal.id)
  assert.equal(codeTerminal.cwd, repo)
  await palette(code, 'Terminal: Focus Terminal'); await code.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
  // The workbench renders the terminal on a canvas, so effects are read from the target.
  const targetFile = name => readFile(join(repo, name), 'utf8').catch(() => '')
  await page.keyboard.type('echo wb-$((6*7)) > wb-out.txt; stty size > wb-size1.txt', { delay: 10 }); await page.keyboard.press('Enter')
  await until(async () => (await targetFile('wb-out.txt')) === 'wb-42\n', 'workbench keyboard reached the Provider PTY', 30000)
  const sizeOf = async name => { const m = /^(\d+) (\d+)\n$/.exec(await targetFile(name)); return m && [Number(m[1]), Number(m[2])] }
  const before = await until(() => sizeOf('wb-size1.txt'), 'first size from the PTY', 30000)
  const record = async () => (await fixture.api('GET', '/api/terminals/' + encodeURIComponent(codeTerminal.id))).body.terminal
  assert.deepEqual(before, [(await record()).rows, (await record()).cols])
  await page.setViewport({ width: 1100, height: 700 })
  await until(async () => (await record()).cols !== before[1], 'workbench resize reached the Provider terminal', 30000)
  const grown = await record()
  await page.keyboard.type('stty size > wb-size2.txt', { delay: 10 }); await page.keyboard.press('Enter')
  const after = await until(() => sizeOf('wb-size2.txt'), 'second size from the PTY', 30000)
  assert.deepEqual(after, [grown.rows, grown.cols]); assert.notDeepEqual(after, before)
  await page.setViewport({ width: 1440, height: 1000 })

  // A terminal tab in the original WebUI on the same Node.
  await page.evaluate(() => { location.hash = '' })
  await page.click('button[aria-label="Custom terminal tab"]')
  const terminalSelect = await page.waitForSelector('select')
  await until(() => terminalSelect.evaluate((select, node) => [...select.options].some(option => option.value === node && !option.disabled), NODE), 'Provider Node offered for Terminal')
  await terminalSelect.select(NODE)
  await page.evaluate(path => {
    const input = [...document.querySelectorAll('input')].find(item => item.placeholder === '/tmp')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, path); input.dispatchEvent(new Event('input', { bubbles: true }))
  }, repo)
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Create tab').click())
  const appTerminal = await until(async () => (await fixture.api('GET', '/api/terminals')).body.terminals.find(row => row.nodeId === NODE && row.id !== codeTerminal.id), 'WebUI terminal on the Provider Node')
  assert.notEqual(appTerminal.id, codeTerminal.id)
  await page.waitForSelector('.xterm-screen, .xterm-rows'); await page.click('.xterm-screen, .xterm-rows')
  await page.keyboard.type("printf 'WEBUI-PTY\\n' > webui-pty.txt; stty size", { delay: 10 }); await page.keyboard.press('Enter')
  await until(async () => (await readFile(join(repo, 'webui-pty.txt'), 'utf8').catch(() => '')) === 'WEBUI-PTY\n', 'WebUI keyboard reached the Provider PTY')
  await page.setViewport({ width: 1200, height: 800 })
  await until(async () => (await fixture.api('GET', '/api/terminals/' + encodeURIComponent(appTerminal.id))).body.terminal.cols !== appTerminal.cols, 'WebUI resize reached the Provider terminal', 30000)

  const listed = (await fixture.api('GET', '/api/terminals')).body.terminals.filter(row => row.nodeId === NODE)
  assert.equal(new Set(listed.map(row => row.id)).size, 2)
  assert.equal((await channelLog()).filter(row => row.connect).length, 1, 'one channel served Code files, Git and both terminals')
  for (const terminal of listed) assert.equal((await fixture.api('DELETE', '/api/terminals/' + encodeURIComponent(terminal.id))).status, 200)
  // Code probes optional files and localization bundles that do not exist; those 404s are expected.
  assert.deepEqual(errors.filter(error => !/favicon|Failed to load resource/.test(error)), [])
  assert(notFound.every(path => /package\.nls\.json$|\/api\/vscode-web\/fs\/(stat|read-file)$/.test(path)), JSON.stringify([...new Set(notFound)]))
  console.log(JSON.stringify({ result: 'passed', node: NODE, folder, explorer: true, savedBytes: true, scmDiff: true, workbenchTerminal: true, webuiTerminal: true, resized: true, channels: 1 }))
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(fixture.root, 'failure.png') }).catch(() => {})
    await writeFile(join(fixture.root, 'browser-state.json'), JSON.stringify(await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.evaluate(() => document.body.innerText).catch(() => '') }))), null, 2)).catch(() => {})
  }
  console.error(JSON.stringify({ errors: errors.slice(0, 5), notFound: [...new Set(notFound)].slice(0, 20) })); console.error(fixture.output); console.error('Failure artifacts: ' + fixture.root)
  process.env.FOXWARM_KEEP_E2E_ROOT = '1'
  throw error
} finally {
  await fixture.cleanup()
}
