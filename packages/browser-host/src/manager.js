// One managed headless Chromium per host process: one default browser context whose tabs are
// shared by every caller. Tool semantics follow the shared browser_* contract; element logic
// (snapshots, refs, occlusion, native-setter fill, select, conditions) is the extension's
// pageFunctions.js, and key input / bounded evaluation come from the shared CDP operations.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { toolDefinitions, validateArgs } from '../../browser-node/background/contract.js';
import { readPage, elementAction, pageCondition } from '../../browser-node/background/pageFunctions.js';
import { evaluateBounded, pressKey, typeText } from '../../browser-node/background/cdpOps.js';
import { buildBrowserScreenshotResult } from '../../browser-node/background/toolResults.js';
import { locateChromium } from './chromium.js';

export const PROFILE = { variant: 'headless', windowed: false, keys: true, fullPage: true };
export const definitions = () => toolDefinitions(PROFILE);

export const LIMITS = {
  maxTabs: 10,
  idleMs: 10 * 60 * 1000,
  navigationMs: 30000,
  loadMs: 3000,
  quietMs: 250,
  fullPageHeight: 12000,
  fullPageWidth: 4096,
  dialogText: 500,
};

// Launch policy: Chromium's own sandbox stays on and site isolation stays at its default. The
// operator selects a launcher suited to their environment through the browser executable.
export const LAUNCH_ARGS = [];

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function sandboxHint(message) {
  return /sandbox/i.test(message)
    ? message +
        '\nChromium could not start its sandbox. In a Docker container, run it with the seccomp profile shipped as docker/seccomp-chromium.json (--security-opt seccomp=...) and as a non-root user. Elsewhere the machine needs unprivileged user namespaces, and Chromium cannot be run as root; alternatively select a launcher suited to the environment with PUPPETEER_EXECUTABLE_PATH.'
    : message;
}

// The pipe transport reports a browser that exits during startup only as a closed target, while
// Chromium writes the reason (such as "No usable sandbox!") to its own stderr. After a failed launch,
// one bounded headless run of the same executable recovers that line.
function launchDiagnostic(executablePath, env) {
  return new Promise((resolve) => {
    execFile(
      executablePath,
      ['--headless', '--dump-dom', 'about:blank'],
      { env, timeout: 10000, maxBuffer: 1024 * 1024 },
      (_error, _stdout, stderr) =>
        resolve(
          String(stderr || '')
            .split('\n')
            .map((line) => line.trim())
            .find((line) => /sandbox/i.test(line))
            ?.slice(0, 500) ?? '',
        ),
    );
  });
}

const allowedFrameUrl = (url) => /^(https?:|about:blank$|chrome-error:)/i.test(url);

export class BrowserManager {
  constructor({ launch = (options) => puppeteer.launch(options), limits = {}, env = process.env } = {}) {
    this.launchFn = launch;
    this.limits = { ...LIMITS, ...limits };
    this.env = env;
    this.browser = null;
    this.launching = null;
    this.spare = [];
    this.tabs = new Map();
    this.byPage = new WeakMap();
    this.nextTabId = 1;
    this.active = 0;
    this.idleTimer = null;
    this.closed = false;
  }

  // ---- lifecycle -------------------------------------------------------------------------
  async ensureBrowser(signal) {
    if (this.closed) throw new Error('Browser host is shutting down.');
    if (this.browser) return this.browser;
    this.launching ??= this.launchBrowser().finally(() => (this.launching = null));
    return abortable(this.launching, signal);
  }

  async launchBrowser() {
    const found = locateChromium(this.env);
    if (!found.path) throw new Error(found.reason);
    let browser;
    try {
      browser = await this.launchFn({
        executablePath: found.path,
        headless: true,
        pipe: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        defaultViewport: { width: 1280, height: 720 },
        args: LAUNCH_ARGS,
      });
    } catch (error) {
      const message = String(error?.message || error);
      const detail = /sandbox/i.test(message) ? '' : await launchDiagnostic(found.path, this.env);
      throw new Error(sandboxHint(detail ? message + '\n' + detail : message));
    }
    try {
      // Pages must not write files: downloads are refused instead of landing somewhere unchecked.
      const session = await browser.target().createCDPSession();
      await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      await session.detach().catch(() => {});
    } catch {
      /* the policy call is best effort on browsers without the command */
    }
    browser.on('disconnected', () => {
      if (this.browser === browser) this.dropBrowser();
    });
    browser.on('targetcreated', async (target) => {
      if (target.type() !== 'page') return;
      try {
        const page = await target.page();
        if (page) this.adopt(page);
      } catch {
        /* the target closed before it could be adopted */
      }
    });
    this.spare = (await browser.pages()).filter((page) => page.url() === 'about:blank');
    this.browser = browser;
    return browser;
  }

