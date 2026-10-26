// Minimal owned-profile WebDriver client; the product never requires geckodriver.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { until } from './experimentHostFixture.mjs';
export async function launchFirefox(extension, logPath) {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(done => socket.close(done));
  const { open } = await import('node:fs/promises');
  const log = await open(logPath, 'w');
  const driver = spawn(process.env.FOXWARM_GECKODRIVER || 'geckodriver', ['--port', String(port)], {
    stdio: ['ignore', log.fd, log.fd],
  });
  let sid;
  async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}` + path, {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = (await response.json()).value;
    if (!response.ok) throw new Error(value.message || JSON.stringify(value));
    return value;
  }
  const call = (path, body, method) => request('/session/' + sid + path, body, method);
  async function close() {
    if (sid) await call('', undefined, 'DELETE').catch(() => {});
    driver.kill(); await log.close();
  }
  try {
    let launchError;
    driver.once('error', error => { launchError = error; });
    await until(async () => {
      if (launchError) throw launchError;
      return request('/status').catch(() => false);
    }, 'owned geckodriver listener');
    const uuid = randomUUID();
    const session = await request('/session', { capabilities: { alwaysMatch: {
      browserName: 'firefox', 'moz:firefoxOptions': {
        binary: process.env.FOXWARM_FIREFOX || '/usr/bin/firefox',
        // Needed only by WebDriver to automate extension/browser permission UI.
        args: ['-headless', '--remote-allow-system-access'],
        prefs: { 'extensions.webextensions.uuids': JSON.stringify({ 'browser-node@foxwarm.dev': uuid }) },
      },
    } } });
    sid = session.sessionId;
    await call('/timeouts', { script: 70000 });
    await call('/moz/addon/install', { path: extension, temporary: true });
    const evaluate = (fn, ...args) => call('/execute/async', {
      script: `const done=arguments[arguments.length-1]; Promise.resolve((${fn.toString()})(...Array.from(arguments).slice(0,-1))).then(value=>done({value}), error=>done({error:String(error.message||error)}));`,
      args,
    }).then(result => { if (result.error) throw new Error(result.error); return result.value; });
    let handle = await call('/window');
    const goto = async url => {
      const handles = await call('/window/handles');
      if (!handles.includes(handle)) {
        await call('/window', { handle: handles[0] });
        handle = (await call('/window/new', { type: 'tab' })).handle;
        await call('/window', { handle });
      }
      return call('/url', { url });
    };
    await goto(`moz-extension://${uuid}/popup/popup.html`);
    return {
      version: session.capabilities.browserVersion, uuid, evaluate, goto, close,
      async click(selector) {
        await evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.update(tab.id, { active: true }); });
        const element = await call('/element', { using: 'css selector', value: selector });
        await call('/element/' + element['element-6066-11e4-a52e-4f735466cecf'] + '/click', {});
      },
      async grantUserScripts(allow = true) {
        await call('/moz/context', { context: 'chrome' });
        try {
          if (allow) await call('/execute/sync', { script: `
            const panel=PopupNotifications.panel;
            panel.querySelector('moz-checkbox, checkbox')?.click();
          `, args: [] });
          await until(async () => call('/execute/sync', {
            script: `const button=PopupNotifications.panel.querySelector(arguments[0] ? '.popup-notification-primary-button' : '.popup-notification-secondary-button'); if (!button || button.disabled) return false; button.click(); return true;`, args: [allow],
          }), 'browser user-script decision');
        } finally { await call('/moz/context', { context: 'content' }); }
      },
    };
  } catch (error) { await close(); throw error; }
}
