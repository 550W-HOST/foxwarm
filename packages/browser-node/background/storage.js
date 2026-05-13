/**
 * Storage helpers — thin wrapper around chrome.storage.local
 */

const STORAGE_KEYS = {
  HOST: 'host',
  PAIRING_TOKEN: 'pairingToken',
  NODE_ID: 'nodeId',
  AUTH_TOKEN: 'authToken',
  PAIRED_AT: 'pairedAt',
  PERMISSIONS: 'permissions',
  NODE_NAME: 'nodeName',
};

const DEFAULT_PERMISSIONS = {
  default: 'ask',
  domains: {},
  tabs: {},
};

export async function getAll() {
  return chrome.storage.local.get(null);
}

export async function getConnection() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.HOST,
    STORAGE_KEYS.PAIRING_TOKEN,
    STORAGE_KEYS.NODE_ID,
    STORAGE_KEYS.AUTH_TOKEN,
    STORAGE_KEYS.PAIRED_AT,
    STORAGE_KEYS.NODE_NAME,
  ]);
  return {
    host: data[STORAGE_KEYS.HOST] || '',
    pairingToken: data[STORAGE_KEYS.PAIRING_TOKEN] || '',
    nodeId: data[STORAGE_KEYS.NODE_ID] || '',
    authToken: data[STORAGE_KEYS.AUTH_TOKEN] || '',
    pairedAt: data[STORAGE_KEYS.PAIRED_AT] || 0,
    nodeName: data[STORAGE_KEYS.NODE_NAME] || '',
  };
}

export async function saveConnectionConfig(host, pairingToken, nodeName) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.HOST]: host,
    [STORAGE_KEYS.PAIRING_TOKEN]: pairingToken,
    [STORAGE_KEYS.NODE_NAME]: nodeName || '',
  });
}

export async function saveCredentials(nodeId, authToken) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.NODE_ID]: nodeId,
    [STORAGE_KEYS.AUTH_TOKEN]: authToken,
    [STORAGE_KEYS.PAIRED_AT]: Date.now(),
  });
}

export async function clearCredentials() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.NODE_ID,
    STORAGE_KEYS.AUTH_TOKEN,
    STORAGE_KEYS.PAIRED_AT,
  ]);
}

export async function getPermissions() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PERMISSIONS);
  return data[STORAGE_KEYS.PERMISSIONS] || { ...DEFAULT_PERMISSIONS };
}

export async function savePermissions(permissions) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.PERMISSIONS]: permissions,
  });
}

export async function setDomainPermission(domain, level) {
  const perms = await getPermissions();
  if (!perms.domains) perms.domains = {};
  perms.domains[domain] = level;
  await savePermissions(perms);
}

export async function setTabPermission(tabId, level) {
  const perms = await getPermissions();
  if (!perms.tabs) perms.tabs = {};
  perms.tabs[String(tabId)] = level;
  await savePermissions(perms);
}

export async function setDefaultPermission(level) {
  const perms = await getPermissions();
  perms.default = level;
  await savePermissions(perms);
}

export async function removeDomainPermission(domain) {
  const perms = await getPermissions();
  if (perms.domains) {
    delete perms.domains[domain];
    await savePermissions(perms);
  }
}

export async function removeTabPermission(tabId) {
  const perms = await getPermissions();
  if (perms.tabs) {
    delete perms.tabs[String(tabId)];
    await savePermissions(perms);
  }
}
