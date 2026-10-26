import {
  permissionForTab,
  resolvePermission,
  windowPermission,
  requestConfirmation,
} from './permissions.js';
import * as storage from './storage.js';
import * as driver from './pageDriver.js';

const lanes = new Map();
function ordered(key, run, signal) {
  const previous = lanes.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  lanes.set(key, next);
  next
    .finally(() => {
      if (lanes.get(key) === next) lanes.delete(key);
    })
    .catch(() => {});
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Browser call canceled.'));
    signal.addEventListener('abort', abort, { once: true });
    next.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
function httpUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Only HTTP and HTTPS pages are supported.');
  return parsed.href;
}
function targetArgs(args, required = false) {
  if (args.ref && args.selector) throw new Error('Choose ref or selector, not both.');
  if (required && !args.ref && !args.selector) throw new Error('Supply ref or selector.');
}
function validateArgs(name, args) {
  if (name !== 'list_tabs' && name !== 'open_tab' && !Number.isInteger(args.tabId))
    throw new Error('Supply a browser tab ID.');
  if (['fill', 'select_option', 'click', 'scroll', 'press_key'].includes(name))
    targetArgs(args, ['fill', 'select_option'].includes(name));
  if (name === 'fill' && (typeof args.text !== 'string' || args.text.length > 100000))
    throw new Error('Supply at most 100000 characters.');
  if (
    name === 'select_option' &&
    (!Array.isArray(args.values) || !args.values.every((value) => typeof value === 'string'))
  )
    throw new Error('Supply option values.');
  if (name === 'execute_js' && (typeof args.code !== 'string' || args.code.length > 100000))
    throw new Error('Supply JavaScript of at most 100000 characters.');
  if (
    name === 'scroll' &&
    [args.deltaX ?? 0, args.deltaY ?? 0].some((value) => !Number.isFinite(value))
  )
    throw new Error('Supply finite scroll distances.');
  if (name === 'click' && !!(args.ref || args.selector) === (args.x != null || args.y != null))
    throw new Error('Choose an element or screenshot coordinates.');
  if (
    name === 'get_tab_content' &&
    !['snapshot', 'text', 'html'].includes(args.format || 'snapshot')
  )
    throw new Error('Choose snapshot, text, or html.');
  if (name === 'wait_for') {
    if (!['element', 'text', 'url'].includes(args.condition))
      throw new Error('Choose element, text, or url condition.');
    if (
      args.condition === 'element' &&
      (typeof args.selector !== 'string' ||
        !['visible', 'hidden', 'attached'].includes(args.state || 'visible'))
    )
      throw new Error('Supply a selector and supported element state.');
    if (
      (args.condition === 'text' && typeof args.text !== 'string') ||
      (args.condition === 'url' && typeof args.url !== 'string')
    )
      throw new Error('Supply the expected condition value.');
    if (
      args.timeoutMs !== undefined &&
      (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 60000)
    )
      throw new Error('Timeout must be between 1 and 60000 milliseconds.');
  }
  if (name === 'navigate' || name === 'open_tab') args.url = httpUrl(args.url);
}
export async function executeTool(name, args, context) {
  if (name === 'press_key' && !driver.supportsEditingKeys)
    throw new Error('Editing-key input is not supported by Firefox Browser Node.');
  validateArgs(name, args);
  const { signal } = context;
  const checkActive = () => {
    signal.throwIfAborted();
    if (Date.now() >= context.deadline) throw new Error('Browser call deadline expired.');
  };
  checkActive();
  if (name === 'list_tabs') {
    const perms = await storage.getPermissions();
    checkActive();
    // This is the final asynchronous observation. Authorize exactly the Tab data
    // being released, never an earlier query object against an ID's later page.
    const observed = await chrome.tabs.query({});
    checkActive();
    return {
      tabs: observed.flatMap((tab) => {
        const sharing = permissionForTab(tab, perms);
        return sharing === 'off'
          ? []
          : [
              {
                tabId: tab.id,
                windowId: tab.windowId,
                title: tab.title || '',
                url: tab.url,
                sharing,
                windowSharing: perms.windows[tab.windowId] || 'off',
              },
            ];
      }),
    };
  }
  // Capture the actual document before the operation waits behind another call.
  const admissionTab = name === 'open_tab' ? null : await chrome.tabs.get(args.tabId);
  const admissionDocument = admissionTab
    ? await chrome.webNavigation.getFrame({ tabId: args.tabId, frameId: 0 })
    : null;
  const validateAdmission = async () => {
    checkActive();
    if (!admissionTab) return;
    const current = await chrome.tabs.get(args.tabId);
    const document = await chrome.webNavigation.getFrame({ tabId: args.tabId, frameId: 0 });
    if (
      !document ||
      document.documentId !== admissionDocument?.documentId ||
      document.url !== admissionDocument?.url ||
      current.windowId !== admissionTab.windowId ||
      (await resolvePermission(args.tabId)) === 'off'
    )
      throw new Error('Page or sharing changed while the call was waiting.');
  };
  await validateAdmission();
  return ordered(
    name === 'open_tab' ? `window:${args.windowId}` : args.tabId,
    async () => {
      checkActive();
      if (name === 'open_tab') {
        if (!Number.isInteger(args.windowId)) throw new Error('Supply a shared window ID.');
        const validate = async () => {
          checkActive();
          if ((await windowPermission(args.windowId)) === 'off')
            throw new Error('Window is not shared.');
        };
        await validate();
        if ((await windowPermission(args.windowId)) === 'ask') {
          if (
            !(await requestConfirmation(
              { ...context, toolName: name, args, windowId: args.windowId, url: args.url },
              validate,
              signal,
              context.deadline - Date.now(),
            ))
          )
            throw new Error('Request denied, canceled, or expired.');
        }
        await validate();
        const tab = await chrome.tabs.create({
          windowId: args.windowId,
          url: args.url,
          active: false,
        });
        checkActive();
        const sharing = await resolvePermission(tab.id);
        return {
          tabId: tab.id,
          windowId: tab.windowId,
          sharing,
          ...(sharing !== 'off' ? { url: tab.url || args.url, title: tab.title || '' } : {}),
        };
      }
      await validateAdmission();
      const tab = await chrome.tabs.get(args.tabId);
      if ((await resolvePermission(tab.id)) === 'off') throw new Error('Tab is not shared.');
      const expected = await driver.page(tab.id, signal);
      const validate = async () => {
        await validateAdmission();
        const current = await chrome.tabs.get(tab.id);
        if (current.windowId !== tab.windowId || (await resolvePermission(tab.id)) === 'off')
          throw new Error('Sharing changed.');
        await driver.assertPage(tab.id, expected, signal);
      };
      if (args.ref && !args.ref.startsWith(expected.pageId + '/'))
        throw new Error('Element reference is stale. Read a fresh snapshot.');
      if ((await resolvePermission(tab.id)) === 'ask') {
        const preview = name === 'fill' ? { ...args, text: '[hidden]' } : args;
        const approved = await requestConfirmation(
          {
            ...context,
            toolName: name,
            args: preview,
            tabId: tab.id,
            windowId: tab.windowId,
            title: tab.title,
            url: tab.url,
          },
          validate,
          signal,
          context.deadline - Date.now(),
        );
        if (!approved) throw new Error('Request denied, canceled, or expired.');
      }
      await validate();
      let navigationEffect = false;
      const beginNavigation = () => {
        checkActive();
        navigationEffect = true;
        context.beginEffect?.('navigation');
      };
      let result;
      if (name === 'get_tab_content')
        result = await driver.content(tab.id, expected, args.format || 'snapshot', signal);
      else if (name === 'screenshot') result = await driver.screenshot(tab.id, expected, signal);
      else if (name === 'close_tab') {
        context.beginEffect?.('close');
        await chrome.tabs.remove(tab.id);
        checkActive();
        return { closed: true, tabId: tab.id };
      } else if (name === 'wait_for') {
        const end = Math.min(context.deadline, Date.now() + (args.timeoutMs || 10000));
        while (true) {
          await validate();
          if (await driver.action(tab.id, expected, name, args, signal)) {
            result = { matched: true };
            break;
          }
          if (Date.now() >= end) {
            result = { matched: false, reason: 'timeout' };
            break;
          }
          await pause(Math.min(100, end - Date.now()), signal);
        }
      } else result = await driver.action(tab.id, expected, name, args, signal, beginNavigation);
      if (name === 'navigate') {
        // Navigation may intentionally leave the shared origin; release no unshared metadata.
        checkActive();
        if ((await resolvePermission(tab.id)) === 'off') {
          await driver.detach(tab.id);
          return { tabId: tab.id, sharing: 'off' };
        }
        const currentPage = await driver.page(tab.id, signal);
        const perms = await storage.getPermissions();
        const currentTab = await chrome.tabs.get(tab.id);
        checkActive();
        if (currentTab.windowId !== tab.windowId)
          throw new Error('Tab moved during navigation; its outcome may have occurred.');
        const sharing = permissionForTab(currentTab, perms);
        if (sharing === 'off') {
          await driver.detach(tab.id);
          return { tabId: tab.id, sharing };
        }
        if (currentTab.url !== currentPage.url)
          throw new Error(
            'Navigation completed, but the page changed before its identity could be reported.',
          );
        return { tabId: tab.id, pageId: currentPage.pageId, url: currentTab.url, sharing };
      }
      if (navigationEffect) {
        checkActive();
        const current = await chrome.tabs.get(tab.id);
        if (current.windowId !== tab.windowId)
          throw new Error('Tab moved during the page action; its outcome may have occurred.');
        // Successful native input has already been accepted. Its boolean outcome
        // contains no old-document data; following a link must not fail because
        // the intended navigation committed between asynchronous observations.
        const sharing = await resolvePermission(tab.id);
        checkActive();
        return { ...result, tabId: tab.id, sharing };
      }
      await validate();
      return { ...result, tabId: tab.id };
    },
    signal,
  );
}