  dropBrowser() {
    this.browser = null;
    this.spare = [];
    this.tabs.clear();
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    if (!this.browser) return;
    this.idleTimer = setTimeout(() => {
      if (this.active === 0) void this.closeBrowser();
      else this.armIdle();
    }, this.limits.idleMs);
    this.idleTimer.unref?.();
  }

  async closeBrowser() {
    clearTimeout(this.idleTimer);
    const browser = this.browser;
    this.dropBrowser();
    await browser?.close().catch(() => {});
  }

  async close() {
    this.closed = true;
    await this.closeBrowser();
  }

  // ---- tabs ------------------------------------------------------------------------------
  adopt(page) {
    const known = this.byPage.get(page);
    if (known) return known;
    if (this.tabs.size >= this.limits.maxTabs) {
      void page.close().catch(() => {});
      return null;
    }
    const tab = {
      id: this.nextTabId++,
      page,
      pageId: crypto.randomUUID(),
      navRequests: 0,
      navCommits: 0,
      navInFlight: new Set(),
      inFlight: new Set(),
      dialogs: [],
      lane: Promise.resolve(),
      cdp: null,
    };
    this.tabs.set(tab.id, tab);
    this.byPage.set(page, tab);
    const main = () => page.mainFrame();
    page.on('request', (request) => {
      tab.inFlight.add(request);
      if (request.isNavigationRequest() && request.frame() === main()) {
        tab.navRequests++;
        tab.navInFlight.add(request);
      }
    });
    const finish = (request) => {
      tab.inFlight.delete(request);
      tab.navInFlight.delete(request);
    };
    page.on('requestfinished', finish);
    page.on('requestfailed', finish);
    page.on('framenavigated', (frame) => {
      if (frame !== main()) return;
      tab.navCommits++;
      tab.pageId = crypto.randomUUID();
      if (!allowedFrameUrl(frame.url())) void page.goto('about:blank').catch(() => {});
    });
    page.on('dialog', async (dialog) => {
      const accept = dialog.type() === 'alert' || dialog.type() === 'beforeunload';
      tab.dialogs.push({
        type: dialog.type(),
        message: dialog.message().slice(0, this.limits.dialogText),
        handled: accept ? 'accepted' : 'dismissed',
      });
      try {
        if (accept) await dialog.accept();
        else await dialog.dismiss();
      } catch {
        /* the dialog already closed */
      }
    });
    page.on('close', () => {
      this.tabs.delete(tab.id);
    });
    return tab;
  }

