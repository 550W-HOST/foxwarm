// Firefox's document-targeted WebExtension APIs; no debugger or tab activation.
import { readPage, elementAction, pageCondition } from './pageFunctions.js';
import { buildBrowserScreenshotResult } from './toolResults.js';
const pages = new Map();
export const profile = { variant: 'firefox', windowed: true, keys: false, fullPage: false };
export function setDetachHandler() {} // No debugger attachment to lose in Firefox.
export async function detach(tabId) { pages.delete(tabId); }
export async function detachAll() { pages.clear(); }
export function invalidate(tabId) { pages.delete(tabId); }
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Browser call canceled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function page(tabId, signal) {
  const frame = await abortable(chrome.webNavigation.getFrame({ tabId, frameId: 0 }), signal);
  if (!frame?.documentId) throw new Error('Page context is unavailable. Read the page again.');
  const identity = `${frame.documentId}:${frame.url}`;
  let state = pages.get(tabId);
  if (state?.identity !== identity) {
    state = { identity, documentId: frame.documentId, pageId: crypto.randomUUID(), url: frame.url };
    pages.set(tabId, state);
  }
  return state;
}
export async function assertPage(tabId, expected, signal) {
  const current = await page(tabId, signal);
  if (current.pageId !== expected.pageId)
    throw new Error('Page changed. Read a fresh snapshot or screenshot.');
  return current;
}
function injectionResult(results, expected) {
  const result = results.find((entry) => entry.frameId === 0);
  if (!result || result.documentId !== expected.documentId)
    throw new Error('Page changed. Read a fresh snapshot or screenshot.');
  if (result.error) throw new Error(result.error.message || 'Page operation failed.');
  return result.result;
}
async function invoke(tabId, expected, func, args, signal) {
  await assertPage(tabId, expected, signal);
  const results = await abortable(chrome.scripting.executeScript({
    target: { tabId, documentIds: [expected.documentId] }, func, args,
  }), signal);
  return injectionResult(results, expected);
}
export async function content(tabId, expected, format, signal) {
  return invoke(tabId, expected, readPage, [format, `${expected.pageId}/${crypto.randomUUID()}`], signal);
}
export async function screenshot(tabId, expected, signal) {
  const viewport = await invoke(tabId, expected, () => ({
    width: innerWidth, height: innerHeight, scale: visualViewport?.scale || 1,
    pageX: scrollX, pageY: scrollY,
  }), [], signal);
  await assertPage(tabId, expected, signal);
  const data = await abortable(chrome.tabs.captureTab(tabId, { format: 'png' }), signal);
  await assertPage(tabId, expected, signal);
  return buildBrowserScreenshotResult(data.slice('data:image/png;base64,'.length), {
    tabId, pageId: expected.pageId, url: expected.url, viewport,
  });
}
function coordinateClick(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
    throw new Error('Coordinates are outside the viewport.');
  const el = document.elementFromPoint(x, y);
  if (!el) throw new Error('No element at coordinates.');
  if (el.disabled) throw new Error('Element is disabled.');
  el.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, button: 0, detail: 1,
  }));
  return { clicked: true };
}
async function navigate(tabId, expected, args, signal, beginNavigation) {
  await assertPage(tabId, expected, signal);
  let complete, fail;
  const committed = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const observed = (event) => {
    if (event.tabId === tabId && event.frameId === 0) complete();
  };
  const abort = () => fail(signal.reason || new Error('Browser call canceled.'));
  const events = [
    chrome.webNavigation.onCommitted,
    chrome.webNavigation.onReferenceFragmentUpdated,
    chrome.webNavigation.onHistoryStateUpdated,
  ];
  for (const event of events) event.addListener(observed);
  signal.addEventListener('abort', abort, { once: true });
  try {
    beginNavigation();
    if (args.url) await abortable(chrome.tabs.update(tabId, { url: args.url }), signal);
    else if (args.history === 'reload') await abortable(chrome.tabs.reload(tabId), signal);
    else {
      const move = args.history === 'back' ? chrome.tabs.goBack : chrome.tabs.goForward;
      await abortable(move(tabId), signal).catch(() => {
        throw new Error(`There is no ${args.history} entry in this tab's history.`);
      });
    }
    await committed;
    return { navigated: true };
  } finally {
    for (const event of events) event.removeListener(observed);
    signal.removeEventListener('abort', abort);
    // A rejected update must not leave an unobserved abort rejection.
    committed.catch(() => {});
  }
}
export async function action(tabId, expected, tool, args, signal, beginNavigation = () => {}) {
  if (tool === 'browser_type' || tool === 'browser_press')
    throw new Error('Key input is not supported by Firefox Browser Node.');
  if (tool === 'browser_evaluate') {
    if (!(await chrome.permissions.contains({ permissions: ['userScripts'] })))
      throw new Error('Allow page JavaScript in the Browser Node extension to enable browser_evaluate.');
    await assertPage(tabId, expected, signal);
    // The browser compiles this source directly in MAIN; no eval/Function or CSP change.
    const results = await abortable(chrome.userScripts.execute({
      target: { tabId, documentIds: [expected.documentId] },
      world: 'MAIN', js: [{ code: args.code }],
    }), signal);
    if (results.some((entry) => entry.error)) throw new Error('JavaScript evaluation failed.');
    const value = injectionResult(results, expected);
    if (typeof value === 'string')
      return { result: value.slice(0, 100000), truncated: value.length > 100000 };
    try {
      const text = JSON.stringify(value);
      if (typeof text !== 'string') return { result: null, truncated: false };
      return text.length > 100000
        ? { result: text.slice(0, 100000), truncated: true }
        : { result: value, truncated: false };
    } catch { return { result: '[Unserializable result]', truncated: false }; }
  }
  if (tool === 'browser_navigate') return navigate(tabId, expected, args, signal, beginNavigation);
  if (tool === 'browser_click') {
    if (!args.ref && !args.selector && args.pageId !== expected.pageId)
      throw new Error('Screenshot page identity is stale.');
    await assertPage(tabId, expected, signal);
    beginNavigation();
    return args.ref || args.selector
      ? invoke(tabId, expected, elementAction, [args, 'click'], signal)
      : invoke(tabId, expected, coordinateClick, [args.x, args.y], signal);
  }
  if (tool === 'browser_fill') return invoke(tabId, expected, elementAction, [args, 'replace'], signal);
  if (tool === 'browser_select' || tool === 'browser_scroll')
    return invoke(tabId, expected, elementAction, [args, tool === 'browser_scroll' ? 'scroll' : 'select'], signal);
  if (tool === 'browser_wait') return invoke(tabId, expected, pageCondition, [args], signal);
  throw new Error('Unknown page operation.');
}
