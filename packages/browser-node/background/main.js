/**
 * Background service worker entry point
 * Handles message routing between popup, content scripts, and WebSocket
 */

import * as wsManager from './websocket.js';
import * as storage from './storage.js';
import * as permissions from './permissions.js';

// ─── Message handler for popup and content scripts ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate async response
  handleMessage(message, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message || String(err) });
  });
  return true; // Keep the message channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    // ─── Connection management ───
    case 'get_state':
      return wsManager.getState();

    case 'connect': {
      const { host, pairingToken, nodeName } = message;
      await storage.saveConnectionConfig(host, pairingToken, nodeName);
      await wsManager.connect();
      return { success: true };
    }

    case 'disconnect':
      wsManager.disconnect();
      return { success: true };

    case 'reset':
      await wsManager.resetAndDisconnect();
      return { success: true };

    case 'get_connection':
      return await storage.getConnection();

    // ─── Permission management ───
    case 'get_permissions':
      return await storage.getPermissions();

    case 'set_domain_permission':
      await storage.setDomainPermission(message.domain, message.level);
      return { success: true };

    case 'set_tab_permission':
      await storage.setTabPermission(message.tabId, message.level);
      return { success: true };

    case 'set_default_permission':
      await storage.setDefaultPermission(message.level);
      return { success: true };

    case 'remove_domain_permission':
      await storage.removeDomainPermission(message.domain);
      return { success: true };

    case 'remove_tab_permission':
      await storage.removeTabPermission(message.tabId);
      return { success: true };

    case 'resolve_permission': {
      const level = await permissions.resolvePermission(message.tabId, message.tabUrl);
      return { level };
    }

    // ─── Confirmation responses ───
    case 'confirmation_response':
      permissions.respondToConfirmation(message.requestId, message.approved);
      return { success: true };

    case 'get_pending_confirmations':
      return { confirmations: permissions.getPendingConfirmations() };

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

// ─── Service Worker keepalive ───
// MV3 service workers are terminated after ~30s of inactivity.
// Strategy 1: chrome.alarms to periodically wake and reconnect if needed.
// Strategy 2: While WS is connected, keep a self-referencing port alive
//             to prevent the service worker from being terminated.

const KEEPALIVE_ALARM = 'foxwarm-keepalive';

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); // 30s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    const state = wsManager.getState();
    if (state.state === 'disconnected' || state.state === 'reconnecting') {
      autoConnect();
    }
  }
});

// Keep service worker alive while WebSocket is active by maintaining a port
let keepAlivePort = null;

function startKeepAlive() {
  if (keepAlivePort) return;
  // Connect to ourselves — this keeps the service worker alive as long as the port is open
  keepAlivePort = chrome.runtime.connect({ name: 'keepalive' });
  keepAlivePort.onDisconnect.addListener(() => {
    keepAlivePort = null;
    // Re-establish if still connected
    const state = wsManager.getState();
    if (state.state === 'registered' || state.state === 'connected' ||
        state.state === 'pair_pending' || state.state === 'pair_approved') {
      setTimeout(startKeepAlive, 0);
    }
  });
}

function stopKeepAlive() {
  if (keepAlivePort) {
    keepAlivePort.disconnect();
    keepAlivePort = null;
  }
}

// Listen for keepalive port connections (from ourselves)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    // Just hold the port open — nothing to do
    port.onDisconnect.addListener(() => {});
  }
});

// Hook into wsManager state changes to start/stop keepalive
wsManager.onStateChange((state) => {
  if (state === 'registered' || state === 'connected' ||
      state === 'pair_pending' || state === 'pair_approved' ||
      state === 'connecting' || state === 'reconnecting') {
    startKeepAlive();
  } else if (state === 'disconnected') {
    stopKeepAlive();
  }
});

// ─── Auto-connect on startup if credentials exist ───

async function autoConnect() {
  const conn = await storage.getConnection();
  if (conn.host && (conn.authToken || conn.pairingToken)) {
    console.log('[foxwarm-node] Auto-connecting on startup...');
    try {
      await wsManager.connect();
    } catch (e) {
      console.error('[foxwarm-node] Auto-connect failed:', e);
    }
  }
}

// Service worker activation
chrome.runtime.onInstalled.addListener(() => {
  console.log('[foxwarm-node] Extension installed');
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[foxwarm-node] Browser started');
  autoConnect();
});

// Also try to connect when the service worker wakes up
autoConnect();

// Clean up tab-specific permissions when tabs are closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await storage.removeTabPermission(tabId);
});
