/**
 * Popup UI logic
 */

// ─── Helpers ───

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

// ─── State ───

let currentState = 'disconnected';
let currentPermissions = { default: 'ask', domains: {}, tabs: {} };

// ─── Connection UI ───

const hostInput = $('#host-input');
const tokenInput = $('#token-input');
const nameInput = $('#name-input');
const connectBtn = $('#connect-btn');
const disconnectBtn = $('#disconnect-btn');
const resetBtn = $('#reset-btn');
const statusBadge = $('#status-badge');
const pairingInfo = $('#pairing-info');
const pairCode = $('#pair-code');
const registeredInfo = $('#registered-info');
const nodeIdDisplay = $('#node-id-display');

function updateStatusBadge(state, detail = {}) {
  currentState = state;
  const badges = {
    disconnected: ['Disconnected', 'badge-disconnected'],
    connecting: ['Connecting…', 'badge-connecting'],
    reconnecting: ['Reconnecting…', 'badge-connecting'],
    connected: ['Connected', 'badge-connected'],
    pair_pending: ['Pairing…', 'badge-pairing'],
    pair_approved: ['Paired!', 'badge-registered'],
    pair_rejected: ['Rejected', 'badge-disconnected'],
    registered: ['Online', 'badge-registered'],
  };

  const [text, cls] = badges[state] || ['Unknown', 'badge-disconnected'];
  statusBadge.textContent = text;
  statusBadge.className = `badge ${cls}`;

  // Show/hide elements based on state
  const isConnected = ['connected', 'pair_pending', 'registered', 'pair_approved'].includes(state);
  connectBtn.style.display = isConnected ? 'none' : '';
  disconnectBtn.style.display = isConnected ? '' : 'none';
  resetBtn.style.display = state !== 'disconnected' || detail.hasCredentials ? '' : 'none';

  // Disable inputs when connected
  hostInput.disabled = isConnected;
  tokenInput.disabled = isConnected;
  nameInput.disabled = isConnected;

  // Pairing info
  if (state === 'pair_pending' && detail.pairCode) {
    pairingInfo.style.display = '';
    pairCode.textContent = detail.pairCode;
    registeredInfo.style.display = 'none';
  } else if (state === 'registered' && detail.nodeId) {
    pairingInfo.style.display = 'none';
    registeredInfo.style.display = '';
    nodeIdDisplay.textContent = detail.nodeId;
  } else {
    pairingInfo.style.display = 'none';
    if (state === 'disconnected' || state === 'connecting') {
      registeredInfo.style.display = 'none';
    }
  }
}

connectBtn.addEventListener('click', async () => {
  const host = hostInput.value.trim();
  const token = tokenInput.value.trim();
  const name = nameInput.value.trim();

  if (!host) {
    hostInput.focus();
    return;
  }

  connectBtn.disabled = true;
  try {
    await sendMessage({ type: 'connect', host, pairingToken: token, nodeName: name });
  } catch (e) {
    console.error('Connect failed:', e);
    updateStatusBadge('disconnected');
  }
  connectBtn.disabled = false;
});

disconnectBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'disconnect' });
  updateStatusBadge('disconnected');
});

resetBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'reset' });
  updateStatusBadge('disconnected');
  tokenInput.value = '';
});

// ─── Permissions UI ───

const defaultPermToggle = $('#default-permission');

function renderDefaultPermission(level) {
  defaultPermToggle.querySelectorAll('.perm-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.level === level);
  });
}

defaultPermToggle.addEventListener('click', async (e) => {
  const btn = e.target.closest('.perm-btn');
  if (!btn) return;
  const level = btn.dataset.level;
  await sendMessage({ type: 'set_default_permission', level });
  currentPermissions.default = level;
  renderDefaultPermission(level);
  renderTabs(); // Re-render tabs to show updated effective permissions
});

// ─── Domain Rules ───

const domainRulesList = $('#domain-rules-list');
const newDomainInput = $('#new-domain-input');
const newDomainLevel = $('#new-domain-level');
const addDomainBtn = $('#add-domain-btn');

function renderDomainRules() {
  const domains = currentPermissions.domains || {};
  const entries = Object.entries(domains);

  if (entries.length === 0) {
    domainRulesList.innerHTML = '<div class="empty-state">No domain rules</div>';
    return;
  }

  domainRulesList.innerHTML = entries.map(([domain, level]) => `
    <div class="rule-item">
      <span class="rule-domain">${escapeHtml(domain)}</span>
      <div class="rule-actions">
        <div class="permission-toggle" data-domain="${escapeHtml(domain)}">
          <button class="perm-btn ${level === 'off' ? 'active' : ''}" data-level="off">Off</button>
          <button class="perm-btn ${level === 'ask' ? 'active' : ''}" data-level="ask">Ask</button>
          <button class="perm-btn ${level === 'auto' ? 'active' : ''}" data-level="auto">Auto</button>
        </div>
        <button class="rule-remove" data-domain="${escapeHtml(domain)}" title="Remove rule">×</button>
      </div>
    </div>
  `).join('');

  // Bind events
  domainRulesList.querySelectorAll('.permission-toggle').forEach(toggle => {
    toggle.addEventListener('click', async (e) => {
      const btn = e.target.closest('.perm-btn');
      if (!btn) return;
      const domain = toggle.dataset.domain;
      const level = btn.dataset.level;
      await sendMessage({ type: 'set_domain_permission', domain, level });
      currentPermissions.domains[domain] = level;
      renderDomainRules();
      renderTabs();
    });
  });

  domainRulesList.querySelectorAll('.rule-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domain = btn.dataset.domain;
      await sendMessage({ type: 'remove_domain_permission', domain });
      delete currentPermissions.domains[domain];
      renderDomainRules();
      renderTabs();
    });
  });
}

