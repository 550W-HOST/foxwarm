import * as ws from './websocket.js';
import * as storage from './storage.js';
import * as permissions from './permissions.js';
import * as driver from './pageDriver.js';

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message).then(respond, (error) => respond({ error: error.message || 'Request failed.' }));
  return true;
});
async function changed(predicate) {
  permissions.cancelConfirmations(predicate);
  ws.cancelCalls((entry) => entry.tool === 'list_tabs' || predicate(entry));
  for (const tab of await chrome.tabs.query({}))
    if ((await permissions.resolvePermission(tab.id)) === 'off') await driver.detach(tab.id);
  chrome.runtime.sendMessage({ type: 'sharing_changed' }).catch(() => {});
}
async function handle(message) {
  switch (message.type) {
    case 'get_state':
      return ws.getState();
    case 'connect':
      await ws.disconnect();
      await storage.saveConnectionConfig(message.host, message.pairingToken, message.nodeName);
      await ws.connect();
      return { success: true };
    case 'disconnect':
      await ws.disconnect();
      return { success: true };
    case 'reset':
      await ws.resetAndDisconnect();
      return { success: true };
    case 'get_connection': {
      const conn = await storage.getConnection();
      return {
        host: conn.host,
        nodeName: conn.nodeName,
        hasCredentials: !!conn.authToken,
        enabled: conn.enabled,
      };
    }
    case 'get_permissions':
      return storage.getPermissions();
    case 'set_tab_permission':
      await storage.setTabPermission(message.tabId, message.level);
      await changed((entry) => entry.tabId === message.tabId);
      return { success: true };
    case 'remove_tab_permission':
      await storage.removeTabPermission(message.tabId);
      await changed((entry) => entry.tabId === message.tabId);
      return { success: true };
    case 'set_window_permission': {
      await storage.setWindowPermission(message.windowId, message.level);
      const members = new Set(
        (await chrome.tabs.query({ windowId: message.windowId })).map((tab) => tab.id),
      );
      await changed((entry) => entry.windowId === message.windowId || members.has(entry.tabId));
      return { success: true };
    }
    case 'remove_window_permission': {
      await storage.removeWindowPermission(message.windowId);
      const members = new Set(
        (await chrome.tabs.query({ windowId: message.windowId })).map((tab) => tab.id),
      );
      await changed((entry) => entry.windowId === message.windowId || members.has(entry.tabId));
      return { success: true };
    }
    case 'set_domain_permission': {
      await storage.setDomainPermission(message.domain, message.level);
      const members = new Set(
        (await chrome.tabs.query({}))
          .filter((tab) => {
            try {
              const host = new URL(tab.url).hostname;
              return host === message.domain || host.endsWith('.' + message.domain);
            } catch {
              return false;
            }
          })
          .map((tab) => tab.id),
      );
      await changed((entry) => members.has(entry.tabId));
      return { success: true };
    }
    case 'remove_domain_permission': {
      await storage.removeDomainPermission(message.domain);
      const members = new Set(
        (await chrome.tabs.query({}))
          .filter((tab) => {
            try {
              const host = new URL(tab.url).hostname;
              return host === message.domain || host.endsWith('.' + message.domain);
            } catch {
              return false;
            }
          })
          .map((tab) => tab.id),
      );
      await changed((entry) => members.has(entry.tabId));
      return { success: true };
    }
    case 'resolve_permission':
      return { level: await permissions.resolvePermission(message.tabId) };
    case 'confirmation_response':
      return {
        approved: await permissions.respondToConfirmation(message.requestId, message.approved),
      };
    case 'get_pending_confirmations':
      return { confirmations: permissions.getPendingConfirmations() };
    default:
      throw new Error('Unknown popup request.');
  }
}
async function resume() {
  const conn = await storage.getConnection();
  if (conn.enabled && ['disconnected', 'reconnecting'].includes(ws.getState().state))
    await ws.connect().catch(() => {});
}
chrome.alarms.create('foxwarm-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'foxwarm-reconnect') void resume();
});
chrome.runtime.onStartup.addListener(() => {
  void resume();
});
void resume();
function tabChanged(tabId, expectedEffect) {
  ws.cancelCalls(
    (entry) => entry.tabId === tabId && (!expectedEffect || entry.effect !== expectedEffect),
  );
  permissions.cancelConfirmations((entry) => entry.tabId === tabId);
  driver.invalidate(tabId);
  chrome.runtime.sendMessage({ type: 'sharing_changed' }).catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === 'loading') {
    tabChanged(tabId, 'navigation');
    void permissions
      .resolvePermission(tabId)
      .then((level) => {
        if (level === 'off' && !ws.isNavigating(tabId)) return driver.detach(tabId);
      })
      .catch(() => {});
  }
});
chrome.tabs.onDetached.addListener((tabId) => tabChanged(tabId));
chrome.tabs.onAttached.addListener((tabId) => {
  tabChanged(tabId);
  void permissions
    .resolvePermission(tabId)
    .then((level) => {
      if (level === 'off') return driver.detach(tabId);
    })
    .catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabChanged(tabId, 'close');
  void storage.removeTabPermission(tabId);
  void driver.detach(tabId);
});
chrome.windows.onRemoved.addListener((windowId) => {
  permissions.cancelConfirmations((entry) => entry.windowId === windowId);
  void storage.removeWindowPermission(windowId);
});