  tab(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Tab ${id} was not found. List the open tabs with browser_tabs.`);
    return tab;
  }

  ordered(tab, run, signal) {
    const next = tab.lane.catch(() => {}).then(() => {
      signal.throwIfAborted();
      return run();
    });
    tab.lane = next;
    return abortable(next, signal);
  }

  async cdpSend(tab, method, params) {
    tab.cdp ??= await tab.page.createCDPSession();
    return tab.cdp.send(method, params);
  }

  async title(tab) {
    try {
      return await tab.page.title();
    } catch {
      return '';
    }
  }

  marks(tab) {
    tab.dialogs = [];
    return { requests: tab.navRequests, commits: tab.navCommits, pageId: tab.pageId };
  }

  async state(tab, before, extra = {}) {
    const state = {
      tabId: tab.id,
      url: tab.page.url(),
      title: await this.title(tab),
      navigated: tab.navCommits !== before.commits,
      ...extra,
    };
    if (tab.dialogs.length) state.dialogs = tab.dialogs.splice(0, 5);
    return state;
  }

  // ---- waiting ---------------------------------------------------------------------------
  async readyState(tab) {
    try {
      return await tab.page.evaluate(() => document.readyState);
    } catch {
      return null;
    }
  }

  // Bounded settle after an action: a short window to notice a navigation starting, then the
  // document commit and DOMContentLoaded, a little time for load, and a brief request lull.
  async settle(tab, before, ctx, quietMs = this.limits.quietMs) {
    const { signal } = ctx;
    const started = () => tab.navRequests !== before.requests || tab.navCommits !== before.commits;
    const quietEnd = Date.now() + quietMs;
    while (!started() && Date.now() < quietEnd) await sleep(25, signal);
    if (!started()) return;
    const navEnd = Math.min(ctx.deadline, Date.now() + this.limits.navigationMs);
    while (Date.now() < navEnd) {
      if (tab.navInFlight.size === 0 && tab.navCommits !== before.commits) {
        const ready = await this.readyState(tab);
        if (ready && ready !== 'loading') break;
      }
      await sleep(40, signal);
    }
    const loadEnd = Math.min(ctx.deadline, Date.now() + this.limits.loadMs);
    while (Date.now() < loadEnd && (await this.readyState(tab)) !== 'complete') await sleep(50, signal);
    const lullEnd = Math.min(ctx.deadline, Date.now() + 1500);
    let quietSince = Date.now();
    while (Date.now() < lullEnd) {
      if (tab.inFlight.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= 200) break;
      await sleep(50, signal);
    }
  }

  async load(tab, run, ctx) {
    const before = this.marks(tab);
    const timeout = Math.max(1000, Math.min(this.limits.navigationMs, ctx.deadline - Date.now()));
    const response = await abortable(
      run({ waitUntil: 'domcontentloaded', timeout }),
      ctx.signal,
    );
    await this.settle(tab, before, ctx, 0);
    return this.state(tab, before, response ? { status: response.status() } : {});
  }

  // ---- tools -----------------------------------------------------------------------------
  /** Runs one validated tool call. `ctx` is `{ signal, deadline }`. */
  async execute(name, rawArgs, ctx) {
    const args = validateArgs(name, rawArgs, PROFILE);
    this.active++;
    try {
      ctx.signal.throwIfAborted();
      return await this.dispatch(name, args, ctx);
    } finally {
      this.active--;
      this.armIdle();
    }
  }

  async dispatch(name, args, ctx) {
    if (name === 'browser_tabs') {
      if (!this.browser) return { tabs: [] };
      const tabs = [...this.tabs.values()];
      return {
        tabs: await Promise.all(
          tabs.map(async (tab) => ({
            tabId: tab.id,
            url: tab.page.url(),
            title: await this.title(tab),
          })),
        ),
      };
    }
    if (name === 'browser_open') return this.open(args, ctx);
    const tab = this.tab(args.tabId);
    if (name === 'browser_close') {
      await abortable(tab.page.close({ runBeforeUnload: false }), ctx.signal);
      this.tabs.delete(tab.id);
      return { closed: true, tabId: tab.id };
    }
    return this.ordered(tab, () => this.act(name, args, tab, ctx), ctx.signal);
  }

  async open(args, ctx) {
    const browser = await this.ensureBrowser(ctx.signal);
    if (this.tabs.size >= this.limits.maxTabs)
      throw new Error(`Tab limit reached (${this.limits.maxTabs}). Close a tab with browser_close first.`);
    const page = this.spare.shift() ?? (await abortable(browser.newPage(), ctx.signal));
    const tab = this.adopt(page);
    if (!tab) throw new Error('Tab limit reached. Close a tab with browser_close first.');
    try {
      return await this.load(tab, (options) => tab.page.goto(args.url, options), ctx);
    } catch (error) {
      // A page that never became a usable tab must not stay behind untracked.
      this.tabs.delete(tab.id);
      await page.close({ runBeforeUnload: false }).catch(() => {});
      throw error;
    }
  }

  async evalIn(tab, fn, ...fnArgs) {
    return tab.page.evaluate(fn, ...fnArgs);
  }

  staleCheck(tab, args) {
    if (args.ref && !args.ref.startsWith(tab.pageId + '/'))
      throw new Error('Element reference is stale. Read a fresh snapshot.');
  }

  async act(name, args, tab, ctx) {
    const { signal } = ctx;
    const guard = (promise) => abortable(promise, signal);
    const element = { ref: args.ref, selector: args.selector };
    const hasElement = args.ref !== undefined || args.selector !== undefined;
    this.staleCheck(tab, args);

    if (name === 'browser_navigate') {
      if (args.url) return this.load(tab, (options) => tab.page.goto(args.url, options), ctx);
      if (args.history === 'reload') return this.load(tab, (options) => tab.page.reload(options), ctx);
      const move = args.history === 'back' ? tab.page.goBack : tab.page.goForward;
      const result = await this.load(tab, (options) => move.call(tab.page, options), ctx).catch(
        (error) => {
          if (/History entry/i.test(String(error?.message))) return { navigated: false };
          throw error;
        },
      );
      if (!result.navigated) throw new Error(`There is no ${args.history} entry in this tab's history.`);
      return result;
    }

