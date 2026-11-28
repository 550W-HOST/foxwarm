const $ = (id) => document.getElementById(id)
const limits = [
  ['busyTurns', 'Concurrent turns'],
  ['requestsPerSecond', 'Requests per second'],
  ['uploadBytes', 'Upload size (bytes)'],
  ['requestBurst', 'Request burst'],
  ['hotOwnerBytes', 'Hot owner memory (bytes)'],
  ['toolScriptRuns', 'ToolScript runs'],
  ['webSockets', 'WebSocket connections'],
  ['dbStatements', 'Database statements'],
  ['blobBytes', 'Blob storage (bytes)'],
  ['agentStoreBytes', 'Agent storage (bytes)'],
  ['agentStoreFiles', 'Agent files'],
  ['agentFileBytes', 'Agent file size (bytes)'],
  ['residentNodes', 'Resident Nodes'],
  ['nodeExecs', 'Concurrent Node executions'],
  ['mcpServers', 'MCP servers'],
  ['channels', 'Channels'],
  ['accessIdentities', 'Access identities'],
  ['webhooks', 'Webhooks'],
]
let bearer = '',
  session = new AbortController(),
  tenants = [],
  selected,
  pending = false
const providerReasons = new Map([
  ['tenancy-mismatch', 'tenancy mismatch'],
  ['describe-failed', 'check failed'],
  ['parent-not-granted', 'parent Provider not granted'],
])
let placementBySlug = new Map()
const limitInputs = new Map()
for (const [index, [key, name]] of limits.entries()) {
  const label = document.createElement('label'),
    input = document.createElement('input')
  label.append(name, input)
  input.inputMode = 'numeric'
  input.pattern = '[0-9]+'
  input.placeholder = 'Default'
  limitInputs.set(key, input)
  $(index < 3 ? 'limits' : 'moreLimits').append(label)
}
function notice(text) {
  $('notice').textContent = text
}
function signOut() {
  session.abort()
  session = new AbortController()
  bearer = ''
  selected = null
  tenants = []
  $('tenantRows').replaceChildren()
  $('replicaRows').replaceChildren()
  $('settings').reset()
  $('token').value = ''
  $('name').textContent = ''
  $('identity').textContent = ''
  $('providerStatus').textContent = ''
  $('leaseStatus').textContent = ''
  placementBySlug.clear()
  $('detail').hidden = $('workspace').hidden = $('signout').hidden = true
  $('signin').hidden = false
  $('token').focus()
  notice('')
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`./operator/v1/${path}`, {
    method,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: session.signal,
    headers: { Authorization: `Bearer ${bearer}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body,
  })
  const text = await response.text()
  if (!response.ok) {
    if (response.status === 401) signOut()
    let error
    try {
      error = JSON.parse(text).error
    } catch {
      /* A proxy may return plain text. */
    }
    throw new Error(error || `Request failed (${response.status}).`)
  }
  // Show exact stored integers when the browser exposes their original JSON tokens.
  return JSON.parse(text, (_key, value, context) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && context?.source ? context.source : value,
  )
}
function cell(row, value) {
  const td = row.insertCell()
  if (value instanceof Node) td.append(value)
  else td.textContent = value ?? '—'
}
function updateRetention() {
  const days = $('retentionMode').value === 'days'
  $('daysLabel').hidden = !days
  $('retention').disabled = !days
  $('retention').required = days
}
$('retentionMode').onchange = updateRetention
function showTenant(tenant) {
  selected = tenant
  $('detail').hidden = !tenant || $('tenants').hidden
  if (!tenant) return
  $('name').textContent = tenant.slug
  $('identity').textContent = [tenant.primaryHostname, tenant.profile, tenant.state].filter(Boolean).join(' · ')
  const sample = placementBySlug.get(tenant.slug)
  const active = tenant.state === 'active'
  $('placementActions').hidden = !active
  const pendingAction =
    sample?.requestedAction === 'move'
      ? 'Move requested.'
      : sample?.requestedAction === 'release'
        ? 'Release requested.'
        : ''
  const owner = sample?.owner ? `Owner: ${sample.owner}` : 'No current owner.'
  $('leaseStatus').textContent = [
    owner,
    pendingAction,
    sample?.drainingSince && sample.owner ? 'The current lease is draining.' : '',
  ]
    .filter(Boolean)
    .join('\n')
  const epoch = sample?.epoch
  const exactEpoch = Number.isSafeInteger(epoch) || (typeof epoch === 'string' && /^[1-9][0-9]*$/.test(epoch))
  const canRequest =
    active &&
    !!sample?.owner &&
    sample.tenantId > 0 &&
    exactEpoch &&
    !sample.requestedAction &&
    !sample.drainingSince
  $('moveTenant').disabled = $('releaseTenant').disabled = !canRequest
  const problems = placementBySlug.get(tenant.slug)?.providerProblems
  const status = $('providerStatus')
  status.replaceChildren()
  if (problems == null) status.textContent = 'Providers: no current report.'
  else if (!Object.keys(problems).length) status.textContent = 'Providers: no reported issues.'
  else {
    const list = document.createElement('ul')
    for (const [id, code] of Object.entries(problems)) {
      const item = document.createElement('li')
      item.textContent = `${id}: ${providerReasons.get(code) ?? code}`
      list.append(item)
    }
    status.append('Provider issues:', list)
  }
  for (const [key, input] of limitInputs) input.value = tenant.limits?.[key] ?? ''
  $('recording').value = String(tenant.journal?.enabled ?? '')
  $('retention').value = tenant.journal?.retentionDays ?? ''
  $('retentionMode').value =
    tenant.journal?.retentionDays === null
      ? 'unlimited'
      : tenant.journal?.retentionDays !== undefined
        ? 'days'
        : 'default'
  updateRetention()
  const action = $('stateAction')
  action.hidden = !['active', 'suspended'].includes(tenant.state)
  action.textContent = tenant.state === 'active' ? 'Suspend tenant' : 'Resume tenant'
  $('fields').disabled = $('save').disabled = tenant.state === 'deleting'
}
async function refresh() {
  const [list, placement] = await Promise.all([api('tenants'), api('placement')])
  tenants = list
  placementBySlug = new Map(placement.tenants.map((sample) => [sample.slug, sample]))
  $('tenantRows').replaceChildren()
  $('replicaRows').replaceChildren()
  for (const tenant of tenants) {
    const row = $('tenantRows').insertRow(),
      button = document.createElement('button'),
      sample = placementBySlug.get(tenant.slug)
    button.textContent = tenant.slug
    button.onclick = () => {
      if (!pending) {
        showTenant(tenant)
        $('detail').scrollIntoView({ block: 'nearest' })
      }
    }
    for (const value of [button, tenant.state, sample?.owner, sample?.hot, sample?.busy]) cell(row, value)
  }
  for (const replica of placement.replicas) {
    const row = $('replicaRows').insertRow()
    const drain = document.createElement('button')
    drain.textContent = 'Drain replica'
    drain.disabled = replica.draining
    drain.onclick = () =>
      perform(async () => {
        if (!confirm(`Drain ${replica.id}? It will stop accepting tenants and move its current tenants to other replicas when one is available.`)) return
        await api('replicas/drain', 'POST', JSON.stringify({ boot: replica.id }))
        await refresh()
        notice('Replica drain requested.')
      })
    for (const value of [
      replica.id,
      replica.role,
      replica.version,
      replica.draining ? 'Yes' : 'No',
      new Date(replica.heartbeatAt).toLocaleString(),
      replica.heldGrants,
      drain,
    ])
      cell(row, value)
  }
  for (const [tbody, label] of [
    ['tenantRows', 'No tenants.'],
    ['replicaRows', 'No replicas.'],
  ])
    if (!$(tbody).rows.length) {
      const td = $(tbody).insertRow().insertCell()
      td.colSpan = tbody === 'replicaRows' ? 7 : 5
      td.textContent = label
    }
  showTenant(tenants.find((t) => t.slug === selected?.slug))
}
async function perform(action) {
  if (pending) return
  pending = true
  notice('')
  const signal = session.signal
  try {
    await action()
  } catch (error) {
    if (!signal.aborted || error.name !== 'AbortError') notice(error.message)
  } finally {
    pending = false
  }
}
$('access').onsubmit = (event) => {
  event.preventDefault()
  perform(async () => {
    bearer = $('token').value.trim()
    $('token').value = ''
    await refresh()
    $('signin').hidden = true
    $('workspace').hidden = $('signout').hidden = false
  })
}
$('signout').onclick = signOut
$('refresh').onclick = () => perform(refresh)
for (const [id, other] of [
  ['Tenants', 'Replicas'],
  ['Replicas', 'Tenants'],
])
  $('show' + id).onclick = () => {
    $(id.toLowerCase()).hidden = false
    $(other.toLowerCase()).hidden = true
    $('detail').hidden = id !== 'Tenants' || !selected
    $('show' + id).setAttribute('aria-pressed', 'true')
    $('show' + other).setAttribute('aria-pressed', 'false')
  }
$('stateAction').onclick = () =>
  perform(async () => {
    const tenant = selected,
      suspend = tenant.state === 'active'
    if (suspend && !confirm(`Suspend ${tenant.slug}? Its running Sessions will stop.`)) return
    await api(`tenants/${encodeURIComponent(tenant.slug)}/${suspend ? 'suspend' : 'resume'}`, 'POST')
    await refresh()
    notice(suspend ? 'Tenant suspended.' : 'Tenant resumed.')
  })
for (const [button, action] of [
  ['moveTenant', 'move'],
  ['releaseTenant', 'release'],
]) {
  $(button).onclick = () =>
    perform(async () => {
      const tenant = selected,
        sample = placementBySlug.get(tenant.slug)
      const question =
        action === 'move'
          ? `Move ${tenant.slug} to another eligible replica?`
          : `Release ${tenant.slug} from ${sample.owner}? It can start again on demand.`
      if (!confirm(question)) return
      // The parsed epoch may exceed a JavaScript safe integer. Its checked decimal
      // spelling is used as a JSON number so the API compares the exact shown grant.
      const body = `{"tenantId":${sample.tenantId},"owner":${JSON.stringify(sample.owner)},"epoch":${sample.epoch}}`
      await api(`tenants/${encodeURIComponent(tenant.slug)}/${action}`, 'POST', body)
      await refresh()
      notice(action === 'move' ? 'Tenant move requested.' : 'Lease release requested.')
    })
}
$('settings').onsubmit = (event) => {
  event.preventDefault()
  perform(async () => {
    const tenant = selected,
      changed = [],
      values = []
    // Keep integer literals as strings until writing the request so file-size limits are not rounded.
    let limitChanged = false
    for (const [key, input] of limitInputs) {
      const value = input.value.trim(),
        stored = tenant.limits?.[key]
      if (value !== String(stored ?? '')) limitChanged = true
      if (value) {
        if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Limits must be positive whole numbers.')
        values.push(`${JSON.stringify(key)}:${value}`)
      }
    }
    if (limitChanged) {
      if (
        Object.keys(tenant.limits ?? {}).some((key) => !limitInputs.has(key)) ||
        Object.values(tenant.limits ?? {}).some(
          (value) => typeof value === 'number' && !Number.isSafeInteger(value),
        )
      )
        throw new Error('Use the operator CLI to edit these limits without changing unrecognized values.')
      changed.push(`"limits":{${values.join(',')}}`)
    }
    const journal = { ...(tenant.journal ?? {}) }
    const recording = $('recording').value,
      retention = $('retention').value.trim()
    if (recording) journal.enabled = recording === 'true'
    else delete journal.enabled
    if ($('retentionMode').value === 'unlimited') journal.retentionDays = null
    else if ($('retentionMode').value === 'days') journal.retentionDays = Number(retention)
    else delete journal.retentionDays
    if (JSON.stringify(journal) !== JSON.stringify(tenant.journal ?? {}))
      changed.push(`"journal":${JSON.stringify(journal)}`)
    if (!changed.length) {
      notice('No changes to save.')
      return
    }
    await api(`tenants/${encodeURIComponent(tenant.slug)}`, 'PATCH', `{${changed.join(',')}}`)
    await refresh()
    notice('Settings saved.')
  })
}