// Tool definitions exposed by this Browser Node.
const descriptions = {
  list_tabs:
    'List shared browser tabs with their titles, URLs, window IDs, and effective sharing modes.',
  get_tab_content:
    'Read a shared browser tab as a DOM snapshot, visible text, or HTML. Snapshots include element references for subsequent actions; password values are omitted.',
  screenshot:
    'Capture the visible page viewport of a shared browser tab without activating it. Returns an image and its page and viewport information.',
  click:
    'Click an element in a shared browser tab using a snapshot reference, a unique CSS selector, or viewport coordinates from a screenshot.',
  fill: "Replace text in a shared browser tab's text, search, email, URL, telephone, password, or number input, textarea, or contenteditable element. Use a snapshot reference or a unique CSS selector.",
  select_option:
    'Select options in a native HTML select element by value. Use a snapshot reference or a unique CSS selector.',
  scroll:
    'Scroll a shared browser page or a specified scrollable element by a distance in CSS pixels.',
  navigate:
    'Navigate a shared browser tab to an HTTP or HTTPS URL and report its sharing status. Page identity and URL are returned while the destination remains shared.',
  wait_for:
    'Wait for a page condition in a shared browser tab, within a bounded timeout. Returns when the condition is met or reports why waiting ended.',
  press_key: 'Send a supported editing key to a shared browser page or a specified element.',
  execute_js:
    "Evaluate JavaScript in a shared browser tab's page context and return a bounded result. Promises are awaited, and the tab's Ask or Auto sharing mode applies.",
  open_tab:
    'Open an HTTP or HTTPS URL in a shared browser window without activating the new tab. The new tab follows the window and site sharing rules.',
  close_tab: 'Close a shared browser tab. Closing the last tab also closes its window.',
};
const field = (type, description, rest = {}) => ({ type, description, ...rest });
const tabId = field('integer', 'Browser tab ID returned by list_tabs or open_tab.');
const target = {
  ref: field('string', 'Element reference from the latest DOM snapshot of this page.'),
  selector: field(
    'string',
    'CSS selector that must match exactly one element in the current page.',
  ),
};
const url = field('string', 'HTTP or HTTPS URL to open.');
const schemas = {
  list_tabs: [{}, []],
  get_tab_content: [
    {
      tabId,
      format: field(
        'string',
        'Content format: snapshot returns DOM elements and action references, text returns visible text, and html returns bounded HTML. Defaults to snapshot.',
        { enum: ['snapshot', 'text', 'html'] },
      ),
    },
    ['tabId'],
  ],
  screenshot: [{ tabId }, ['tabId']],
  click: [
    {
      tabId,
      ...target,
      x: field(
        'number',
        "Horizontal position in viewport CSS pixels from the screenshot's viewport information.",
      ),
      y: field(
        'number',
        "Vertical position in viewport CSS pixels from the screenshot's viewport information.",
      ),
      pageId: field(
        'string',
        'Page identity returned by screenshot. Required when clicking by coordinates.',
      ),
    },
    ['tabId'],
  ],
  fill: [
    {
      tabId,
      ...target,
      text: field('string', "Text that replaces the element's current contents."),
    },
    ['tabId', 'text'],
  ],
  select_option: [
    {
      tabId,
      ...target,
      values: field(
        'array',
        'Option values to select. Supply one value for a single-select element.',
        { items: { type: 'string' } },
      ),
    },
    ['tabId', 'values'],
  ],
  scroll: [
    {
      tabId,
      ...target,
      deltaX: field(
        'number',
        'Horizontal scroll distance in CSS pixels; positive values scroll right. Defaults to 0.',
      ),
      deltaY: field(
        'number',
        'Vertical scroll distance in CSS pixels; positive values scroll down. Defaults to 0.',
      ),
    },
    ['tabId'],
  ],
  navigate: [{ tabId, url }, ['tabId', 'url']],
  wait_for: [
    {
      tabId,
      condition: field('string', 'Page condition to wait for.', {
        enum: ['element', 'text', 'url'],
      }),
      state: field('string', 'Required element state.', {
        enum: ['visible', 'hidden', 'attached'],
      }),
      selector: field('string', 'CSS selector identifying the element to observe.'),
      text: field('string', 'Visible text that must appear on the page.'),
      url: field('string', 'Expected page URL.'),
      timeoutMs: field(
        'number',
        'Maximum time to wait in milliseconds, bounded by the remaining tool-call time.',
        { minimum: 1, maximum: 60000 },
      ),
    },
    ['tabId', 'condition'],
  ],
  press_key: [
    {
      tabId,
      ...target,
      key: field('string', 'Editing key to send, selected from the supported values.', {
        enum: [
          'Enter',
          'Tab',
          'Escape',
          'Backspace',
          'Delete',
          'ArrowLeft',
          'ArrowUp',
          'ArrowRight',
          'ArrowDown',
          'Home',
          'End',
        ],
      }),
    },
    ['tabId', 'key'],
  ],
  execute_js: [
    {
      tabId,
      code: field('string', 'JavaScript expression or code to evaluate in the page context.'),
    },
    ['tabId', 'code'],
  ],
  open_tab: [
    { windowId: field('integer', 'Shared browser window ID returned by list_tabs.'), url },
    ['windowId', 'url'],
  ],
  close_tab: [{ tabId }, ['tabId']],
};
export const TOOL_DEFINITIONS = Object.entries(schemas)
  .filter(([name]) => name !== 'press_key' || driver.supportsEditingKeys)
  .map(([name, [properties, required]]) => ({
    name,
    description: driver.descriptionOverrides[name] || descriptions[name],
    parameters: { type: 'object', properties, required, additionalProperties: false },
  }));
