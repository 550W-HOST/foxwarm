const $ = (selector) => document.querySelector(selector);
const escape = (text) => {
  const el = document.createElement('span');
  el.textContent = String(text || '');
  return el.innerHTML;
};
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
}
const host = $('#host-input'),
  token = $('#token-input'),
  name = $('#name-input');
function status(state) {
  $('#status-badge').className =
    `badge badge-${state.state === 'registered' ? 'registered' : state.state === 'disconnected' ? 'disconnected' : 'connecting'}`;
  $('#status-badge').textContent =
    {
      registered: 'Online',
      disconnected: 'Stopped',
      pair_pending: 'Awaiting approval',
      pair_approved: 'Approved',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      protocol_incompatible: 'Update required',
      pair_rejected: 'Rejected',
    }[state.state] || 'Connecting…';
  const running = !['disconnected', 'pair_rejected', 'protocol_incompatible'].includes(state.state);
  $('#connect-btn').style.display = running ? 'none' : '';
  $('#disconnect-btn').style.display = running ? '' : 'none';
  $('#reset-btn').style.display = '';
  host.disabled = token.disabled = name.disabled = running;
  $('#pairing-info').style.display = state.pendingId ? '' : 'none';
  $('#approval-command').textContent = state.pendingId
    ? `Nodes → Pending approvals → ${state.pendingId}`
    : '';
  $('#registered-info').style.display = state.nodeId ? '' : 'none';
  $('#node-id-display').textContent = state.nodeId || '';
}
async function action(run) {
  try {
    await run();
  } catch (error) {
    $('#status-badge').textContent = error.message;
  }
}
$('#connect-btn').onclick = () =>
  action(async () => {
    await send({
      type: 'connect',
      host: host.value.trim(),
      pairingToken: token.value.trim(),
      nodeName: name.value.trim(),
    });
    token.value = '';
  });
$('#disconnect-btn').onclick = () =>
  action(async () => {
    await send({ type: 'disconnect' });
    status(await send({ type: 'get_state' }));
  });
$('#reset-btn').onclick = () =>
  action(async () => {
    await send({ type: 'reset' });
    token.value = '';
    status(await send({ type: 'get_state' }));
  });
function toggles(kind, id, effective, explicit) {
  return `<div class="permission-toggle" data-kind="${kind}" data-id="${escape(id)}">${['off', 'ask', 'auto'].map((level) => `<button class="perm-btn ${effective === level ? 'active' : ''}" data-level="${level}">${level[0].toUpperCase() + level.slice(1)}</button>`).join('')}${explicit ? '<button class="perm-btn" data-level="inherit" title="Clear rule and inherit">Clear</button>' : ''}</div>`;
}
async function sharing() {
  const [perms, windows] = await Promise.all([
    send({ type: 'get_permissions' }),
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
  ]);
  $('#domain-rules-list').innerHTML =
    Object.entries(perms.sites)
      .map(
        ([site, level]) =>
          `<div class="rule-item"><span>${escape(site)}</span>${toggles('domain', site, level, true)}</div>`,
      )
      .join('') || '<div class="empty-state">No site rules</div>';
  const groups = [];
  for (const window of windows) {
    const tabs = [];
    for (const tab of window.tabs || []) {
      if (!/^https?:/.test(tab.url || '')) continue;
      let level;
      try {
        level = (await send({ type: 'resolve_permission', tabId: tab.id })).level;
      } catch {
        continue;
      }
      tabs.push(
        `<div class="tab-item"><div class="tab-info"><div class="tab-title">${escape(tab.title || 'Untitled')}</div><div class="tab-url">${escape(tab.url)}</div></div>${toggles('tab', tab.id, level, !!perms.tabs[tab.id])}</div>`,
      );
    }
    groups.push(
      `<div class="window-group"><h3>Window ${window.id}</h3>${toggles('window', window.id, perms.windows[window.id] || 'off', !!perms.windows[window.id])}${tabs.join('') || '<div class="empty-state">No supported pages</div>'}</div>`,
    );
  }
  $('#tabs-list').innerHTML = groups.join('');
}
for (const selector of ['#tabs-list', '#domain-rules-list'])
  $(selector).onclick = (event) =>
    action(async () => {
      const button = event.target.closest('[data-level]'),
        toggle = button?.closest('[data-kind]');
      if (!toggle) return;
      const kind = toggle.dataset.kind,
        id = toggle.dataset.id,
        level = button.dataset.level;
      const type = `${level === 'inherit' ? 'remove' : 'set'}_${kind}_permission`;
      await send({
        type,
        level,
        ...(kind === 'domain' ? { domain: id } : { [kind + 'Id']: Number(id) }),
      });
      await sharing();
    });
$('#add-domain-btn').onclick = () =>
  action(async () => {
    await send({
      type: 'set_domain_permission',
      domain: $('#new-domain-input').value,
      level: $('#new-domain-level').value,
    });
    $('#new-domain-input').value = '';
    await sharing();
  });
async function confirmations() {
  const { confirmations } = await send({ type: 'get_pending_confirmations' });
  $('#confirmations-panel').style.display = confirmations.length ? '' : 'none';
  $('#confirmations-list').innerHTML = confirmations
    .map(
      (entry) =>
        `<div class="confirmation-item" data-request-id="${escape(entry.requestId)}"><div class="confirmation-tool">${escape(entry.toolName)}</div><p>${escape(entry.agentName)} · ${escape(entry.sessionId)}</p><p>${escape(entry.title)}<br>${escape(entry.url || `Window ${entry.windowId}`)}</p><pre class="confirmation-args">${escape(JSON.stringify(entry.args, null, 2))}</pre><div class="confirmation-actions"><button class="btn btn-confirm" data-approved="true">Allow</button><button class="btn btn-deny" data-approved="false">Deny</button></div></div>`,
    )
    .join('');
}
$('#confirmations-list').onclick = (event) =>
  action(async () => {
    const button = event.target.closest('[data-approved]'),
      entry = button?.closest('[data-request-id]');
    if (!entry) return;
    await send({
      type: 'confirmation_response',
      requestId: entry.dataset.requestId,
      approved: button.dataset.approved === 'true',
    });
    await confirmations();
  });
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'connection_state') status({ state: message.state, ...message.detail });
  if (message.type === 'confirmations_changed') void confirmations();
  if (message.type === 'sharing_changed') void sharing();
});
chrome.tabs.onCreated.addListener(() => {
  void sharing();
});
chrome.tabs.onRemoved.addListener(() => {
  void sharing();
});
void action(async () => {
  const conn = await send({ type: 'get_connection' });
  host.value = conn.host || '';
  name.value = conn.nodeName || '';
  status(await send({ type: 'get_state' }));
  await sharing();
  await confirmations();
});