addDomainBtn.addEventListener('click', async () => {
  const domain = newDomainInput.value.trim().toLowerCase();
  if (!domain) return;
  const level = newDomainLevel.value;
  await sendMessage({ type: 'set_domain_permission', domain, level });
  currentPermissions.domains[domain] = level;
  newDomainInput.value = '';
  renderDomainRules();
  renderTabs();
});

newDomainInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addDomainBtn.click();
});

// ─── Tabs List ───

const tabsList = $('#tabs-list');
let allTabs = [];

async function loadTabs() {
  allTabs = await chrome.tabs.query({});
  renderTabs();
}

async function renderTabs() {
  if (allTabs.length === 0) {
    tabsList.innerHTML = '<div class="empty-state">No tabs</div>';
    return;
  }

  // Resolve permissions for each tab
  const tabsWithPerms = await Promise.all(allTabs.map(async (tab) => {
    const resp = await sendMessage({ type: 'resolve_permission', tabId: tab.id, tabUrl: tab.url });
    return { ...tab, effectiveLevel: resp.level };
  }));

  tabsList.innerHTML = tabsWithPerms.map(tab => `
    <div class="tab-item">
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title || 'Untitled')}</div>
        <div class="tab-url">${escapeHtml(tab.url || '')}</div>
      </div>
      <div class="tab-perm">
        <div class="permission-toggle" data-tab-id="${tab.id}">
          <button class="perm-btn ${tab.effectiveLevel === 'off' ? 'active' : ''}" data-level="off">Off</button>
          <button class="perm-btn ${tab.effectiveLevel === 'ask' ? 'active' : ''}" data-level="ask">Ask</button>
          <button class="perm-btn ${tab.effectiveLevel === 'auto' ? 'active' : ''}" data-level="auto">Auto</button>
        </div>
      </div>
    </div>
  `).join('');

  // Bind events
  tabsList.querySelectorAll('.permission-toggle').forEach(toggle => {
    toggle.addEventListener('click', async (e) => {
      const btn = e.target.closest('.perm-btn');
      if (!btn) return;
      const tabId = parseInt(toggle.dataset.tabId, 10);
      const level = btn.dataset.level;
      await sendMessage({ type: 'set_tab_permission', tabId, level });
      currentPermissions.tabs[String(tabId)] = level;
      renderTabs();
    });
  });
}

// ─── Confirmations ───

const confirmationsPanel = $('#confirmations-panel');
const confirmationsList = $('#confirmations-list');

async function loadConfirmations() {
  const resp = await sendMessage({ type: 'get_pending_confirmations' });
  const confirmations = resp.confirmations || [];

  if (confirmations.length === 0) {
    confirmationsPanel.style.display = 'none';
    return;
  }

  confirmationsPanel.style.display = '';
  confirmationsList.innerHTML = confirmations.map(c => `
    <div class="confirmation-item" data-request-id="${escapeHtml(c.requestId)}">
      <div class="confirmation-tool">${escapeHtml(c.toolName)}</div>
      <div class="confirmation-args">${escapeHtml(JSON.stringify(c.args).slice(0, 200))}</div>
      <div class="confirmation-actions">
        <button class="btn btn-confirm" data-action="allow">Allow</button>
        <button class="btn btn-deny" data-action="deny">Deny</button>
      </div>
    </div>
  `).join('');

  confirmationsList.querySelectorAll('.confirmation-item').forEach(item => {
    item.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const requestId = item.dataset.requestId;
        const approved = btn.dataset.action === 'allow';
        await sendMessage({ type: 'confirmation_response', requestId, approved });
        loadConfirmations();
      });
    });
  });
}

// ─── Listen for background messages ───

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'connection_state') {
    updateStatusBadge(message.state, message.detail || {});
  }
  if (message.type === 'confirmation_request') {
    loadConfirmations();
  }
});

// ─── Utilities ───

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ───

async function init() {
  // Load connection info
  const conn = await sendMessage({ type: 'get_connection' });
  hostInput.value = conn.host || '';
  tokenInput.value = conn.pairingToken || '';
  nameInput.value = conn.nodeName || '';

  // Load current state
  const state = await sendMessage({ type: 'get_state' });
  updateStatusBadge(state.state, {
    nodeId: state.nodeId,
    hasCredentials: !!(conn.nodeId && conn.authToken),
  });

  // If registered, show node ID
  if (state.state === 'registered' && state.nodeId) {
    registeredInfo.style.display = '';
    nodeIdDisplay.textContent = state.nodeId;
  }

  // Show reset button if we have stored credentials
  if (conn.nodeId && conn.authToken) {
    resetBtn.style.display = '';
  }

  // Load permissions
  currentPermissions = await sendMessage({ type: 'get_permissions' });
  renderDefaultPermission(currentPermissions.default || 'ask');
  renderDomainRules();

  // Load tabs
  await loadTabs();

  // Load confirmations
  await loadConfirmations();
}

init();
