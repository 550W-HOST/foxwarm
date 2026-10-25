// Owned real MV3 + C# Main qualification, using the existing disposable host harness.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import yaml from 'js-yaml';
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs';

const fixture = await createHostFixture('browser-node', {
  ...(process.env.FOXWARM_PUBLISHED_CORE
    ? { corePath: join(process.env.FOXWARM_PUBLISHED_CORE, 'Foxwarm.dll') }
    : {}),
});
const scripts = new Map(),
  rounds = new Map(),
  failures = [],
  evidence = {};
const peer = createServer(async (request, response) => {
  if (request.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const prompt = (body.input || [])
        .filter((row) => row.role === 'user')
        .flatMap((row) => row.content || [])
        .map((part) => part.text || '')
        .join('\n');
      const key = [...prompt.matchAll(/BROWSER:([\w-]+)/g)].at(-1)?.[1];
      const round = rounds.get(key) || 0;
      rounds.set(key, round + 1);
      const output =
        round === 0
          ? scripts.get(key)
          : [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'DONE-' + key }],
              },
            ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: { output, usage: { input_tokens: 5, output_tokens: 5 } },
          }) +
          '\n\n',
      );
    } catch (error) {
      failures.push(error.stack);
      response.writeHead(500);
      response.end();
    }
    return;
  }
  response.setHeader('Content-Security-Policy', "script-src 'self'");
  response.setHeader('content-type', 'text/html');
  const color = request.url === '/blue' ? 'blue' : 'red';
  response.end(
    `<html><head><title>Owned ${request.url}</title></head><body style="background:${color};min-height:2000px"><h1>Owned ${request.url}</h1><input id="field"><input id="password" type="password" value="SYNTHETIC-SECRET"><section><button>First</button><button>Second</button></section><select id="choice"><option value="a">A</option><option value="b">B</option></select><textarea id="area"></textarea></body></html>`,
  );
});
peer.listen(0, '127.0.0.1');
await once(peer, 'listening');
const origin = `http://127.0.0.1:${peer.address().port}`;
const base = fixture.origin + '/browser-proof';
await writeFile(
  join(fixture.data, 'state/config.yaml'),
  (await readFile(join(fixture.data, 'state/config.yaml'), 'utf8')) + 'url: ' + base + '\n',
);
await writeFile(
  fixture.modelPath,
  JSON.stringify({
    default: 'local',
    providers: { local: { providerType: 'openai-responses', baseUrl: origin, models: ['wire'] } },
  }),
);
let browser,
  popup,
  worker,
  sessionId,
  count = 0;
const call = (id, name, args) => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(args),
});
const saved = async (id = sessionId) =>
  JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8'));
const pair = (state, id) =>
  state.history
    .flatMap((row) => row.parts || [])
    .find((part) => part.functionResponse?.tool_use_id === id)?.functionResponse?.response;
