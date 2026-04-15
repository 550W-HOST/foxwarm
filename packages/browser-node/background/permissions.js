/**
 * Permission engine — resolve permission level for a tab and handle ask-mode confirmation
 */

import * as storage from './storage.js';

/**
 * Extract the effective domain from a URL (e.g. "mail.google.com" → "google.com" for matching,
 * but we store the full hostname so users can be precise).
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Resolve permission level for a given tab.
 * Priority: tab-specific → domain → default
 */
export async function resolvePermission(tabId, tabUrl) {
  const perms = await storage.getPermissions();

  // 1. Tab-specific override
  const tabLevel = perms.tabs?.[String(tabId)];
  if (tabLevel) return tabLevel;

  // 2. Domain match (exact hostname, then parent domains)
  if (tabUrl) {
    const hostname = extractDomain(tabUrl);
    if (hostname && perms.domains) {
      // Exact match first
      if (perms.domains[hostname]) return perms.domains[hostname];
      // Walk up parent domains: "a.b.c.com" → "b.c.com" → "c.com"
      const parts = hostname.split('.');
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (perms.domains[parent]) return perms.domains[parent];
      }
    }
  }

  // 3. Default
  return perms.default || 'ask';
}

/**
 * Check if a tab is visible to the agent (permission != 'off')
 */
export async function isTabVisible(tabId, tabUrl) {
  const level = await resolvePermission(tabId, tabUrl);
  return level !== 'off';
}

/**
 * Pending confirmation requests (for ask mode)
 * Map<requestId, { resolve, reject, timer, toolName, args }>
 */
const pendingConfirmations = new Map();
let confirmationCounter = 0;

/**
 * Request user confirmation for a tool call.
 * Returns a promise that resolves to true (approved) or rejects/returns false (denied/timeout).
 */
export function requestConfirmation(toolName, args, tabId, timeoutMs = 60000) {
  const requestId = `confirm_${++confirmationCounter}_${Date.now()}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(requestId);
      resolve(false);
    }, timeoutMs);

    pendingConfirmations.set(requestId, {
      resolve,
      reject,
      timer,
      toolName,
      args,
      tabId,
      createdAt: Date.now(),
    });

    // Send notification (buttons may not be supported on all platforms)
    const argsPreview = JSON.stringify(args).slice(0, 200);
    try {
      chrome.notifications.create(requestId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `Foxwarm: ${toolName}`,
        message: `Tool call requires confirmation. Click to open popup.\nTab: ${tabId}\nArgs: ${argsPreview}`,
        requireInteraction: true,
        priority: 2,
      });
    } catch (e) {
      console.warn('[foxwarm-node] Failed to create notification:', e);
    }

    // Also broadcast to popup if open
    chrome.runtime.sendMessage({
      type: 'confirmation_request',
      requestId,
      toolName,
      args,
      tabId,
    }).catch(() => { /* popup not open */ });
  });
}

/**
 * Respond to a pending confirmation
 */
export function respondToConfirmation(requestId, approved) {
  const pending = pendingConfirmations.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingConfirmations.delete(requestId);
  pending.resolve(approved);

  // Clear notification
  chrome.notifications.clear(requestId);
  return true;
}

/**
 * Get all pending confirmations (for popup to display)
 */
export function getPendingConfirmations() {
  const result = [];
  for (const [requestId, data] of pendingConfirmations) {
    result.push({
      requestId,
      toolName: data.toolName,
      args: data.args,
      tabId: data.tabId,
      createdAt: data.createdAt,
    });
  }
  return result;
}

// Handle notification button clicks (if supported on the platform)
try {
  chrome.notifications.onButtonClicked?.addListener((notificationId, buttonIndex) => {
    if (pendingConfirmations.has(notificationId)) {
      respondToConfirmation(notificationId, buttonIndex === 0);
    }
  });
} catch { /* not supported */ }

// Handle notification clicked — open popup for confirmation
chrome.notifications.onClicked.addListener((notificationId) => {
  if (pendingConfirmations.has(notificationId)) {
    // Opening the popup programmatically isn't possible in MV3,
    // but the notification click brings attention to the extension
    chrome.action.openPopup?.().catch(() => { /* not supported in all contexts */ });
  }
});

// Handle notification closed (treat as deny)
chrome.notifications.onClosed.addListener((notificationId, byUser) => {
  if (byUser && pendingConfirmations.has(notificationId)) {
    respondToConfirmation(notificationId, false);
  }
});
