// One attached, top-document CDP adapter. No tab activation or alternate page driver.
import { readPage, elementAction, pageCondition } from './pageFunctions.js';
import { buildBrowserScreenshotResult } from './toolResults.js';
import { evaluateBounded, pressKey, typeText } from './cdpOps.js';
const pages = new Map();
let onUnexpectedDetach = () => {};
export function setDetachHandler(handler) {
  onUnexpectedDetach = handler;
}
export async function detach(tabId) {
  if (!pages.has(tabId)) return;
  pages.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
export async function detachAll() {
  await Promise.all([...pages.keys()].map(detach));
}
chrome.debugger.onDetach.addListener((source, reason) => {
  const page = pages.get(source.tabId);
  pages.delete(source.tabId);
  if (page && reason !== 'target_closed') onUnexpectedDetach();
});
export function invalidate(tabId) {
  const page = pages.get(tabId);
  if (page) {
    page.identity = '';
    page.contextId = null;
  }
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  const state = pages.get(source.tabId);
  if (!state) return;
  if (method === 'Runtime.executionContextCreated')
    state.contexts.set(params.context.id, params.context);
  if (method === 'Runtime.executionContextDestroyed')
    state.contexts.delete(params.executionContextId);
  if (method === 'Runtime.executionContextsCleared') state.contexts.clear();
  if (
    (method === 'Page.frameNavigated' && !params.frame.parentId) ||
    method === 'Page.navigatedWithinDocument' ||
    method === 'Runtime.executionContextsCleared'
  )
    invalidate(source.tabId);
});
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Browser call canceled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function command(tabId, method, params, signal) {
  signal.throwIfAborted();
  return abortable(chrome.debugger.sendCommand({ tabId }, method, params || {}), signal);
}
export async function page(tabId, signal) {
  let state = pages.get(tabId);
  if (!state) {
    await abortable(
      chrome.debugger.attach({ tabId }, '1.3').then(() => {
        if (signal.aborted) {
          void chrome.debugger.detach({ tabId }).catch(() => {});
          signal.throwIfAborted();
        }
      }),
      signal,
    );
    state = { identity: '', contexts: new Map() };
    pages.set(tabId, state);
    await command(tabId, 'Page.enable', {}, signal);
    await command(tabId, 'Runtime.enable', {}, signal);
  }
  const { frameTree } = await command(tabId, 'Page.getFrameTree', {}, signal);
  const frame = frameTree.frame;
  const identity = `${frame.id}:${frame.loaderId}:${frame.url}`;
  if (state.identity !== identity) {
    state.identity = identity;
    state.pageId = crypto.randomUUID();
    state.contextId = null;
  }
  if (!state.contextId) {
    const world = await command(
      tabId,
      'Page.createIsolatedWorld',
      { frameId: frame.id, worldName: 'foxwarm-page' },
      signal,
    );
    state.contextId = world.executionContextId;
  }
  const isolated = state.contexts.get(state.contextId);
  const main = [...state.contexts.values()].findLast(
    (context) => context.auxData?.isDefault && context.auxData.frameId === frame.id,
  );
  if (!isolated?.uniqueId || !main?.uniqueId)
    throw new Error('Page context is unavailable. Read the page again.');
  return {
    pageId: state.pageId,
    uniqueContextId: isolated.uniqueId,
    mainUniqueContextId: main.uniqueId,
    url: frame.url,
  };
}
export async function assertPage(tabId, expected, signal) {
  const current = await page(tabId, signal);
  if (current.pageId !== expected.pageId)
    throw new Error('Page changed. Read a fresh snapshot or screenshot.');
  return current;
}
async function invoke(tabId, expected, fn, args, signal) {
  await assertPage(tabId, expected, signal);
  const response = await command(
    tabId,
    'Runtime.callFunctionOn',
    {
      uniqueContextId: expected.uniqueContextId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    },
    signal,
  );
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description?.split('\n')[0] || 'Page operation failed.',
    );
  return response.result?.value;
}
export async function content(tabId, expected, format, signal) {
  return invoke(
    tabId,
    expected,
    readPage,
    [format, `${expected.pageId}/${crypto.randomUUID()}`],
    signal,
  );
}
export async function screenshot(tabId, expected, signal) {
  const metrics = await command(tabId, 'Page.getLayoutMetrics', {}, signal);
  const viewport = metrics.cssVisualViewport;
  await assertPage(tabId, expected, signal);
  const { data } = await command(
    tabId,
    'Page.captureScreenshot',
    { format: 'png', fromSurface: true, captureBeyondViewport: false },
    signal,
  );
  return buildBrowserScreenshotResult(data, {
    tabId,
    pageId: expected.pageId,
    url: expected.url,
    viewport: {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
      scale: viewport.scale,
      pageX: viewport.pageX,
      pageY: viewport.pageY,
    },
  });
}
const sendFor = (tabId, signal) => (method, params) => command(tabId, method, params, signal);

