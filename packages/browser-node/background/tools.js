import {
  permissionForTab,
  resolvePermission,
  windowPermission,
  requestConfirmation,
} from './permissions.js';
import * as storage from './storage.js';
import * as driver from './pageDriver.js';
import { toolDefinitions, validateArgs } from './contract.js';

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
// After accepted input, give a navigation a moment to start, then to finish loading.
async function settleNavigation(tabId, before, signal) {
  const moved = async () => {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return !!frame && (frame.documentId !== before?.documentId || frame.url !== before?.url);
  };
  const quietEnd = Date.now() + 300;
  let changed = await moved();
  while (!changed && Date.now() < quietEnd) {
    await pause(50, signal);
    changed = await moved();
  }
  if (!changed) return false;
  const loadEnd = Date.now() + 3000;
  while (Date.now() < loadEnd && (await chrome.tabs.get(tabId)).status !== 'complete')
    await pause(100, signal);
  return true;
}
export async function executeTool(name, input, context) {
  if (['browser_type', 'browser_press'].includes(name) && !driver.profile.keys)
    throw new Error('Key input is not supported by Firefox Browser Node.');
  const args = validateArgs(name, input, driver.profile);
  const { signal } = context;
  const checkActive = () => {
    signal.throwIfAborted();
    if (Date.now() >= context.deadline) throw new Error('Browser call deadline expired.');
  };
  checkActive();
  if (name === 'browser_tabs') {
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
  const admissionTab = name === 'browser_open' ? null : await chrome.tabs.get(args.tabId);
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
    name === 'browser_open' ? `window:${args.windowId}` : args.tabId,
    async () => {
      checkActive();
      if (name === 'browser_open') {
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
        const preview = ['browser_fill', 'browser_type'].includes(name) ? { ...args, text: '[hidden]' } : args;
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
      if (name === 'browser_read')
        result = await driver.content(tab.id, expected, args.format || 'snapshot', signal);
      else if (name === 'browser_screenshot') result = await driver.screenshot(tab.id, expected, signal);
      else if (name === 'browser_close') {
        context.beginEffect?.('close');
        await chrome.tabs.remove(tab.id);
        checkActive();
        return { closed: true, tabId: tab.id };
      } else if (name === 'browser_wait') {
        const end = Math.min(context.deadline, Date.now() + (args.timeoutMs || 10000));
        const condition = { ...args, state: args.state || 'visible' };
        while (true) {
          await validate();
          if (await driver.action(tab.id, expected, name, condition, signal)) {
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
      if (name === 'browser_navigate') {
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
        return {
          tabId: tab.id,
          pageId: currentPage.pageId,
          url: currentTab.url,
          title: currentTab.title || '',
          navigated: true,
          sharing,
        };
      }
      if (navigationEffect) {
        checkActive();
        const current = await chrome.tabs.get(tab.id);
        if (current.windowId !== tab.windowId)
          throw new Error('Tab moved during the page action; its outcome may have occurred.');
        // Successful native input has already been accepted. Its boolean outcome
        // contains no old-document data; following a link must not fail because
        // the intended navigation committed between asynchronous observations.
        const navigated = await settleNavigation(tab.id, admissionDocument, signal);
        const sharing = await resolvePermission(tab.id);
        checkActive();
        // An unshared destination releases no metadata, only that the page was left.
        if (sharing === 'off') return { ...result, tabId: tab.id, navigated, sharing };
        const settled = await chrome.tabs.get(tab.id);
        return {
          ...result,
          tabId: tab.id,
          url: settled.url,
          title: settled.title || '',
          navigated,
          sharing,
        };
      }
      await validate();
      const current = await chrome.tabs.get(tab.id);
      return { ...result, tabId: tab.id, url: current.url, title: current.title || '', navigated: false };
    },
    signal,
  );
}

// Tool definitions exposed by this Browser Node: the shared contract for this browser's profile.
export const TOOL_DEFINITIONS = toolDefinitions(driver.profile);