    if (name === 'browser_read') {
      const snapshotId = `${tab.pageId}/${crypto.randomUUID()}`;
      const content = await guard(this.evalIn(tab, readPage, args.format ?? 'snapshot', snapshotId));
      return { tabId: tab.id, pageId: tab.pageId, url: tab.page.url(), title: await this.title(tab), ...content };
    }

    if (name === 'browser_screenshot') return this.screenshot(tab, args, ctx);

    if (name === 'browser_wait') {
      const end = Math.min(ctx.deadline, Date.now() + (args.timeoutMs ?? 10000));
      const condition = { ...args, state: args.state ?? 'visible' };
      const before = this.marks(tab);
      let matched = false;
      while (true) {
        signal.throwIfAborted();
        try {
          if (await guard(this.evalIn(tab, pageCondition, condition))) {
            matched = true;
            break;
          }
        } catch (error) {
          // The document may be replaced mid-poll; the condition is retried on the new one.
          if (signal.aborted) throw error;
        }
        if (Date.now() >= end) break;
        await sleep(Math.min(100, end - Date.now()), signal);
      }
      return this.state(tab, before, matched ? { matched: true } : { matched: false, reason: 'timeout' });
    }

    const before = this.marks(tab);

    if (name === 'browser_click') {
      let point;
      if (hasElement) point = await guard(this.evalIn(tab, elementAction, element, 'point'));
      else {
        if (args.pageId !== tab.pageId) throw new Error('Screenshot page identity is stale.');
        const view = await guard(this.evalIn(tab, () => ({ width: innerWidth, height: innerHeight })));
        if (args.x < 0 || args.y < 0 || args.x >= view.width || args.y >= view.height)
          throw new Error('Coordinates are outside the viewport.');
        point = { x: args.x, y: args.y };
      }
      await guard(tab.page.mouse.click(point.x, point.y));
      await this.settle(tab, before, ctx);
      return this.state(tab, before, { clicked: true });
    }

    if (name === 'browser_fill') {
      await guard(this.evalIn(tab, elementAction, { ...element, text: args.text }, 'replace'));
      await this.settle(tab, before, ctx, 0);
      return this.state(tab, before, { filled: true }); // Never echo entered values.
    }

    if (name === 'browser_type' || name === 'browser_press') {
      if (hasElement) await guard(this.evalIn(tab, elementAction, element, 'focus'));
      const send = (method, params) => guard(this.cdpSend(tab, method, params));
      if (name === 'browser_type') {
        await typeText(send, args.text);
        await this.settle(tab, before, ctx, 0);
        return this.state(tab, before, { typed: true });
      }
      await pressKey(send, args.key);
      await this.settle(tab, before, ctx);
      return this.state(tab, before, { pressed: args.key });
    }

    if (name === 'browser_select') {
      const result = await guard(
        this.evalIn(tab, elementAction, { ...element, values: args.values }, 'select'),
      );
      await this.settle(tab, before, ctx, 100);
      return this.state(tab, before, result);
    }

    if (name === 'browser_scroll') {
      const result = await guard(
        this.evalIn(tab, elementAction, { ...element, deltaX: args.deltaX, deltaY: args.deltaY }, 'scroll'),
      );
      return this.state(tab, before, result);
    }

    if (name === 'browser_evaluate') {
      const send = (method, params) => guard(this.cdpSend(tab, method, params));
      const result = await evaluateBounded(send, args.code);
      await this.settle(tab, before, ctx, 150);
      return this.state(tab, before, result);
    }
    throw new Error('Unknown browser tool: ' + name);
  }

  async screenshot(tab, args, ctx) {
    const { signal } = ctx;
    const guard = (promise) => abortable(promise, signal);
    const measured = await guard(
      this.evalIn(tab, () => ({
        width: innerWidth,
        height: innerHeight,
        scale: visualViewport?.scale || 1,
        pageX: scrollX,
        pageY: scrollY,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      })),
    );
    const { scrollWidth, scrollHeight, ...viewport } = measured;
    const options = { type: 'png', encoding: 'base64' };
    let truncated = false;
    if (args.fullPage) {
      const width = Math.min(scrollWidth, this.limits.fullPageWidth);
      const height = Math.min(scrollHeight, this.limits.fullPageHeight);
      truncated = width < scrollWidth || height < scrollHeight;
      Object.assign(options, { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height } });
    }
    const data = await guard(tab.page.screenshot(options));
    return {
      ...buildBrowserScreenshotResult(data, {
        tabId: tab.id,
        pageId: tab.pageId,
        url: tab.page.url(),
        viewport,
      }),
      ...(args.fullPage ? { fullPage: true, truncated } : {}),
    };
  }
}
