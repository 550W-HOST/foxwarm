import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const entry = new URL('../src/components/ProjectWorkspace.tsx', import.meta.url).pathname
const chromium = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'

test('project sessions keep independent views mounted and create Agent tabs with an idempotency key', async () => {
  const source = `
    import React, {useEffect} from 'react'; import {createRoot} from 'react-dom/client';
    import ProjectWorkspace from ${JSON.stringify(entry)};
    const nodeTargets = [{id:'remote',type:'cli-node',displayName:'Remote',online:true,services:{'vscode-fs':1,'vscode-pty':1}}];
    const noop = () => {};
    function TerminalProbe({tab, onReady}) {
      useEffect(() => {
        if (!tab.resourceId) {
          localStorage.setItem('test-terminal-creates', String(Number(localStorage.getItem('test-terminal-creates') || 0)+1));
          onReady('terminal-one');
        }
      }, []);
      return React.createElement('div', {'data-terminal':tab.id, 'data-terminal-resource':tab.resourceId || ''}, 'terminal');
    }
    createRoot(document.getElementById('root')).render(React.createElement(ProjectWorkspace, {
      nodeTargets, onOpenSetup:noop,onOpenAgents:noop,onOpenNodes:noop,onOpenHistory:noop,
      unassignedCandidates:[{id:'old-chat',displayName:'Old chat',currentNode:'remote',cwd:'/srv/example'}],
      onOpenUnassigned:id => {window.openedUnassigned = id},
      onCloseTerminal:async () => { window.closedTerminals = (window.closedTerminals||0)+1 },
      renderAgent: (tab, project) => React.createElement('div', {'data-agent':tab.id}, project.nodeId + ':' + project.rootPath, React.createElement('input', {'aria-label':'draft '+tab.id})),
      renderTerminal: (tab, project, active, onReady) => React.createElement(TerminalProbe, {tab, onReady}),
      renderCode: tab => React.createElement('div', {'data-code':tab.id}, 'code')
    }));
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const sessions = [
    { id: 's1', projectId: 'p1', title: 'Task one', createdAt: 1, archived: false, tabs: [
      { id: 'a1', workspaceSessionId: 's1', type: 'agent', title: 'First agent', resourceId: 'conversation-one', state: 'ready', createdAt: 1 },
      { id: 't1', workspaceSessionId: 's1', type: 'terminal', title: 'Terminal', state: 'ready', createdAt: 2 },
      { id: 'c1', workspaceSessionId: 's1', type: 'code', title: 'Code', state: 'ready', createdAt: 3 },
    ] },
    { id: 's2', projectId: 'p1', title: 'Task two', createdAt: 2, archived: false, tabs: [
      { id: 'a2', workspaceSessionId: 's2', type: 'agent', title: 'Second agent', resourceId: 'conversation-two', state: 'ready', createdAt: 4 },
    ] },
  ]
  const projects = [{ id: 'p1', name: 'Example', nodeId: 'remote', rootPath: '/srv/example', createdAt: 1, archived: false, sessions }]
  const calls = []
  const directoryCalls = []
  const projectCalls = []
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.writeHead(200, {'Content-Type':'text/html'}); res.end(`<!doctype html><style>[hidden]{display:none!important}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`); return }
    if (req.url.startsWith('/api/projects?') && req.method === 'GET') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({projects,nextOffset:null})); return }
    if (req.url === '/api/projects/resolve-directory' && req.method === 'POST') {
      let raw=''; for await (const chunk of req) raw+=chunk
      const body=JSON.parse(raw); directoryCalls.push(body)
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({nodeId:body.nodeId,rootPath:'/opt/foxwarm-node/foxwarm-node'})); return
    }
    if (req.url === '/api/projects' && req.method === 'POST') {
      let raw=''; for await (const chunk of req) raw+=chunk
      const body=JSON.parse(raw); projectCalls.push(body)
      const project={id:'p2',name:body.name || 'Default',nodeId:body.nodeId,rootPath:body.rootPath,createdAt:5,archived:false,sessions:[]}; projects.push(project)
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({project})); return
    }
    if (req.url === '/api/projects/p2/sessions' && req.method === 'POST') {
      const session={id:'s3',projectId:'p2',title:'New session',createdAt:6,archived:false,tabs:[]}; projects[1].sessions.push(session)
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({session})); return
    }
    if (req.url === '/api/project-sessions/s1/tabs' && req.method === 'POST') {
      let raw=''; for await (const chunk of req) raw+=chunk
      const body=JSON.parse(raw); calls.push(body)
      const tab={id:body.existingSessionId ? 'old-tab' : 'a3', workspaceSessionId:'s1',type:'agent',title:'New agent',resourceId:body.existingSessionId || 'conversation-three',state:'ready',createdAt:5}
      sessions[0].tabs.push(tab)
      res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({tab})); return
    }
    if (req.url === '/api/project-tabs/t1' && req.method === 'PATCH') { res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'temporary failure'})); return }
    res.writeHead(404, {'Content-Type':'application/json'}); res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await puppeteer.launch({executablePath:chromium,headless:true,args:['--no-sandbox']})
    const page = await browser.newPage()
    await page.setViewport({width:1200,height:800})
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForSelector('button[aria-label="New session in Example"]')
    const clickText = text => page.evaluate(value => { const button=[...document.querySelectorAll('button')].find(item => item.textContent.trim() === value); if (!button) throw new Error('Missing '+value); button.click() }, text)
    await clickText('Example')
    await clickText('Task one')
    await page.waitForSelector('[aria-label="draft a1"]')
    await page.type('[aria-label="draft a1"]', 'draft survives')
    await clickText('Terminal')
    await page.waitForSelector('[data-terminal="t1"]')
    await page.waitForFunction(() => localStorage.getItem('test-terminal-creates') === '1')
    await clickText('Code')
    await page.waitForSelector('[data-code="c1"]')
    await clickText('Task two')
    await page.waitForSelector('[aria-label="draft a2"]')
    assert.equal(await page.$eval('[aria-label="draft a1"]', el => el.value), 'draft survives')
    assert.equal(await page.$eval('[data-terminal="t1"]', el => el.closest('[aria-hidden]').getAttribute('aria-hidden')), 'true')
    assert.equal(await page.$eval('[data-code="c1"]', el => el.closest('[aria-hidden]').getAttribute('aria-hidden')), 'true')
    assert.equal(await page.evaluate(() => window.closedTerminals || 0), 0)
    await clickText('Task one')
    await page.click('[aria-label="New tab"]')
    await clickText('agent')
    await page.waitForSelector('[aria-label="draft a3"]')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].type, 'agent')
    assert.ok(calls[0].requestId)
    assert.equal(await page.$eval('[data-agent="a3"]', el => el.textContent), 'remote:/srv/example')
    await page.reload()
    await page.waitForSelector('[aria-label="draft a3"]')
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_project_active_session_v1')), 's1')
    await clickText('Terminal')
    await page.waitForSelector('[data-terminal-resource="terminal-one"]')
    assert.equal(await page.evaluate(() => localStorage.getItem('test-terminal-creates')), '1', 'failed terminal metadata save must not start another PTY after reload')
    await page.click('[aria-label="Add Old chat to current work session"]')
    await page.waitForSelector('[aria-label="draft old-tab"]')
    assert.equal(calls[1].existingSessionId, 'old-chat')
    assert.equal(await page.$('[aria-label="Add Old chat to current work session"]'), null)
    await clickText('New project')
    await page.select('select', 'remote')
    await clickText('Resolve')
    await page.waitForFunction(() => document.querySelector('input[placeholder="Use node default"]')?.value === '/opt/foxwarm-node/foxwarm-node')
    await clickText('Create project')
    await page.waitForFunction(() => document.querySelector('main header')?.textContent.includes('/opt/foxwarm-node/foxwarm-node'))
    assert.equal(directoryCalls[0].nodeId, 'remote')
    assert.equal(Object.hasOwn(directoryCalls[0], 'rootPath'), false)
    assert.equal(projectCalls[0].rootPath, '/opt/foxwarm-node/foxwarm-node')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})
