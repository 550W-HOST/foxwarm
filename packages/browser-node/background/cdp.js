// One attached, top-document CDP adapter. No tab activation or alternate page driver.
import { readPage, elementAction, pageCondition } from './pageFunctions.js';
import { buildBrowserScreenshotResult } from './toolResults.js';
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
export async function action(tabId, expected, tool, args, signal, beginNavigation = () => {}) {
  if (tool === 'execute_js') {
    await assertPage(tabId, expected, signal);
    const response = await command(
      tabId,
      'Runtime.evaluate',
      {
        expression: args.code,
        uniqueContextId: expected.mainUniqueContextId,
        awaitPromise: true,
        returnByValue: false,
        allowUnsafeEvalBlockedByCSP: true,
      },
      signal,
    );
    if (response.exceptionDetails) throw new Error('JavaScript evaluation failed.');
    const value = response.result;
    if (!value.objectId) {
      const primitive = value.value ?? value.unserializableValue ?? null;
      return {
        result: typeof primitive === 'string' ? primitive.slice(0, 100000) : primitive,
        truncated: typeof primitive === 'string' && primitive.length > 100000,
      };
    }
    try {
      const bounded = await command(
        tabId,
        'Runtime.callFunctionOn',
        {
          objectId: value.objectId,
          functionDeclaration:
            'function() { try { const text = JSON.stringify(this); return { text: String(text).slice(0, 100000), truncated: String(text).length > 100000 }; } catch { return { text: "[Unserializable result]", truncated: false }; } }',
          returnByValue: true,
        },
        signal,
      );
      const result = bounded.result.value;
      return {
        result: result.truncated
          ? result.text
          : (() => {
              try {
                return JSON.parse(result.text);
              } catch {
                return result.text;
              }
            })(),
        truncated: result.truncated,
      };
    } finally {
      chrome.debugger
        .sendCommand({ tabId }, 'Runtime.releaseObject', { objectId: value.objectId })
        .catch(() => {});
    }
  }
  if (tool === 'click') {
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
  if (tool === 'fill') {
    await invoke(tabId, expected, elementAction, [args, 'fill'], signal);
    await assertPage(tabId, expected, signal);
    await command(tabId, 'Input.insertText', { text: args.text }, signal);
    return { filled: true }; // Never echo entered values, including passwords.
  }
  if (tool === 'select_option' || tool === 'scroll')
    return invoke(
      tabId,
      expected,
      elementAction,
      [args, tool === 'scroll' ? 'scroll' : 'select'],
      signal,
    );
  if (tool === 'press_key') {
    if (args.ref || args.selector)
      await invoke(tabId, expected, elementAction, [args, 'focus'], signal);
    const keys = {
      Enter: ['Enter', 13],
      Tab: ['Tab', 9],
      Escape: ['Escape', 27],
      Backspace: ['Backspace', 8],
      Delete: ['Delete', 46],
      ArrowLeft: ['ArrowLeft', 37],
      ArrowUp: ['ArrowUp', 38],
      ArrowRight: ['ArrowRight', 39],
      ArrowDown: ['ArrowDown', 40],
      Home: ['Home', 36],
      End: ['End', 35],
    };
    const key = keys[args.key];
    if (!key) throw new Error('Unsupported editing key.');
    await assertPage(tabId, expected, signal);
    beginNavigation();
    await command(
      tabId,
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: key[0],
        code: key[0],
        windowsVirtualKeyCode: key[1],
        ...(args.key === 'Enter' ? { text: '\r' } : {}),
      },
      signal,
    );
    await command(
      tabId,
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: key[0], code: key[0], windowsVirtualKeyCode: key[1] },
      signal,
    );
    return { pressed: args.key };
  }
  if (tool === 'navigate') {
    await assertPage(tabId, expected, signal);
    beginNavigation();
    const response = await command(tabId, 'Page.navigate', { url: args.url }, signal);
    if (response.errorText) throw new Error('Navigation failed: ' + response.errorText);
    while (true) {
      const { frameTree } = await command(tabId, 'Page.getFrameTree', {}, signal);
      if (
        response.loaderId
          ? frameTree.frame.loaderId === response.loaderId
          : frameTree.frame.url === args.url
      )
        break;
      await abortable(new Promise((resolve) => setTimeout(resolve, 50)), signal);
    }
    return { navigated: true };
  }
  if (tool === 'wait_for') return invoke(tabId, expected, pageCondition, [args], signal);
  throw new Error('Unknown page operation.');
}
