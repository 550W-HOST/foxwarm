import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BrowserManager, LAUNCH_ARGS } from '../src/manager.js';
import { browserEnvironment, context, startSite } from './fixture.mjs';

const environment = await browserEnvironment();
const skip = environment.available ? false : environment.reason;

describe('managed headless browser', { skip }, () => {
  let site;
  let manager;
  const call = (name, args = {}, ctx = context()) => manager.execute(name, args, ctx);
  const text = async (tabId, selector) =>
    (await call('browser_evaluate', { tabId, code: `document.querySelector(${JSON.stringify(selector)}).textContent` }))
      .result;
  const snapshot = async (tabId) => call('browser_read', { tabId });
  const refFor = (shot, label) => shot.elements.find((element) => element.label === label)?.ref;

  before(async () => {
    site = await startSite();
    manager = new BrowserManager({ env: environment.env });
  });
  after(async () => {
    await manager.close();
    await site.close();
  });

  test('lists nothing before any tab exists and never launches for that', async () => {
    assert.deepEqual(await call('browser_tabs'), { tabs: [] });
    assert.equal(manager.browser, null);
  });

  let tabId;
  test('open returns live page state and tabs reads metadata live', async () => {
    const opened = await call('browser_open', { url: site.url('/') });
    tabId = opened.tabId;
    assert.equal(opened.title, 'Fixture home');
    assert.equal(opened.navigated, true);
    assert.equal(opened.status, 200);
    assert.deepEqual((await call('browser_tabs')).tabs, [{ tabId, url: site.url('/'), title: 'Fixture home' }]);
    await call('browser_evaluate', { tabId, code: 'document.title = "Changed live"; history.replaceState(null, "", "/live")' });
    assert.deepEqual((await call('browser_tabs')).tabs, [{ tabId, url: site.url('/live'), title: 'Changed live' }]);
    await call('browser_navigate', { tabId, url: site.url('/') });
  });

  test('snapshot gives element refs and html/text formats are bounded', async () => {
    const shot = await snapshot(tabId);
    assert.ok(shot.pageId && shot.elements.length > 5);
    assert.ok(refFor(shot, 'Controlled'));
    const plain = await call('browser_read', { tabId, format: 'text' });
    assert.match(plain.text, /Fixture/);
    const html = await call('browser_read', { tabId, format: 'html' });
    assert.match(html.html, /<h1>Fixture<\/h1>/);
  });

  test('fill updates a React-style controlled input through its native setter', async () => {
    const shot = await snapshot(tabId);
    const result = await call('browser_fill', { tabId, ref: refFor(shot, 'Controlled'), text: 'hello world' });
    assert.equal(result.filled, true);
    assert.equal(result.navigated, false);
    assert.equal(await text(tabId, '#mirror'), 'mirror:hello world');
    assert.equal(await text(tabId, '#changes'), 'changes:1');
    assert.equal(JSON.stringify(result).includes('hello world'), false);
  });

  test('a click that does not navigate returns quickly with unchanged navigation state', async () => {
    const started = Date.now();
    const result = await call('browser_click', { tabId, selector: '#count' });
    assert.equal(result.clicked, true);
    assert.equal(result.navigated, false);
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started}ms`);
    assert.equal(await text(tabId, '#counter'), '1');
  });

  test('a click on a link reports navigation and the new page', async () => {
    const result = await call('browser_click', { tabId, selector: '#go' });
    assert.equal(result.navigated, true);
    assert.equal(result.url, site.url('/second'));
    assert.equal(result.title, 'Second page');
    const back = await call('browser_navigate', { tabId, history: 'back' });
    assert.equal(back.url, site.url('/'));
    const forward = await call('browser_navigate', { tabId, history: 'forward' });
    assert.equal(forward.url, site.url('/second'));
    const reload = await call('browser_navigate', { tabId, history: 'reload' });
    assert.equal(reload.navigated, true);
    await call('browser_navigate', { tabId, url: site.url('/') });
    await assert.rejects(call('browser_navigate', { tabId, history: 'forward' }), /no forward entry/);
  });

  test('stale element references are refused after navigation', async () => {
    const shot = await snapshot(tabId);
    const ref = refFor(shot, 'Go second');
    await call('browser_navigate', { tabId, url: site.url('/second') });
    await assert.rejects(call('browser_click', { tabId, ref }), /stale/);
    await call('browser_navigate', { tabId, url: site.url('/') });
  });

  test('screenshot returns an image envelope and coordinates click through it', async () => {
    const shot = await call('browser_screenshot', { tabId });
    assert.equal(shot.mimeType, 'image/png');
    assert.equal(Buffer.from(shot.inlineData.data, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.ok(shot.pageId && shot.viewport.width === 1280);
    const box = (await snapshot(tabId)).elements.find((element) => element.label === 'Count').bbox;
    const before = Number(await text(tabId, '#counter'));
    const clicked = await call('browser_click', {
      tabId,
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      pageId: shot.pageId,
    });
    assert.equal(clicked.clicked, true);
    assert.equal(Number(await text(tabId, '#counter')), before + 1);
    await assert.rejects(call('browser_click', { tabId, x: 5000, y: 5, pageId: shot.pageId }), /outside the viewport/);
    await assert.rejects(call('browser_click', { tabId, x: 5, y: 5, pageId: 'old' }), /stale/);
    const full = await call('browser_screenshot', { tabId, fullPage: true });
    assert.equal(full.fullPage, true);
    assert.ok(full.inlineData.data.length > shot.inlineData.data.length);
  });

  test('dialogs are handled and reported with the action that raised them', async () => {
    const alerted = await call('browser_click', { tabId, selector: '#alert' });
    assert.deepEqual(alerted.dialogs, [{ type: 'alert', message: 'hello alert', handled: 'accepted' }]);
    const confirmed = await call('browser_click', { tabId, selector: '#confirm' });
    assert.deepEqual(confirmed.dialogs, [{ type: 'confirm', message: 'sure?', handled: 'dismissed' }]);
    assert.equal(await text(tabId, '#answer'), 'false');
    const quiet = await call('browser_click', { tabId, selector: '#count' });
    assert.equal(quiet.dialogs, undefined);
  });

  test('type and press use real key input and a target element', async () => {
    await call('browser_type', { tabId, selector: '#plain', text: 'abc' });
    assert.equal(await text(tabId, '#keys'), '[a][b][c]');
    assert.equal((await call('browser_evaluate', { tabId, code: 'document.getElementById("plain").value' })).result, 'abc');
    await call('browser_press', { tabId, selector: '#plain', key: 'Backspace' });
    assert.equal((await call('browser_evaluate', { tabId, code: 'document.getElementById("plain").value' })).result, 'ab');
    await assert.rejects(call('browser_press', { tabId, key: 'F13' }), /key must be one of/);
  });

  test('select, scroll and element conditions', async () => {
    const picked = await call('browser_select', { tabId, selector: '#color', values: ['g'] });
    assert.equal(picked.selected, true);
    assert.equal(await text(tabId, '#picked'), 'g');
    await assert.rejects(call('browser_select', { tabId, selector: '#color', values: ['zz'] }), /unavailable/);
    await call('browser_scroll', { tabId, deltaY: 400 });
    assert.equal((await call('browser_evaluate', { tabId, code: 'scrollY' })).result, 400);
    const late = await call('browser_wait', { tabId, condition: 'element', selector: '#late' });
    assert.equal(late.matched, true);
    const text_ = await call('browser_wait', { tabId, condition: 'text', text: 'Late arrival', timeoutMs: 1000 });
    assert.equal(text_.matched, true);
    const missed = await call('browser_wait', { tabId, condition: 'element', selector: '#never', timeoutMs: 300 });
    assert.deepEqual([missed.matched, missed.reason], [false, 'timeout']);
    const url = await call('browser_wait', { tabId, condition: 'url', url: site.url('/'), timeoutMs: 1000 });
    assert.equal(url.matched, true);
  });

  test('selectors must be unique and covered elements are refused', async () => {
    await assert.rejects(call('browser_click', { tabId, selector: 'button' }), /exactly one element/);
    await call('browser_evaluate', { tabId, code: 'document.getElementById("cover").style.display = "block"' });
    await assert.rejects(call('browser_click', { tabId, selector: '#covered' }), /covered/);
    await call('browser_evaluate', { tabId, code: 'document.getElementById("cover").style.display = "none"' });
  });

  test('evaluate awaits promises, bounds results and reports page errors', async () => {
    const awaited = await call('browser_evaluate', { tabId, code: 'new Promise((r) => setTimeout(() => r({ ok: [1, 2] }), 50))' });
    assert.deepEqual(awaited.result, { ok: [1, 2] });
    const big = await call('browser_evaluate', { tabId, code: '"x".repeat(250000)' });
    assert.equal(big.result.length, 100000);
    assert.equal(big.truncated, true);
    await assert.rejects(call('browser_evaluate', { tabId, code: 'throw new Error("boom")' }), /JavaScript evaluation failed: .*boom/);
  });

  test('oversized pages are truncated in every read format', async () => {
    const { tabId: bigTab } = await call('browser_open', { url: site.url('/big') });
    const snap = await call('browser_read', { tabId: bigTab });
    assert.equal(snap.elements.length, 400);
    assert.equal(snap.truncated, true);
    assert.ok(snap.text.length <= 20000);
    const plain = await call('browser_read', { tabId: bigTab, format: 'text' });
    assert.equal(plain.truncated, true);
    assert.equal(plain.text.length, 100000);
    const html = await call('browser_read', { tabId: bigTab, format: 'html' });
    assert.equal(html.html.length, 100000);
    await call('browser_close', { tabId: bigTab });
  });

  test('non-HTTP schemes are rejected, including from the page', async () => {
    await assert.rejects(call('browser_open', { url: 'file:///etc/hostname' }), /Only HTTP and HTTPS/);
    await assert.rejects(call('browser_navigate', { tabId, url: 'file:///etc/hostname' }), /Only HTTP and HTTPS/);
    await assert.rejects(call('browser_navigate', { tabId, url: 'javascript:alert(1)' }), /Only HTTP and HTTPS/);
    await call('browser_click', { tabId, selector: '#filebtn' }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [tab] = (await call('browser_tabs')).tabs.filter((entry) => entry.tabId === tabId);
    assert.match(tab.url, /^(http:|about:blank)/);
  });

  test('a failed open leaves no page behind', async () => {
    const tabsBefore = (await call('browser_tabs')).tabs.length;
    const pagesBefore = (await manager.browser.pages()).length;
    await assert.rejects(call('browser_open', { url: 'http://127.0.0.1:1/' }), /ERR_CONNECTION_REFUSED|net::/);
    assert.equal((await call('browser_tabs')).tabs.length, tabsBefore);
    assert.equal((await manager.browser.pages()).length, pagesBefore);
  });

  test('cancellation reaches an in-flight call and the tab remains usable', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = manager.execute('browser_open', { url: site.url('/stall') }, { signal: controller.signal, deadline: Date.now() + 60000 });
    setTimeout(() => controller.abort(new Error('Browser call canceled.')), 300);
    await assert.rejects(pending, /canceled/);
    assert.ok(Date.now() - started < 5000);
    assert.equal((await call('browser_tabs')).tabs.every((entry) => entry.url !== 'about:blank'), true);
    assert.equal(await text(tabId, '#counter') !== undefined, true);
  });

  test('close removes the tab and unknown tabs are refused', async () => {
    assert.deepEqual(await call('browser_close', { tabId }), { closed: true, tabId });
    assert.deepEqual((await call('browser_tabs')).tabs, []);
    await assert.rejects(call('browser_read', { tabId }), /was not found/);
  });
});

describe('launch policy', () => {
  test('keeps the browser sandbox and site isolation defaults', async () => {
    let launched;
    const manager = new BrowserManager({
      env: { PUPPETEER_EXECUTABLE_PATH: process.execPath },
      launch: async (options) => {
        launched = options;
        throw new Error('stop after recording');
      },
    });
    await assert.rejects(manager.execute('browser_open', { url: 'http://127.0.0.1:9/' }, context()), /stop after recording/);
    assert.deepEqual(LAUNCH_ARGS, []);
    assert.deepEqual(launched.args, []);
    assert.equal(launched.executablePath, process.execPath);
    assert.equal(launched.pipe, true);
    assert.equal(launched.ignoreDefaultArgs, undefined);
  });

  test('a sandbox failure points at the container profile and the executable setting', async () => {
    const manager = new BrowserManager({
      env: { PUPPETEER_EXECUTABLE_PATH: process.execPath },
      launch: async () => {
        throw new Error('Failed to launch: No usable sandbox!');
      },
    });
    await assert.rejects(
      manager.execute('browser_open', { url: 'http://127.0.0.1:9/' }, context()),
      /seccomp-chromium\.json[\s\S]*PUPPETEER_EXECUTABLE_PATH/,
    );
  });

  test('a missing executable fails clearly without launching', async () => {
    let launches = 0;
    const manager = new BrowserManager({
      env: { PUPPETEER_EXECUTABLE_PATH: '/nonexistent/chromium' },
      launch: async () => void launches++,
    });
    await assert.rejects(manager.execute('browser_open', { url: 'http://127.0.0.1:9/' }, context()), /does not name an executable/);
    assert.equal(launches, 0);
  });
});

describe('limits', { skip }, () => {
  test('tab cap and idle shutdown', async () => {
    const site = await startSite();
    const manager = new BrowserManager({ env: environment.env, limits: { maxTabs: 2, idleMs: 400 } });
    try {
      await manager.execute('browser_open', { url: site.url('/second') }, context());
      await manager.execute('browser_open', { url: site.url('/second') }, context());
      await assert.rejects(manager.execute('browser_open', { url: site.url('/second') }, context()), /Tab limit/);
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(manager.browser, null, 'idle browser shut down');
      const reopened = await manager.execute('browser_open', { url: site.url('/second') }, context());
      assert.ok(reopened.tabId > 2, 'tab IDs are never reused');
    } finally {
      await manager.close();
      await site.close();
    }
  });
});
