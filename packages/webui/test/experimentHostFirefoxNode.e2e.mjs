// Explicit qualification: Firefox 153+, supplied geckodriver and an owned C# Main.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import yaml from 'js-yaml';
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs';
import { launchFirefox } from './firefoxWebDriver.mjs';
const fixture = await createHostFixture('firefox-node', {
  ...(process.env.FOXWARM_PUBLISHED_CORE ? { corePath: join(process.env.FOXWARM_PUBLISHED_CORE, 'Foxwarm.dll') } : {}),
});
const scripts = new Map(), rounds = new Map(), evidence = {}, failures = [];
const peer = createServer(async (request, response) => {
  if (request.method === 'POST') {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n');
      const key = [...prompt.matchAll(/FIREFOX:([\w-]+)/g)].at(-1)?.[1];
      const round = rounds.get(key) || 0; rounds.set(key, round + 1);
      const output = round === 0 ? scripts.get(key) : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 5, output_tokens: 5 } } }) + '\n\n');
    } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(); }
    return;
  }
  response.setHeader('Content-Security-Policy', "script-src 'self'");
  if (request.url === '/page.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end(`window.pageOwned=41; document.addEventListener('click',e=>window.lastCoordinates=e.clientX+':'+e.clientY+':'+e.isTrusted); document.querySelectorAll('button').forEach((el,i)=>el.onclick=e=>document.body.dataset.clicked=i+':'+e.isTrusted); document.querySelector('#field').oninput=e=>document.body.dataset.input=String(e.isTrusted);`);
    return;
  }
  response.setHeader('content-type', 'text/html');
  response.end(`<html><title>Owned ${request.url}</title><body style="background:${request.url === '/blue' ? 'blue' : 'red'};min-height:2000px"><h1>Owned ${request.url}</h1><input id="field"><input id="search" type="search"><input id="email" type="email"><input id="url" type="url"><input id="tel" type="tel"><input id="number" type="number"><input id="date" type="date" value="2026-01-01"><input id="password" type="password" value="SYNTHETIC-SECRET"><textarea id="area"></textarea><div id="edit" contenteditable>old</div><section><button>First</button><button>Second</button></section><select id="choice"><option value="a">A</option><option value="b">B</option></select><a id="link" href="/linked">Next</a><a id="off-link" href="${origin.replace('127.0.0.1', 'localhost')}/off">Leave</a><script src="/page.js"></script></body></html>`);
});
peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
const origin = `http://127.0.0.1:${peer.address().port}`, base = fixture.origin + '/firefox-proof';
await writeFile(join(fixture.data, 'state/config.yaml'), (await readFile(join(fixture.data, 'state/config.yaml'), 'utf8')) + 'url: ' + base + '\n');
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: origin, models: ['wire'] } } }));
let browser, sessionId, count = 0, stage = 'Main startup';
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const saved = async (id = sessionId) => JSON.parse(await readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8'));
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response;
async function begin(key, calls, id = sessionId) {
  scripts.set(key, calls); rounds.set(key, 0);
  assert.equal((await fixture.api('POST', '/api/sessions/' + encodeURIComponent(id) + '/message', { text: 'FIREFOX:' + key })).status, 202);
}
async function finish(key, id = sessionId) {
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'));
    const state = await saved(id);
    return state.history.some(row => row.parts?.some(part => part.text === 'DONE-' + key)) ? state : null;
  }, 'model turn ' + key, 70000);
}
async function turn(key, calls) { await begin(key, calls); return finish(key); }
async function invoke(tool, args = {}) {
  const key = 'call-' + ++count;
  return pair(await turn(key, [call(key, 'call_tool', { toolId: 'node:owned-firefox/' + tool, args })]), key);
}
const msg = message => browser.evaluate(message => chrome.runtime.sendMessage(message), message);
const pending = async () => (await msg({ type: 'get_pending_confirmations' })).confirmations;
const tab = id => browser.evaluate(id => chrome.tabs.get(id), id);
const load = async (id, url) => {
  await browser.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id, url });
  await until(async () => (await tab(id)).status === 'complete', 'page loaded');
};
async function value(id, selector) {
  return browser.evaluate(async ({ id, selector }) => (await chrome.scripting.executeScript({
    target: { tabId: id }, func: selector => { const el = document.querySelector(selector); return el.value ?? el.textContent; }, args: [selector],
  }))[0].result, { id, selector });
}
async function ask(tool, args) {
  const key = 'ask-' + ++count;
  await begin(key, [call(key, 'call_tool', { toolId: 'node:owned-firefox/' + tool, args })]);
  return { key, entry: await until(async () => (await pending())[0], 'actual Ask') };
}
try {
  await fixture.start();
  stage = 'served packages';
  const setup = await fixture.api('POST', '/api/nodes/onboarding/browser', { fallbackUrl: fixture.origin });
  assert.equal(setup.status, 200); assert.equal(setup.body.baseUrl, base);
  assert.equal((await fetch(base + '/api/nodes/onboarding/browser', { method: 'POST', body: '{}' })).status, 401);
  const archive = await fetch(base + '/node/browser-extension-firefox.zip'); assert.equal(archive.status, 200);
  const zip = Buffer.from(await archive.arrayBuffer()), zipPath = join(fixture.root, 'firefox.zip'), extension = join(fixture.root, 'extension');
  await writeFile(zipPath, zip); await mkdir(extension);
  execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert "manifest.json" in z.namelist(); assert "background/cdp.js" not in z.namelist(); assert not any("test/" in n for n in z.namelist()); z.extractall(sys.argv[2])', zipPath, extension]);
  assert(!zip.includes(Buffer.from(setup.body.pairingToken)));
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '153.0');
  assert(!manifest.permissions.includes('debugger')); assert(!manifest.background.service_worker);
  const chromeArchive = await fetch(base + '/node/browser-extension.zip'); assert.equal(chromeArchive.status, 200);
  const chromeZip = join(fixture.root, 'chrome.zip'); await writeFile(chromeZip, Buffer.from(await chromeArchive.arrayBuffer()));
  execFileSync('python3', ['-c', 'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read("manifest.json")); assert m["background"]["service_worker"]; assert "debugger" in m["permissions"]; assert "background/firefox.js" not in z.namelist(); assert "manifest.firefox.json" not in z.namelist()', chromeZip]);
  stage = 'Firefox install';
  browser = await launchFirefox(extension, join(fixture.root, 'geckodriver.log'));
  evidence.firefox = browser.version;
  assert(Number(browser.version.split('.')[0]) >= 153, 'Full Firefox path requires 153+');
  stage = 'pairing and approval';
  assert(!(await msg({ type: 'connect', host: base, pairingToken: setup.body.pairingToken, nodeName: 'owned-firefox' })).error);
  const approval = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(entry => entry.requestedName === 'owned-firefox'), 'pair request');
  await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: approval.id });
  await until(async () => (await msg({ type: 'get_state' })).state === 'registered', 'Firefox registered');
  sessionId = (await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'firefox' })).body.sessionId;
  const red = await browser.evaluate(url => chrome.tabs.create({ url, active: false }), origin + '/red');
  const blue = await browser.evaluate(url => chrome.tabs.create({ url, active: true }), origin + '/blue');
  await until(async () => (await tab(red.id)).status === 'complete' && (await tab(blue.id)).status === 'complete', 'fixture tabs');
  stage = 'discovery, sharing and DOM';
  assert.deepEqual((await invoke('list_tabs')).tabs, []);
  const discovered = pair(await turn('discover', [call('discover', 'search_tools', { sources: ['node'], nodeId: 'owned-firefox', limit: 30 })]), 'discover');
  assert(JSON.stringify(discovered).includes('node:owned-firefox/fill'));
  assert(!JSON.stringify(discovered).includes('node:owned-firefox/press_key'));
  assert((await invoke('press_key', { tabId: red.id, key: 'Enter' })).error);
  await msg({ type: 'set_tab_permission', tabId: red.id, level: 'auto' });
  let snapshot = await invoke('get_tab_content', { tabId: red.id }); assert(snapshot.elements, JSON.stringify(snapshot));
  for (const format of ['snapshot', 'text', 'html']) assert(!JSON.stringify(await invoke('get_tab_content', { tabId: red.id, format })).includes('SYNTHETIC-SECRET'));
  snapshot = await invoke('get_tab_content', { tabId: red.id });
  const buttons = snapshot.elements.filter(el => el.tag === 'button');
  assert((await invoke('click', { tabId: red.id, ref: buttons[1].ref })).clicked);
  assert.equal(await browser.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.body.dataset.clicked }))[0].result, red.id), '1:false');
  assert((await invoke('click', { tabId: red.id, selector: 'button' })).error);
  for (const [selector, text] of [['#field', 'agent Ω'], ['#search', 'query'], ['#email', 'new@example.org'], ['#url', 'https://example.org/'], ['#tel', '+123456'], ['#number', '456'], ['#area', 'multiline'], ['#edit', 'editable']]) {
    assert((await invoke('fill', { tabId: red.id, selector, text })).filled, selector);
    assert.equal(await value(red.id, selector), text);
  }
  assert.equal(await browser.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.body.dataset.input }))[0].result, red.id), 'false');
  assert((await invoke('fill', { tabId: red.id, selector: '#date', text: '2026-05-06' })).error);
  assert.equal(await value(red.id, '#date'), '2026-01-01');
  assert((await invoke('select_option', { tabId: red.id, selector: '#choice', values: ['b'] })).selected);
  assert.equal(await value(red.id, '#choice'), 'b');
  assert((await tab(blue.id)).active, 'DOM operations must not activate red');
  stage = 'optional JS denied, granted, CSP and revoked';
  assert((await invoke('execute_js', { tabId: red.id, code: 'window.pageOwned=0' })).error);
  await browser.click('#allow-javascript'); await browser.grantUserScripts(false);
  assert.equal(await browser.evaluate(() => chrome.permissions.contains({ permissions: ['userScripts'] })), false);
  assert((await invoke('execute_js', { tabId: red.id, code: 'window.pageOwned=0' })).error);
  await browser.click('#allow-javascript'); await browser.grantUserScripts();
  await until(() => browser.evaluate(() => chrome.permissions.contains({ permissions: ['userScripts'] })), 'normal optional JS grant');
  assert.equal((await invoke('execute_js', { tabId: red.id, code: 'new Promise(resolve => setTimeout(() => resolve(window.pageOwned + 1), 40))' })).result, 42);
  assert.equal((await invoke('execute_js', { tabId: red.id, code: 'typeof browser' })).result, 'undefined');
  assert.equal((await invoke('execute_js', { tabId: red.id, code: 'var ownedStatement = 7; ownedStatement + window.pageOwned' })).result, 48);
  // eval stays forbidden by the site; direct user-script source is the supported API.
  assert((await invoke('execute_js', { tabId: red.id, code: 'eval("1+1")' })).error);
  const bounded = await invoke('execute_js', { tabId: red.id, code: '"x".repeat(120000)' });
  assert(bounded.outputTruncated);
  const boundedResult = yaml.load(await readFile(bounded.outputFullPath, 'utf8'));
  assert.equal(boundedResult.result.length, 100000); assert(boundedResult.truncated);
  await browser.click('#remove-javascript');
  assert((await invoke('execute_js', { tabId: red.id, code: 'window.pageOwned=0' })).error);
  assert((await invoke('fill', { tabId: red.id, selector: '#field', text: 'after-revoke' })).filled);
  await browser.click('#allow-javascript'); await browser.grantUserScripts();
  assert.equal((await invoke('execute_js', { tabId: red.id, code: 'window.pageOwned' })).result, 41);
  stage = 'background screenshot and image history';
  await browser.evaluate(id => chrome.tabs.update(id, { active: true }), blue.id);
  const key = 'image'; const imageState = await turn(key, [call(key, 'call_tool', { toolId: 'node:owned-firefox/screenshot', args: { tabId: red.id } })]);
  const shot = pair(imageState, key); assert(!shot.error, JSON.stringify(shot));
  const image = imageState.history.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === key)).parts.find(part => part.inlineDataRef)?.inlineDataRef;
  assert(image?.blobId);
  const imageResponse = await fetch(base + '/api/blobs/' + image.blobId, { headers: { authorization: 'Bearer ' + fixture.token } });
  assert.equal(imageResponse.status, 200);
  const pixels = await sharp(Buffer.from(await imageResponse.arrayBuffer())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(pixels.info.height * 0.8) * pixels.info.width + Math.floor(pixels.info.width * 0.9)) * pixels.info.channels;
  assert.deepEqual([...pixels.data.subarray(offset, offset + 3)], [255, 0, 0]);
  assert((await tab(blue.id)).active);
  assert((await invoke('click', { tabId: red.id, x: 1, y: 1, pageId: shot.pageId })).clicked);
  assert.equal((await invoke('execute_js', { tabId: red.id, code: 'window.lastCoordinates' })).result, '1:1:false');
  await invoke('get_tab_content', { tabId: red.id });
  assert((await invoke('click', { tabId: red.id, ref: buttons[0].ref })).error);
  await load(red.id, origin + '/red');
  assert((await invoke('click', { tabId: red.id, x: 1, y: 1, pageId: shot.pageId })).error);
  assert((await invoke('click', { tabId: red.id, selector: '#link' })).clicked);
  await until(async () => (await tab(red.id)).url.endsWith('/linked') && (await tab(red.id)).status === 'complete', 'DOM link commit');
  snapshot = await invoke('get_tab_content', { tabId: red.id });
  const linkRef = snapshot.elements.find(el => el.tag === 'a' && el.label === 'Next').ref;
  assert((await invoke('click', { tabId: red.id, ref: linkRef })).clicked);
  await until(async () => (await tab(red.id)).status === 'complete', 'ref link commit');
  assert((await invoke('click', { tabId: red.id, ref: linkRef })).error);
  const leaving = await invoke('click', { tabId: red.id, selector: '#off-link' });
  assert(leaving.clicked, JSON.stringify(leaving)); assert(!leaving.url && !leaving.pageId);
  await until(async () => (await tab(red.id)).url.endsWith('/off'), 'origin changed');
  assert.equal((await msg({ type: 'resolve_permission', tabId: red.id })).level, 'off');
  assert((await invoke('get_tab_content', { tabId: red.id })).error);
  await load(red.id, origin + '/red');
  const offNavigation = await invoke('navigate', { tabId: red.id, url: origin.replace('127.0.0.1', 'localhost') + '/private' });
  assert.equal(offNavigation.sharing, 'off'); assert(!offNavigation.url && !offNavigation.pageId);
  await load(red.id, origin + '/red');
  stage = 'window membership, Off and Ask';
  await msg({ type: 'set_window_permission', windowId: red.windowId, level: 'auto' });
  await msg({ type: 'remove_tab_permission', tabId: red.id });
  const opened = await invoke('open_tab', { windowId: red.windowId, url: origin + '/new' }); assert(opened.tabId);
  assert((await tab(blue.id)).active);
  assert((await invoke('list_tabs')).tabs.some(tab => tab.tabId === opened.tabId));
  await msg({ type: 'set_tab_permission', tabId: opened.tabId, level: 'off' });
  assert(!(await invoke('list_tabs')).tabs.some(tab => tab.tabId === opened.tabId));
  await msg({ type: 'remove_tab_permission', tabId: opened.tabId });
  const otherWindow = await browser.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: false }));
  await browser.evaluate(({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), { id: opened.tabId, windowId: otherWindow.id });
  assert.equal((await msg({ type: 'resolve_permission', tabId: opened.tabId })).level, 'off');
  await browser.evaluate(({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), { id: opened.tabId, windowId: red.windowId });
  assert.equal((await msg({ type: 'resolve_permission', tabId: opened.tabId })).level, 'auto');
  await msg({ type: 'set_tab_permission', tabId: red.id, level: 'ask' });
  let request = await ask('fill', { tabId: red.id, selector: '#password', text: 'SECOND-SECRET' });
  assert.equal(await browser.evaluate(() => chrome.action.getBadgeText({})), '1');
  await sleep(100); assert.equal((await pending()).length, 1, 'Ask remains pending without a notification service');
  assert.equal(request.entry.agentName, 'main'); assert.equal(request.entry.sessionId, sessionId);
  assert(!JSON.stringify(request.entry).includes('SECOND-SECRET'));
  await msg({ type: 'confirmation_response', requestId: request.entry.requestId, approved: true });
  assert(pair(await finish(request.key), request.key).filled);
  assert.equal(await browser.evaluate(() => chrome.action.getBadgeText({})), '');
  assert(!JSON.stringify(pair(await saved(), request.key)).includes('SECOND-SECRET'));
  request = await ask('execute_js', { tabId: red.id, code: 'Promise.resolve(window.pageOwned)' });
  await msg({ type: 'confirmation_response', requestId: request.entry.requestId, approved: true });
  assert.equal(pair(await finish(request.key), request.key).result, 41);
  request = await ask('get_tab_content', { tabId: red.id });
  await load(red.id, origin + '/navigation');
  assert.equal((await msg({ type: 'confirmation_response', requestId: request.entry.requestId, approved: true })).approved, false);
  assert(pair(await finish(request.key), request.key).error);
  request = await ask('click', { tabId: red.id, selector: 'button' });
  await msg({ type: 'set_tab_permission', tabId: red.id, level: 'off' });
  assert.equal((await msg({ type: 'confirmation_response', requestId: request.entry.requestId, approved: true })).approved, false);
  assert(pair(await finish(request.key), request.key).error);
  await msg({ type: 'set_tab_permission', tabId: red.id, level: 'ask' });
  request = await ask('get_tab_content', { tabId: red.id });
  await browser.evaluate(({ id, windowId }) => chrome.tabs.move(id, { windowId, index: -1 }), { id: red.id, windowId: otherWindow.id });
  assert.equal((await msg({ type: 'confirmation_response', requestId: request.entry.requestId, approved: true })).approved, false);
  assert(pair(await finish(request.key), request.key).error);
  stage = 'exact Session Main Stop and queued cancellation';
  const held = await ask('get_tab_content', { tabId: red.id });
  const queuedSession = (await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'firefox-queued' })).body.sessionId;
  const beforeQueue = await value(red.id, '#field');
  await begin('queued', [call('queued', 'call_tool', { toolId: 'node:owned-firefox/fill', args: { tabId: red.id, selector: '#field', text: 'MUST-NOT-RUN' } })], queuedSession);
  await until(async () => (await saved(queuedSession)).history.some(row => row.parts?.some(part => part.functionCall)), 'queued call dispatched');
  await sleep(100);
  await fixture.api('POST', '/api/sessions/' + encodeURIComponent(queuedSession) + '/stop', {});
  await until(async () => !(await fixture.api('GET', '/api/sessions/' + encodeURIComponent(queuedSession) + '/history')).body.session.busy, 'queued Stop drains');
  assert.equal((await pending()).length, 1);
  await msg({ type: 'confirmation_response', requestId: held.entry.requestId, approved: true }); await finish(held.key);
  assert.equal(await value(red.id, '#field'), beforeQueue); assert.equal((await pending()).length, 0);
  request = await ask('get_tab_content', { tabId: red.id });
  assert.equal((await fixture.api('POST', '/api/sessions/' + encodeURIComponent(sessionId) + '/stop', {})).status, 200);
  await until(async () => !(await pending()).length, 'Main Stop removes Ask');
  assert.equal((await msg({ type: 'confirmation_response', requestId: request.entry.requestId, approved: true })).approved, false);
  await until(async () => !(await fixture.api('GET', '/api/sessions/' + encodeURIComponent(sessionId) + '/history')).body.session.busy, 'Main Stop drains');
  await msg({ type: 'set_tab_permission', tabId: red.id, level: 'auto' });
  stage = 'cross-window focus and revoked in-flight JavaScript';
  const focusedBefore = await browser.evaluate(() => chrome.windows.getLastFocused());
  assert((await invoke('fill', { tabId: red.id, selector: '#field', text: 'background-window' })).filled);
  assert.equal((await browser.evaluate(() => chrome.windows.getLastFocused())).id, focusedBefore.id);
  await begin('revoked-js', [call('revoked-js', 'call_tool', { toolId: 'node:owned-firefox/execute_js', args: {
    tabId: red.id, code: 'new Promise(resolve => { document.body.dataset.pendingJS="started"; setTimeout(() => resolve("MUST-NOT-LEAK"), 500); })',
  } })]);
  await until(() => browser.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.body.dataset.pendingJS }))[0].result === 'started', red.id), 'JS started before revocation');
  await msg({ type: 'set_tab_permission', tabId: red.id, level: 'off' });
  const revoked = pair(await finish('revoked-js'), 'revoked-js');
  assert(revoked.error); assert(!JSON.stringify(revoked).includes('MUST-NOT-LEAK'));
  await msg({ type: 'set_tab_permission', tabId: red.id, level: 'auto' });
  const navigated = await invoke('navigate', { tabId: red.id, url: origin + '/navigated' }); assert(navigated.pageId, JSON.stringify(navigated));
  assert((await invoke('scroll', { tabId: red.id, deltaY: 50 })).scrolled);
  assert((await invoke('wait_for', { tabId: red.id, condition: 'text', text: 'Owned /navigated' })).matched);
  assert.equal((await invoke('wait_for', { tabId: red.id, condition: 'element', selector: '#missing', timeoutMs: 100 })).reason, 'timeout');
  assert((await invoke('close_tab', { tabId: opened.tabId })).closed);
  stage = 'background lifetime with no extension page, Stop and reload';
  await browser.goto('about:blank');
  await sleep(65000);
  assert((await fixture.api('GET', '/api/nodes')).body.nodes.some(node => node.id === 'owned-firefox' && node.executable));
  assert((await invoke('get_tab_content', { tabId: red.id })).elements);
  assert(!(await invoke('screenshot', { tabId: red.id })).error);
  await browser.goto(`moz-extension://${browser.uuid}/popup/popup.html`);
  assert.equal((await msg({ type: 'get_state' })).state, 'registered');
  await msg({ type: 'disconnect' }); await sleep(32000);
  assert.equal((await msg({ type: 'get_state' })).state, 'disconnected');
  await browser.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); return true; }); await sleep(1000);
  await browser.goto(`moz-extension://${browser.uuid}/popup/popup.html`);
  assert.equal((await msg({ type: 'get_state' })).state, 'disconnected');
  assert.equal((await msg({ type: 'get_connection' })).enabled, false);
  assert(!(await msg({ type: 'connect', host: base, pairingToken: '', nodeName: 'owned-firefox' })).error);
  await until(async () => (await msg({ type: 'get_state' })).state === 'registered', 'credential reconnect');
  await msg({ type: 'reset' }); await sleep(32000);
  assert.equal((await msg({ type: 'get_state' })).state, 'disconnected');
  assert.equal((await msg({ type: 'get_connection' })).hasCredentials, false);
  evidence.result = 'passed';
  evidence.coverage = ['served credential-free Firefox and unchanged Chrome ZIP', 'actual temporary install and module background', 'pair/approve/discovery/model dispatch', 'default Off and top-document DOM refs/forms/synthetic events', 'optional JS denial/grant/revoke and strict-CSP Promise/page globals', 'background target PNG and exact Session image history', 'stale refs, screenshot identities and link/navigation privacy', 'shared windows/new/moved tabs and explicit Off', 'Ask origin/Session and navigation/revocation/move', 'Main Stop and queued cancellation without replay', '65-second popup-free socket lifetime', 'Stop through alarm and background reload; reconnect and Forget'];
  console.log(JSON.stringify(evidence));
  if (process.env.FOXWARM_FIREFOX_EVIDENCE) await writeFile(process.env.FOXWARM_FIREFOX_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
} catch (error) {
  console.error('Firefox qualification stage: ' + stage + '\n' + fixture.output);
  if (browser) console.error('Firefox state', await msg({type:'get_state'}).catch(error => error.message));
  throw error;
} finally {
  if (browser) await browser.close();
  await fixture.cleanup();
  await new Promise(done => peer.close(done));
}
