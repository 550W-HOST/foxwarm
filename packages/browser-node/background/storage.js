// Persistent connection/site choices; live tab and window grants last one browser session.
let writes = Promise.resolve();
function mutate(area, key, update) {
  const next = writes.then(async () => {
    const data = (await chrome.storage[area].get(key))[key] || {};
    await chrome.storage[area].set({ [key]: await update(data) });
  });
  writes = next.catch(() => {});
  return next;
}

export function normalizeHost(input) {
  if (typeof input !== 'string' || /[\\\s?#]/.test(input.trim()))
    throw new Error('Enter an HTTP or HTTPS Main address without a query or fragment.');
  const url = new URL(input.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Enter an HTTP or HTTPS Main address.');
  return url.href.replace(/\/+$/, '');
}
export async function getConnection() {
  await writes;
  return (await chrome.storage.local.get('connection')).connection || { host: '', enabled: false };
}
export async function saveConnectionConfig(host, pairingToken, nodeName) {
  const target = normalizeHost(host);
  await mutate('local', 'connection', (old) => ({
    ...(old.host === target ? old : {}),
    host: target,
    pairingToken: pairingToken || (old.host === target ? old.pairingToken : '') || '',
    nodeName: nodeName || 'browser',
    enabled: true,
  }));
}
export function setEnabled(enabled) {
  return mutate('local', 'connection', (old) => ({ ...old, enabled }));
}
export function saveCredentials(host, nodeId, authToken) {
  return mutate('local', 'connection', (old) => {
    if (old.host !== host || !old.enabled)
      throw new Error('Pairing target changed or connection stopped.');
    return { ...old, nodeId, authToken, pairingToken: '', pairedAt: Date.now() };
  });
}
export function forget() {
  return mutate('local', 'connection', (old) => ({
    host: old.host || '',
    nodeName: old.nodeName || '',
    enabled: false,
  }));
}
export async function getPermissions() {
  await writes;
  const [local, session] = await Promise.all([
    chrome.storage.local.get('sites'),
    chrome.storage.session.get('sharing'),
  ]);
  return {
    sites: local.sites || {},
    tabs: session.sharing?.tabs || {},
    windows: session.sharing?.windows || {},
  };
}
function level(value) {
  if (!['off', 'ask', 'auto'].includes(value)) throw new Error('Choose Off, Ask, or Auto.');
  return value;
}
export function setDomainPermission(domain, value) {
  const name = String(domain).trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(name) || name.startsWith('.') || name.endsWith('.'))
    throw new Error('Enter a site hostname.');
  return mutate('local', 'sites', (sites) => ({ ...sites, [name]: level(value) }));
}
export function removeDomainPermission(domain) {
  return mutate('local', 'sites', (sites) => {
    delete sites[domain];
    return sites;
  });
}
export async function setTabPermission(tabId, value) {
  const tab = await chrome.tabs.get(tabId);
  const origin = new URL(tab.url).origin;
  return mutate('session', 'sharing', (sharing) => ({
    ...sharing,
    tabs: { ...sharing.tabs, [tabId]: { level: level(value), origin } },
  }));
}
export function setWindowPermission(windowId, value) {
  return mutate('session', 'sharing', (sharing) => ({
    ...sharing,
    windows: { ...sharing.windows, [windowId]: level(value) },
  }));
}
export function removeTabPermission(tabId) {
  return mutate('session', 'sharing', (sharing) => {
    delete sharing.tabs?.[tabId];
    return sharing;
  });
}
export function removeWindowPermission(windowId) {
  return mutate('session', 'sharing', (sharing) => {
    delete sharing.windows?.[windowId];
    return sharing;
  });
}
