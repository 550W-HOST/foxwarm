// Exercise the pinned operator on its own listener. The ordinary tenant keeps serving at the
// shared entry throughout. Both environments run this same turn and inspect its real effects.
import { assert, until, tenantRequest } from './util.mjs'

export async function masterHost(env, general) {
  const slug = 'master-ops'
  await env.sql(`INSERT INTO tenants (name,profile,pinned_role) VALUES ('${slug}','operator','master-host');
    INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name='${slug}';
    INSERT INTO tenant_hostnames(hostname,tenant_id,kind) SELECT '${slug}.test',tenant_id,'primary' FROM tenants WHERE name='${slug}';
    INSERT INTO tenant_hostnames(hostname,tenant_id,kind) SELECT '${slug}.localhost',tenant_id,'custom' FROM tenants WHERE name='${slug}'`)
  const lease = async tenant => (await env.sql(`SELECT l.epoch,l.owner_replica FROM tenant_leases l JOIN tenants t USING(tenant_id) WHERE t.name='${tenant}'`))[0]
  const ordinary = await lease(env.tenant)
  let master = await env.startMaster()
  try {
    async function activate() {
      await until(async () => (await tenantRequest(env.publicUrl, null, slug + '.test')('GET', '/health')).status === 401, 'operator tenant activates on master host', 90000)
      const grant = await lease(slug)
      assert(grant[1]?.startsWith('foxwarm-master/'), 'only master-host holds the operator lease: ' + grant)
      return grant
    }
    const first = await activate()
    const credential = await env.token({ tenant: slug })
    assert(credential.code === 0, 'read operator sign-in credential: ' + credential.stderr)
    const token = credential.stdout.trim()
    const call = tenantRequest(env.publicUrl, token, slug + '.test')
    // The front validates the hostname; remote Node scripts must preserve its public port
    // and must not infer a public origin from forwarding headers or the mesh listener.
    const forwarded = { 'X-Forwarded-Host': 'untrusted.test', 'X-Forwarded-Proto': 'https' }
    const authority = `${slug}.test:8443`
    const script = await tenantRequest(env.publicUrl, token, authority)('GET', '/node/run.sh', undefined, forwarded)
    assert(script.status === 200 && script.text.includes(`HOST="http://${authority}"`) && !script.text.includes('untrusted.test'),
      'master Node bootstrap uses the validated request origin')
    const local = await tenantRequest(env.publicUrl, token, `${slug}.localhost`)('GET', '/node/run.sh', undefined, forwarded)
    assert(local.status === 503, 'a local-only tenant address cannot bootstrap a remote Node')
    const yaml = `default: drill/wire\nproviders:\n  drill:\n    providerType: openai-responses\n    baseUrl: ${env.modelBaseUrl}\n    models: [wire]\n`
    for (const [route, body, status] of [
      ['/api/setup/models', { yaml }, 200],
      ['/api/sessions', { agentId: 'main', sessionId: 'master-check' }, 200],
      ['/api/sessions/master-check/message', { text: 'DRILL:master-acceptance' }, 202],
    ]) {
      const result = await call('POST', route, body)
      assert(result.status === status, route + ': ' + result.status + ' ' + result.text)
    }
    const state = await until(async () => {
      const history = await call('GET', '/api/sessions/master-check/history')
      return history.text.includes('FINAL:master-acceptance:') && JSON.parse(history.text)
    }, 'master exec and stdio turn completes', 90000)
    const tools = JSON.stringify(state.messages.filter(m => m.role === 'tool'))
    assert(tools.includes('master-exec-ok'), 'exec returned its receipt: ' + tools)
    assert(tools.includes('stdio-transport-ok'), 'stdio MCP returned its receipt: ' + tools)
    const workbench = await call('GET', '/vscode-web/')
    assert(workbench.status === 200 && workbench.text.includes('data-settings='), 'the installed Code workbench opens')
    const roots = JSON.parse((await call('GET', '/api/vscode-web/fs/workspace-roots')).text).roots
    assert(roots.data.nodeId === 'master', 'Code identifies the operator workspace on master')
    const [[id]] = await env.sql(`SELECT tenant_id FROM tenants WHERE name='${slug}'`)
    const path = env.masterAgents + '/' + id + '/main/master-restart.txt'
    const read = '/api/vscode-web/fs/read-file?path=' + encodeURIComponent(path)
    assert((await call('GET', read)).text === 'persisted by master exec', 'Code reads the file written by exec')
    await master.stop()
    master = null
    const unavailable = await tenantRequest(env.publicUrl, token, slug + '.test')('GET', '/health')
    assert(unavailable.status === 503, 'no general replica accepts the pinned tenant without a master')
    assert((await lease(slug))[0] === first[0], 'the refused general boot did not advance the operator epoch')
    assert((await general.api.get('/api/setup/status')).status === 200, 'ordinary tenant serves during master downtime')
    master = await env.startMaster()
    const second = await activate()
    assert(Number(second[0]) === Number(first[0]) + 1 && second[1] !== first[1], 'new master boot takes the next epoch')
    assert((await tenantRequest(env.publicUrl, token, slug + '.test')('GET', read)).text === 'persisted by master exec', 'Code reopens the same file after restart')
    assert(JSON.stringify(ordinary) === JSON.stringify(await lease(env.tenant)), 'the ordinary tenant kept its owner and epoch')
    return { operatorEpochs: [first[0], second[0]], exec: true, code: true, stdio: true, ordinaryOwner: ordinary[1] }
  } finally {
    await master?.stop()
  }
}