async function committedFrame(tabId, signal) {
  const { frameTree } = await command(tabId, 'Page.getFrameTree', {}, signal);
  return frameTree.frame;
}

// Resolves once the main frame shows a different document or URL than `before`, bounded.
async function awaitFrameChange(tabId, before, signal, limitMs = 15000) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    const frame = await committedFrame(tabId, signal);
    if (frame.loaderId !== before.loaderId || frame.url !== before.url) return frame;
    await abortable(new Promise((resolve) => setTimeout(resolve, 50)), signal);
  }
  throw new Error('Navigation did not start.');
}

async function navigate(tabId, expected, args, signal, beginNavigation) {
  await assertPage(tabId, expected, signal);
  if (args.url) {
    beginNavigation();
    const response = await command(tabId, 'Page.navigate', { url: args.url }, signal);
    if (response.errorText) throw new Error('Navigation failed: ' + response.errorText);
    while (true) {
      const frame = await committedFrame(tabId, signal);
      if (response.loaderId ? frame.loaderId === response.loaderId : frame.url === args.url) break;
      await abortable(new Promise((resolve) => setTimeout(resolve, 50)), signal);
    }
    return { navigated: true };
  }
  const before = await committedFrame(tabId, signal);
  if (args.history === 'reload') {
    beginNavigation();
    await command(tabId, 'Page.reload', {}, signal);
  } else {
    const { currentIndex, entries } = await command(tabId, 'Page.getNavigationHistory', {}, signal);
    const entry = entries[currentIndex + (args.history === 'back' ? -1 : 1)];
    if (!entry) throw new Error(`There is no ${args.history} entry in this tab's history.`);
    beginNavigation();
    await command(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id }, signal);
  }
  await awaitFrameChange(tabId, before, signal);
  return { navigated: true };
}

export async function action(tabId, expected, tool, args, signal, beginNavigation = () => {}) {
  if (tool === 'browser_evaluate') {
    await assertPage(tabId, expected, signal);
    return evaluateBounded(sendFor(tabId, signal), args.code, {
      uniqueContextId: expected.mainUniqueContextId,
    });
  }
  if (tool === 'browser_click') {
    let point;
    if (args.ref || args.selector)
      point = await invoke(tabId, expected, elementAction, [args, 'point'], signal);
    else {
      if (args.pageId !== expected.pageId) throw new Error('Screenshot page identity is stale.');
      const { cssVisualViewport: view } = await command(tabId, 'Page.getLayoutMetrics', {}, signal);
      if (
        !Number.isFinite(args.x) ||
        !Number.isFinite(args.y) ||
        args.x < 0 ||
        args.y < 0 ||
        args.x >= view.clientWidth ||
        args.y >= view.clientHeight
      )
        throw new Error('Coordinates are outside the viewport.');
      point = { x: args.x, y: args.y };
    }
    await assertPage(tabId, expected, signal);
    beginNavigation();
    await command(
      tabId,
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', ...point, button: 'left', clickCount: 1 },
      signal,
    );
    await command(
      tabId,
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 },
      signal,
    );
    return { clicked: true };
  }
  if (tool === 'browser_fill') {
    // Native value setter plus input and change events, so framework-controlled inputs update.
    await invoke(tabId, expected, elementAction, [args, 'replace'], signal);
    return { filled: true }; // Never echo entered values, including passwords.
  }
  if (tool === 'browser_select' || tool === 'browser_scroll')
    return invoke(
      tabId,
      expected,
      elementAction,
      [args, tool === 'browser_scroll' ? 'scroll' : 'select'],
      signal,
    );
  if (tool === 'browser_type' || tool === 'browser_press') {
    if (args.ref || args.selector)
      await invoke(tabId, expected, elementAction, [args, 'focus'], signal);
    await assertPage(tabId, expected, signal);
    if (tool === 'browser_type') {
      await typeText(sendFor(tabId, signal), args.text);
      return { typed: true };
    }
    beginNavigation();
    await pressKey(sendFor(tabId, signal), args.key);
    return { pressed: args.key };
  }
  if (tool === 'browser_navigate') return navigate(tabId, expected, args, signal, beginNavigation);
  if (tool === 'browser_wait') return invoke(tabId, expected, pageCondition, [args], signal);
  throw new Error('Unknown page operation.');
}
