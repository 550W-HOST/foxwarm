// Starts and stops a disposable managed Main from this checkout for demo fixture generation.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import testEnvironment from '../../../../scripts/test/test-process-env.cjs'

export const repoRoot = resolve(import.meta.dirname, '../../../..')
export const demoToken = 'demo-generator-token'

export async function openPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise(done => server.close(done))
  return port
}

export function mainDll() {
  const dll = process.env.FOXWARM_TEST_MAIN_DLL || join(repoRoot, 'dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')
  if (!existsSync(dll)) throw new Error(`Managed Main build is missing at ${dll}. Run: dotnet build dotnet/Foxwarm/Foxwarm.csproj`)
  return dll
}

// The data root receives its own app/model configuration and token; the caller owns the directory.
export async function startMain({ dataRoot, providerUrl, model = 'demo-model', extraConfig = '', log = () => {} }) {
  const port = await openPort()
  await mkdir(join(dataRoot, 'state'), { recursive: true })
  await writeFile(join(dataRoot, 'state/config.yaml'), `bot: {httpPort: ${port}, name: Foxwarm}\nvector: false\nvectorMaintenance: false\nhandoffConfirmation: false\nllm: {memoryWarningThresholdPercent: 0.05}\n${extraConfig}`)
  await writeFile(join(dataRoot, 'state/token'), demoToken, { mode: 0o600 })
  await writeFile(join(dataRoot, 'state/models.yaml'), JSON.stringify({
    default: `demo/${model}`,
    providers: {
      demo: {
        providerType: 'openai-responses',
        baseUrl: providerUrl,
        apiKey: 'demo-provider-key',
        asyncCompact: false,
        contextWindow: 200000,
        effort: { allowed: ['low', 'medium', 'high'], default: 'high' },
        models: [model],
      },
    },
  }, null, 2) + '\n')
  const dotnet = join(process.env.DOTNET_ROOT || '', 'dotnet')
  if (!process.env.DOTNET_ROOT) throw new Error('Set DOTNET_ROOT to a .NET 10 SDK.')
  // Commands the gallery runs log into these paths, so keep them inside the data root.
  const env = { ...testEnvironment.isolatedApplicationEnv(dataRoot), TZ: 'UTC', npm_config_cache: join(dataRoot, '.npm'), npm_config_update_notifier: 'false' }
  const child = spawn(dotnet, [mainDll(), '--installation-root', repoRoot], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const capture = bytes => { output = (output + bytes).slice(-20000); log(String(bytes)) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Main exited during startup: ${output}`)
    try {
      const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${demoToken}` } })
      if (response.ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`Main did not start: ${output}`)
    await new Promise(done => setTimeout(done, 100))
  }
  const api = async (method, path, body) => {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${demoToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch { json = text }
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`)
    return json
  }
  return { child, port, baseUrl, api, get output() { return output } }
}

export async function stopMain(host) {
  if (!host || host.child.exitCode !== null) return
  try {
    await fetch(`${host.baseUrl}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${demoToken}` } })
  } catch {}
  const exited = await Promise.race([once(host.child, 'exit').then(() => true), new Promise(done => setTimeout(() => done(false), 20000))])
  if (!exited) {
    try { process.kill(-host.child.pid, 'SIGKILL') } catch {}
  }
}
