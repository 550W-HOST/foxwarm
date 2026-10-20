// Delivery.targets owns this collector. Resolve installed production packages only;
// never install packages or substitute a host executable for a different target.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [output, rid] = process.argv.slice(2)
const optional = process.argv.includes('--allow-missing')
const targets = { 'linux-x64': ['linux', 'x64', 'glibc'], 'linux-arm64': ['linux', 'arm64', 'glibc'], 'linux-musl-x64': ['linux', 'x64', 'musl'], 'linux-musl-arm64': ['linux', 'arm64', 'musl'], 'win-x64': ['win32', 'x64', null], 'win-arm64': ['win32', 'arm64', null], 'osx-x64': ['darwin', 'x64', null], 'osx-arm64': ['darwin', 'arm64', null] }
if (!output) throw new Error('Artifact runtime output is required')
if (!targets[rid]) {
  if (!optional) throw new Error(`Unsupported artifact runtime target: ${rid}`)
  await fs.rm(path.resolve(output), { recursive: true, force: true })
  console.log(`Artifact runtime ${rid} is unavailable; compilation only`)
  process.exit(0)
}
const [os, cpu, libc] = targets[rid]
const destination = path.resolve(output)
// Locate package metadata even when package exports deliberately hide package.json.
async function locate(name, from) {
  const require = createRequire(path.join(from, 'package.json'))
  for (const search of require.resolve.paths(name) || []) {
    const file = path.join(search, name, 'package.json')
    try { return { directory: path.dirname(file), metadata: JSON.parse(await fs.readFile(file, 'utf8')) } }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw new Error(`Missing installed artifact dependency ${name}, resolved from ${from}`)
}
const compatible = metadata => (!metadata.os || metadata.os.includes(os)) && (!metadata.cpu || metadata.cpu.includes(cpu)) && (!metadata.libc || metadata.libc.includes(libc))
const copied = new Set()
const closure = []
async function collect(name, from, target) {
  const { directory, metadata } = await locate(name, from)
  if (!compatible(metadata)) throw new Error(`Artifact dependency ${name} is not for ${rid}`)
  if (copied.has(target)) return
  copied.add(target)
  await fs.cp(directory, path.join(destination, target), { recursive: true, filter: source => {
    const relative = path.relative(directory, source).split(path.sep).join('/')
    if (relative.split('/')[0] === 'node_modules') return false
    // npm's esbuild installer replaces bin/esbuild with the build-host binary.
    // The library resolves the explicit target-native optional package instead.
    return metadata.name !== 'esbuild' || relative !== 'bin/esbuild' && !relative.startsWith('lib/downloaded-')
  } })
  closure.push(`${target}: ${metadata.version}`)
  for (const dependency of Object.keys(metadata.dependencies || {})) {
    const resolved = await locate(dependency, directory)
    // Preserve real resolver nesting, including separately fixed WebUI React.
    const relative = path.relative(root, resolved.directory)
    if (relative.startsWith('..')) throw new Error(`Artifact dependency outside the installed project: ${dependency}`)
    await collect(dependency, directory, relative)
  }
}
try {
  // Recreate only owned collected inputs so removed dependencies cannot linger.
  await fs.rm(destination, { recursive: true, force: true })
  await fs.mkdir(destination, { recursive: true })
  for (const name of ['esbuild', 'sharp']) await collect(name, root, `node_modules/${name}`)
  const nativePlatform = os === 'linux' && libc === 'musl' ? 'linuxmusl' : os
  await collect(`@esbuild/${os}-${cpu}`, root, `node_modules/@esbuild/${os}-${cpu}`)
  await collect(`@img/sharp-${nativePlatform}-${cpu}`, root, `node_modules/@img/sharp-${nativePlatform}-${cpu}`)
  // Windows sharp packages carry their own libvips; Unix packages resolve it separately.
  if (os !== 'win32') await collect(`@img/sharp-libvips-${nativePlatform}-${cpu}`, root, `node_modules/@img/sharp-libvips-${nativePlatform}-${cpu}`)
  const web = path.join(root, 'packages/webui')
  for (const name of ['react', 'react-dom']) await collect(name, web, `packages/webui/node_modules/${name}`)
  console.log(`Artifact runtime ${rid}\n${closure.sort().join('\n')}`)

} catch (error) {
  await fs.rm(destination, { recursive: true, force: true })
  if (!optional || !String(error.message).startsWith('Missing installed artifact dependency')) throw error
  console.log(`Artifact runtime ${rid} is unavailable; compilation only. Complete delivery requires the installed target dependencies.`)
}
