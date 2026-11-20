// Shared test fixture: a local HTTP site and a Chromium launcher for this environment.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { locateChromium } from '../src/chromium.js';

const INDEX = `<!doctype html><title>Fixture home</title>
<style>body{margin:0;font:16px sans-serif}button,input,select,a{display:block;margin:6px;padding:6px}</style>
<h1>Fixture</h1>
<input id="controlled" aria-label="Controlled" type="text">
<p id="mirror">mirror:</p><p id="changes">changes:0</p>
<input id="plain" aria-label="Plain" type="text">
<p id="keys"></p>
<button id="count">Count</button><p id="counter">0</p>
<button id="alert">Alert</button><button id="confirm">Confirm</button><p id="answer"></p>
<a id="go" href="/second">Go second</a>
<a id="jump" href="/slow-script">Jump</a>
<select id="color"><option value="r">Red</option><option value="g">Green</option></select><p id="picked"></p>
<div style="height:3000px">tall</div>
<p id="late-slot"></p>
<button id="covered">Covered</button><div id="cover" style="position:fixed;left:0;top:0;width:100%;height:100%;display:none"></div>
<button id="filebtn">File</button>
<script>
// Mirrors how React tracks controlled inputs: assignments through the element's own value
// property are invisible to its input handler; only the native prototype setter is seen.
const input = document.getElementById('controlled');
const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
let tracked = '';
Object.defineProperty(input, 'value', {
  configurable: true,
  get() { return proto.get.call(this); },
  set(v) { tracked = String(v); proto.set.call(this, v); },
});
let changes = 0;
input.addEventListener('input', () => {
  const current = proto.get.call(input);
  if (current === tracked) return;
  tracked = current;
  document.getElementById('mirror').textContent = 'mirror:' + current;
});
input.addEventListener('change', () => { changes++; document.getElementById('changes').textContent = 'changes:' + changes; });
const plain = document.getElementById('plain');
plain.addEventListener('keydown', (e) => { document.getElementById('keys').textContent += '[' + e.key + ']'; });
let n = 0;
document.getElementById('count').onclick = () => { document.getElementById('counter').textContent = ++n; };
document.getElementById('alert').onclick = () => { alert('hello alert'); };
document.getElementById('confirm').onclick = () => { document.getElementById('answer').textContent = String(confirm('sure?')); };
document.getElementById('color').onchange = (e) => { document.getElementById('picked').textContent = e.target.value; };
document.getElementById('filebtn').onclick = () => { location.href = 'file:///etc/hostname'; };
setTimeout(() => { document.getElementById('late-slot').innerHTML = '<span id="late">Late arrival</span>'; }, 500);
</script>`;

const pages = {
  '/': INDEX,
  '/second': '<!doctype html><title>Second page</title><h1 id="second">Second</h1><a href="/">Home</a>',
  '/big': `<!doctype html><title>Big</title><main>${'<p>paragraph of filler text for truncation checks</p>'.repeat(5000)}${'<button>b</button>'.repeat(900)}</main>`,
  '/slow-script': '<!doctype html><title>Jumped</title><p>arrived</p>',
};

export async function startSite() {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url === '/hang') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<!doctype html><title>Hang</title>');
      return; // never ends: the document keeps loading
    }
    if (request.url === '/stall') return; // never answers
    const body = pages[request.url.split('?')[0]];
    if (!body) {
      response.writeHead(404, { 'content-type': 'text/html' });
      return response.end('<!doctype html><title>Not found</title>missing');
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (route = '/') => `http://127.0.0.1:${port}${route}`,
    port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

// Environments that cannot create Chromium's sandbox (containers, restricted user namespaces)
// select a launcher through the standard executable variable. This is test-owned setup; the
// product never adds sandbox-disabling flags itself.
let environment;
export async function browserEnvironment() {
  if (environment) return environment;
  const found = locateChromium(process.env);
  if (!found.path) return (environment = { env: process.env, available: false, reason: found.reason });
  try {
    const browser = await puppeteer.launch({ executablePath: found.path, headless: true, pipe: true });
    await browser.close();
    return (environment = { env: process.env, available: true });
  } catch {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fw-browser-wrapper-'));
    const wrapper = path.join(directory, 'chromium-wrapper.sh');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${found.path}" --no-sandbox "$@"\n`, { mode: 0o755 });
    return (environment = {
      env: { ...process.env, PUPPETEER_EXECUTABLE_PATH: wrapper },
      available: true,
      wrapper,
    });
  }
}

export const context = (ms = 20000) => ({
  signal: AbortSignal.timeout(ms),
  deadline: Date.now() + ms,
});