async function begin(key, calls, id = sessionId) {
  scripts.set(key, calls);
  rounds.set(key, 0);
  assert.equal(
    (
      await fixture.api('POST', '/api/sessions/' + encodeURIComponent(id) + '/message', {
        text: 'BROWSER:' + key,
      })
    ).status,
    202,
  );
}
async function finish(key) {
  return until(
    async () => {
      if (failures.length) throw new Error(failures.join('\n'));
      const state = await saved();
      return state.history.some((row) => row.parts?.some((part) => part.text === 'DONE-' + key))
        ? state
        : null;
    },
    'model turn ' + key,
    70000,
  );
}
async function turn(key, calls) {
  await begin(key, calls);
  return finish(key);
}
async function invoke(tool, args = {}) {
  const key = 'call-' + ++count;
  return pair(
    await turn(key, [call(key, 'call_tool', { toolId: 'node:owned-browser/' + tool, args })]),
    key,
  );
}
const msg = (message) => popup.evaluate((message) => chrome.runtime.sendMessage(message), message);
const pending = async () => (await msg({ type: 'get_pending_confirmations' })).confirmations;
async function ask(tool, args) {
  const key = 'ask-' + ++count;
  await begin(key, [call(key, 'call_tool', { toolId: 'node:owned-browser/' + tool, args })]);
  const entry = await until(async () => (await pending())[0], 'actual Ask');
  return { key, entry };
}
async function connect(token) {
  const result = await msg({
    type: 'connect',
    host: base,
    pairingToken: token,
    nodeName: 'owned-browser',
  });
  assert(!result.error, JSON.stringify(result));
  await until(
    async () => (await msg({ type: 'get_state' })).state === 'registered',
    'registered',
    15000,
  );
}
try {
  await fixture.start();
  const setup = await fixture.api('POST', '/api/nodes/onboarding/browser', {
    fallbackUrl: fixture.origin,
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.baseUrl, base);
  assert.equal(
    (await fetch(base + '/api/nodes/onboarding/browser', { method: 'POST', body: '{}' })).status,
    401,
  );
  const archive = await fetch(base + '/node/browser-extension.zip');
  assert.equal(archive.status, 200);
  const zipPath = join(fixture.root, 'extension.zip'),
    extension = join(fixture.root, 'extension');
  const zip = Buffer.from(await archive.arrayBuffer());
  await writeFile(zipPath, zip);
  await mkdir(extension);
  execFileSync('python3', [
    '-c',
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert "manifest.json" in z.namelist(); assert not any("test/" in n for n in z.namelist()); z.extractall(sys.argv[2])',
    zipPath,
    extension,
  ]);
  assert(!zip.includes(Buffer.from(setup.body.pairingToken)));
  browser = await puppeteer.launch({
    executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium',
    headless: !process.env.DISPLAY,
    ignoreDefaultArgs: ['--disable-infobars', '--enable-automation'],
    userDataDir: join(fixture.root, 'profile'),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,900',
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension,
    ],
  });
  evidence.browser = await browser.version();
  const target = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().endsWith('/background/main.js'),
  );
  worker = await target.worker();
  popup = await browser.newPage();
  await popup.goto('chrome-extension://' + new URL(target.url()).host + '/popup/popup.html');
  const response = await msg({
    type: 'connect',
    host: base,
    pairingToken: setup.body.pairingToken,
    nodeName: 'owned-browser',
  });
  assert(!response.error);
  const approval = await until(
    async () =>
      (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(
        (entry) => entry.requestedName === 'owned-browser',
      ),
    'pair request',
  );
  await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: approval.id });
  await until(
    async () => (await msg({ type: 'get_state' })).state === 'registered',
    'initial register',
  );
  const created = await fixture.api('POST', '/api/sessions', {
    agentId: 'main',
    sessionId: 'browser',
  });
  sessionId = created.body.sessionId;
  const red = await browser.newPage();
  await red.goto(origin + '/red');
  const blue = await browser.newPage();
  await blue.goto(origin + '/blue');
  const local = await popup.evaluate(() => chrome.tabs.query({}));
  const redTab = local.find((tab) => tab.url.endsWith('/red')),
    blueTab = local.find((tab) => tab.url.endsWith('/blue'));
  assert.deepEqual((await invoke('list_tabs')).tabs, []);
  await msg({ type: 'set_tab_permission', tabId: redTab.id, level: 'auto' });
  // Exact explicit routing leaves Session's current execution Node unchanged.
  const dev = await fixture.api('POST', '/api/nodes/onboarding/create', {
    fallbackUrl: fixture.origin,
    nodeId: 'development-peer',
  });
  const { default: WebSocket } = await import('ws');
  const socket = new WebSocket(
    base.replace(/^http/, 'ws') + '/node_ws?id=development-peer&auth=' + dev.body.authToken,
  );
  await once(socket, 'open');
  socket.send(
    JSON.stringify({
      type: 'node_register',
      nodeType: 'test-peer',
      capabilities: { tools: [{ name: 'probe', parameters: { type: 'object', properties: {} } }] },
      nodeProtocol: { min: 1, max: 3 },
    }),
  );
  await until(
    async () =>
      (await fixture.api('GET', '/api/nodes')).body.nodes.some(
        (node) => node.id === 'development-peer' && node.executable,
      ),
    'development peer',
  );
  await turn('select-development', [
    call('select', 'node', { action: 'select', nodeId: 'development-peer' }),
  ]);
  const discovered = pair(
    await turn('discover-browser', [
      call('discover', 'search_tools', { sources: ['node'], nodeId: 'owned-browser', limit: 20 }),
    ]),
    'discover',
  );
  assert(JSON.stringify(discovered).includes('node:owned-browser/fill'));
  let snapshot = await invoke('get_tab_content', { tabId: redTab.id });
  assert(snapshot.elements, JSON.stringify(snapshot));
  assert(!JSON.stringify(snapshot).includes('SYNTHETIC-SECRET'));
  for (const format of ['text', 'html'])
    assert(
      !JSON.stringify(await invoke('get_tab_content', { tabId: redTab.id, format })).includes(
        'SYNTHETIC-SECRET',
      ),
    );
  assert.equal((await saved()).currentNode, 'development-peer');
  const buttons = snapshot.elements.filter((el) => el.tag === 'button');
  assert.notEqual(buttons[0].ref, buttons[1].ref);
  await red.evaluate(() => {
    document.querySelectorAll('button').forEach((button, i) =>
      button.addEventListener('click', (event) => {
        document.body.dataset.clicked = `${i}:${event.isTrusted}`;
      }),
    );
  });
  assert((await invoke('click', { tabId: redTab.id, ref: buttons[1].ref })).clicked);
  assert.equal(await red.evaluate(() => document.body.dataset.clicked), '1:true');
  assert((await invoke('click', { tabId: redTab.id, selector: 'button' })).error);
  assert((await invoke('fill', { tabId: redTab.id, selector: '#field', text: 'agent Ω' })).filled);
  assert.equal(await red.$eval('#field', (el) => el.value), 'agent Ω');
  assert(
    (await invoke('select_option', { tabId: redTab.id, selector: '#choice', values: ['b'] }))
      .selected,
  );
  assert.equal(await red.$eval('#choice', (el) => el.value), 'b');
  assert.equal(
    (await invoke('execute_js', { tabId: redTab.id, code: 'Promise.resolve(42)' })).result,
    42,
  );
  const boundedJs = await invoke('execute_js', { tabId: redTab.id, code: '"x".repeat(120000)' });
  assert.equal(boundedJs.outputTruncated, true);
  const boundedValue = yaml.load(await readFile(boundedJs.outputFullPath, 'utf8'));
  assert.equal(boundedValue.result.length, 100000);
  assert.equal(boundedValue.truncated, true);
  assert(
    (await invoke('press_key', { tabId: redTab.id, selector: '#field', key: 'Backspace' })).pressed,
  );
  assert(
    (await invoke('wait_for', { tabId: redTab.id, condition: 'text', text: 'Owned /red' })).matched,
  );
  assert(
    (
      await invoke('wait_for', {
        tabId: redTab.id,
        condition: 'element',
        selector: '#missing',
        state: 'visible',
        timeoutMs: 100,
      })
    ).reason === 'timeout',
  );
  await popup.evaluate((id) => chrome.tabs.update(id, { active: true }), blueTab.id);
  const shotKey = 'image';
  const state = await turn(shotKey, [
    call(shotKey, 'call_tool', {
      toolId: 'node:owned-browser/screenshot',
      args: { tabId: redTab.id },
    }),
  ]);
  assert(!pair(state, shotKey).error, JSON.stringify(pair(state, shotKey)));
  const row = state.history.find((row) =>
    row.parts?.some((part) => part.functionResponse?.tool_use_id === shotKey),
  );
  const image = row.parts.find((part) => part.inlineDataRef)?.inlineDataRef;
  assert(image?.blobId);
  const imageResponse = await fetch(base + '/api/blobs/' + image.blobId, {
    headers: { authorization: 'Bearer ' + fixture.token },
  });
  assert.equal(imageResponse.status, 200);
  const pixels = await sharp(Buffer.from(await imageResponse.arrayBuffer()))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset =
    (Math.floor(pixels.info.height * 0.8) * pixels.info.width +
      Math.floor(pixels.info.width * 0.9)) *
    pixels.info.channels;
  assert.deepEqual([...pixels.data.subarray(offset, offset + 3)], [255, 0, 0]);
  assert((await popup.evaluate((id) => chrome.tabs.get(id), blueTab.id)).active);
  const shot = pair(state, shotKey);
  assert((await invoke('click', { tabId: redTab.id, x: 1, y: 1, pageId: shot.pageId })).clicked);
  // A fresh snapshot invalidates previous snapshot references, without selector reconstruction.
  await invoke('get_tab_content', { tabId: redTab.id });
  assert((await invoke('click', { tabId: redTab.id, ref: buttons[0].ref })).error);
  await red.reload();
  assert((await invoke('click', { tabId: redTab.id, x: 1, y: 1, pageId: shot.pageId })).error);
  await msg({ type: 'set_window_permission', windowId: redTab.windowId, level: 'auto' });
  await msg({ type: 'remove_tab_permission', tabId: redTab.id });
  const opened = await invoke('open_tab', { windowId: redTab.windowId, url: origin + '/new' });
  assert(opened.tabId);
  assert((await popup.evaluate((id) => chrome.tabs.get(id), blueTab.id)).active);
  assert((await invoke('list_tabs')).tabs.some((tab) => tab.tabId === opened.tabId));
  await msg({ type: 'set_tab_permission', tabId: opened.tabId, level: 'off' });
  assert(!(await invoke('list_tabs')).tabs.some((tab) => tab.tabId === opened.tabId));
  await msg({ type: 'remove_tab_permission', tabId: opened.tabId });
  const otherWindow = await popup.evaluate(() =>
    chrome.windows.create({ url: 'about:blank', focused: false }),
  );
  await popup.evaluate(({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), {
    id: opened.tabId,
    windowId: otherWindow.id,
  });
  assert.equal((await msg({ type: 'resolve_permission', tabId: opened.tabId })).level, 'off');
  await popup.evaluate(({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), {
    id: opened.tabId,
    windowId: redTab.windowId,
  });
  assert.equal((await msg({ type: 'resolve_permission', tabId: opened.tabId })).level, 'auto');
  await msg({ type: 'set_tab_permission', tabId: redTab.id, level: 'ask' });
  let request = await ask('fill', {
    tabId: redTab.id,
    selector: '#password',
    text: 'SECOND-SECRET',
  });
  assert.equal(request.entry.agentName, 'main');
  assert.equal(request.entry.sessionId, sessionId);
  assert.equal(request.entry.url, red.url());
  assert(!JSON.stringify(request.entry).includes('SECOND-SECRET'));
  await msg({ type: 'confirmation_response', requestId: request.entry.requestId, approved: true });
  assert(pair(await finish(request.key), request.key).filled);
  assert(!JSON.stringify(pair(await saved(), request.key)).includes('SECOND-SECRET'));
  request = await ask('get_tab_content', { tabId: redTab.id, format: 'text' });
  await red.goto(origin.replace('127.0.0.1', 'localhost') + '/private');
  await msg({ type: 'set_domain_permission', domain: 'localhost', level: 'off' });
  assert.equal(
    (
      await msg({
        type: 'confirmation_response',
        requestId: request.entry.requestId,
        approved: true,
      })
    ).approved,
    false,
  );
  assert(pair(await finish(request.key), request.key).error);
  await red.goto(origin + '/red');
  await msg({ type: 'set_tab_permission', tabId: redTab.id, level: 'ask' });
  request = await ask('click', { tabId: redTab.id, selector: 'button:nth-child(2)' });
  await msg({ type: 'set_tab_permission', tabId: redTab.id, level: 'off' });
  assert.equal(
    (
      await msg({
        type: 'confirmation_response',
        requestId: request.entry.requestId,
        approved: true,
      })
    ).approved,
    false,
  );
  assert(pair(await finish(request.key), request.key).error);
  await msg({ type: 'set_tab_permission', tabId: redTab.id, level: 'ask' });
  request = await ask('get_tab_content', { tabId: redTab.id });
  await popup.evaluate(({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), {
    id: redTab.id,
    windowId: otherWindow.id,
  });
  assert.equal(
    (
      await msg({
        type: 'confirmation_response',
        requestId: request.entry.requestId,
        approved: true,
      })
    ).approved,
    false,
  );
  assert(pair(await finish(request.key), request.key).error);
  // Stop a second Session's queued operation while the first Session owns a pending Ask.
  const held = await ask('get_tab_content', { tabId: redTab.id });
  const queuedSession = (
    await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'browser-queued' })
  ).body.sessionId;
  const valueBeforeQueue = await red.$eval('#field', (el) => el.value);
  await begin(
    'queued-call',
    [
      call('queued-call', 'call_tool', {
        toolId: 'node:owned-browser/fill',
        args: { tabId: redTab.id, selector: '#field', text: 'MUST-NOT-RUN' },
      }),
    ],
    queuedSession,
  );
  await until(
    async () =>
      (await saved(queuedSession)).history.some((row) =>
        row.parts?.some((part) => part.functionCall),
      ),
    'queued Session emitted its call',
  );
  await sleep(100);
  await fixture.api('POST', '/api/sessions/' + encodeURIComponent(queuedSession) + '/stop', {});
  await until(
    async () =>
      !(await fixture.api('GET', '/api/sessions/' + encodeURIComponent(queuedSession) + '/history'))
        .body.session.busy,
    'queued Stop drains before held Ask',
  );
  assert.equal((await pending()).length, 1);
  await msg({ type: 'confirmation_response', requestId: held.entry.requestId, approved: true });
  await finish(held.key);
  assert.equal(await red.$eval('#field', (el) => el.value), valueBeforeQueue);
  assert.equal((await pending()).length, 0);
  request = await ask('get_tab_content', { tabId: redTab.id });
  assert.equal(
    (await fixture.api('POST', '/api/sessions/' + encodeURIComponent(sessionId) + '/stop', {}))
      .status,
    200,
  );
  await until(async () => !(await pending()).length, 'Main Stop removes real extension Ask');
  assert.equal(
    (
      await msg({
        type: 'confirmation_response',
        requestId: request.entry.requestId,
        approved: true,
      })
    ).approved,
    false,
  );
  await until(
    async () =>
      !(await fixture.api('GET', '/api/sessions/' + encodeURIComponent(sessionId) + '/history'))
        .body.session.busy,
    'Main Stop drain',
  );
  // Ordinary Node authorization is applied even when the explicit Browser target is not selected.
  await writeFile(
    join(fixture.work, 'deny-browser.yaml'),
    'version: 1\nrules:\n  - id: deny-browser\n    action: deny\n    match:\n      tool: {source: node, name: list_tabs}\n      targetNode: owned-browser\n',
  );
  await turn('policy', [
    call('policy', 'set_config', { target: 'tool-rules', filePath: 'deny-browser.yaml' }),
  ]);
  assert.equal((await invoke('list_tabs')).error.type, 'tool_authorization_denied');
  await writeFile(join(fixture.work, 'allow-browser.yaml'), 'version: 1\n');
  await turn('restore', [
    call('restore', 'set_config', { target: 'tool-rules', filePath: 'allow-browser.yaml' }),
  ]);
  await msg({ type: 'set_tab_permission', tabId: redTab.id, level: 'auto' });
  const navigated = await invoke('navigate', { tabId: redTab.id, url: origin + '/navigated' });
  assert(navigated.pageId, JSON.stringify(navigated));
  assert((await invoke('scroll', { tabId: redTab.id, deltaY: 50 })).scrolled);
  if (process.env.DISPLAY) {
    // OS keyboard input stays in the person's foreground tab during background fill.
    await blue.bringToFront();
    await blue.focus('#field');
    await invoke('fill', { tabId: redTab.id, selector: '#field', text: 'background-agent' });
    execFileSync('python3', ['packages/browser-node/test/x11.py', 'key', 'a']);
    await until(
      async () => (await blue.$eval('#field', (el) => el.value)) === 'a',
      'foreground OS key',
    );
    assert.equal(await red.$eval('#field', (el) => el.value), 'background-agent');
    await red.bringToFront();
    await invoke('get_tab_content', { tabId: redTab.id });
    await sleep(250);
    if (process.env.FOXWARM_BROWSER_SCREENSHOT) {
      const rgb = execFileSync('python3', ['packages/browser-node/test/x11.py', 'screen'], {
        maxBuffer: 8 * 1024 * 1024,
      });
      await sharp(rgb, { raw: { width: 1280, height: 900, channels: 3 } })
        .png()
        .toFile(process.env.FOXWARM_BROWSER_SCREENSHOT);
    }
    // Click the actual Chrome 145 debugging banner Cancel, not an injected detach event.
    execFileSync('python3', ['packages/browser-node/test/x11.py', 'click', '474', '114']);
    await until(
      async () => (await msg({ type: 'get_state' })).state === 'disconnected',
      'browser banner Cancel stops extension',
    );
    await sleep(32000);
    assert.equal((await msg({ type: 'get_state' })).state, 'disconnected');
    await connect('');
    evidence.headed =
      'Foreground OS typing and actual debugger-banner Cancel passed; stayed stopped past alarm.';
  }
  await sleep(53000);
  assert.equal((await msg({ type: 'get_state' })).state, 'registered');
  await msg({ type: 'disconnect' });
  await sleep(32000);
  assert.equal((await msg({ type: 'get_state' })).state, 'disconnected');
  await connect('');
  const oldCredential = await worker.evaluate(
    async () => (await chrome.storage.local.get('connection')).connection.authToken,
  );
  const { WebSocketServer } = await import('ws');
  const otherMain = new WebSocketServer({ noServer: true });
  let observedTarget;
  peer.on('upgrade', (request, socket, head) =>
    otherMain.handleUpgrade(request, socket, head, (connection) => {
      observedTarget = request.url;
      connection.on('message', (data) => {
        if (JSON.parse(data).type === 'pair_request')
          connection.send(
            JSON.stringify({ type: 'pair_pending', pendingId: 'other-main-pending' }),
          );
      });
    }),
  );
  await msg({
    type: 'connect',
    host: origin + '/other-main',
    pairingToken: 'synthetic-other-bootstrap',
    nodeName: 'browser',
  });
  await until(() => observedTarget, 'new Main endpoint');
  assert(observedTarget.startsWith('/other-main/node_ws?token='));
  assert(!observedTarget.includes(oldCredential));
  assert(
    !(await worker.evaluate(() => chrome.storage.local.get('connection'))).connection.authToken,
  );
  await msg({ type: 'reset' });
  await sleep(32000);
  assert.equal((await msg({ type: 'get_state' })).state, 'disconnected');
  assert(
    !(await worker.evaluate(() => chrome.storage.local.get('connection'))).connection.authToken,
  );
  for (const client of otherMain.clients) client.terminate();
  otherMain.close();
  socket.close();
  evidence.result = 'passed';
  evidence.coverage = [
    'published-runtime ZIP installed',
    'non-root base',
    'default Off',
    'real Main discovery, explicit routing and authorization',
    'DOM refs, unique selectors, forms, CSP and Promise',
    'inactive target image history and coordinates',
    'window membership, new and moved tabs, explicit Off and inheritance',
    'stale Ask navigation, revocation and move',
    'password omission and masked Ask/results',
    'Main Stop pending Ask and queued-call cancellation',
    'actual host switch clears old credentials',
    'heartbeat, Stop and Forget past alarms',
  ];
  console.log(JSON.stringify(evidence));
  if (process.env.FOXWARM_BROWSER_EVIDENCE)
    await writeFile(process.env.FOXWARM_BROWSER_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
} catch (error) {
  console.error(fixture.output);
  throw error;
} finally {
  if (browser) await browser.close();
  await fixture.cleanup();
  await new Promise((done) => peer.close(done));
}
