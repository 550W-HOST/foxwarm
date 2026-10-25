import * as storage from './storage.js';

export const eligible = (url) => /^https?:\/\//i.test(url || '');
export function permissionForTab(tab, perms) {
  if (!eligible(tab.url)) return 'off';
  const url = new URL(tab.url),
    direct = perms.tabs[tab.id];
  if (direct && (direct.level === 'off' || direct.origin === url.origin)) return direct.level;
  const parts = url.hostname.split('.');
  for (let i = 0; i < Math.max(1, parts.length - 1); i++) {
    const rule = perms.sites[parts.slice(i).join('.')];
    if (rule) return rule;
  }
  return perms.windows[tab.windowId] || 'off';
}
export async function resolvePermission(tabId) {
  const perms = await storage.getPermissions();
  return permissionForTab(await chrome.tabs.get(tabId), perms);
}
export async function windowPermission(windowId) {
  await chrome.windows.get(windowId);
  return (await storage.getPermissions()).windows[windowId] || 'off';
}

const pending = new Map();
function notify() {
  chrome.runtime.sendMessage({ type: 'confirmations_changed' }).catch(() => {});
}
function finish(id, approved) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener('abort', entry.abort);
  chrome.notifications.clear(id).catch(() => {});
  entry.resolve(approved);
  notify();
}
export function cancelConfirmations(predicate = () => true) {
  for (const [id, entry] of pending) if (predicate(entry)) finish(id, false);
}
export function requestConfirmation(info, validate, signal, timeoutMs) {
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const abort = () => finish(requestId, false);
    const timer = setTimeout(abort, Math.max(1, timeoutMs));
    pending.set(requestId, {
      ...info,
      validate,
      signal,
      resolve,
      timer,
      abort,
      createdAt: Date.now(),
    });
    signal.addEventListener('abort', abort, { once: true });
    chrome.notifications
      .create(requestId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `${info.agentName || 'Agent'}: ${info.toolName}`,
        message: `${info.sessionId || 'Session'}\n${info.title || ''}\n${info.url || `Window ${info.windowId}`}\nOpen Foxwarm Browser Node to review.`,
        requireInteraction: true,
      })
      .catch(() => {});
    notify();
  });
}
export async function respondToConfirmation(requestId, approved) {
  const entry = pending.get(requestId);
  if (!entry) return false;
  let valid = false;
  if (approved && !entry.signal.aborted) {
    try {
      await entry.validate();
      valid = true;
    } catch {
      /* stale request */
    }
  }
  if (pending.get(requestId) !== entry || entry.signal.aborted) return false;
  finish(requestId, valid);
  return valid;
}
export function getPendingConfirmations() {
  return [...pending].map(([requestId, entry]) => {
    const { toolName, args, tabId, windowId, title, url, sessionId, agentName, createdAt } = entry;
    return {
      requestId,
      toolName,
      args,
      tabId,
      windowId,
      title,
      url,
      sessionId,
      agentName,
      createdAt,
    };
  });
}
chrome.notifications.onClicked.addListener((id) => {
  if (pending.has(id)) chrome.action.openPopup?.().catch(() => {});
});
chrome.notifications.onClosed.addListener((id, byUser) => {
  if (byUser) finish(id, false);
});
