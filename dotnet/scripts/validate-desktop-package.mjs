// Validate the extracted delivery, not the source tree or an intermediate build.
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function validateDesktopPackage(directory) {
  const root = resolve(directory)
  async function required(file) {
    assert((await stat(join(root, file))).isFile(), `Missing package file: ${file}`)
    const bytes = await readFile(join(root, file))
    assert(bytes.length > 0, `Empty package file: ${file}`)
    return bytes
  }
  async function native(file) {
    const bytes = await required(file)
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ', `Not a Windows binary: ${file}`)
    const pe = bytes.readUInt32LE(0x3c)
    assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0', `Invalid PE binary: ${file}`)
    assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, `Not Windows x64: ${file}`)
  }
  for (const file of [
    'Foxwarm.Desktop.dll', 'Foxwarm.Desktop.deps.json', 'Foxwarm.dll',
    'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll',
    'webui-dist/index.html', 'packages/webui/login.html',
    'templates/agents/00_SYSTEM.md', 'templates/models.example.yaml',
    'templates/node/run.ps1', 'templates/node/run.sh',
    'skills/code-index/SKILL.md', 'skills/code-index/INITIALIZATION.md',
    'skills/react-artifacts/examples/sorting.json',
    'packages/cli-node/dist/client.bundle.js', 'packages/cli-node/dist/tui.bundle.js',
    'packages/shared/dist/index.js', 'packages/cli-node-runtime/package-lock.json',
    'lib/artifacts/managedPrepare.js', 'lib/artifacts/reactCompiler.js', 'lib/artifacts/rasterMetadata.js',
    'node_modules/esbuild/lib/main.js', 'node_modules/esbuild/LICENSE.md',
    'node_modules/sharp/lib/index.js', 'node_modules/sharp/LICENSE',
    'node_modules/@img/sharp-win32-x64/LICENSE',
    'packages/webui/node_modules/react/index.js', 'packages/webui/node_modules/react/LICENSE',
    'packages/webui/node_modules/react-dom/client.js', 'packages/webui/node_modules/react-dom/LICENSE',
    'README.md', 'LICENSE.txt', 'Foxwarm-icon-LICENSE.txt',
    'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt',
    'ToolScript/MONTY-LICENSE', 'ToolScript/PROTOBUF-LICENSE', 'ToolScript/GRPC-TOOLS-LICENSE',
    'ToolScript/THIRD-PARTY-NOTICES.md', 'Timers/THIRD-PARTY-NOTICES.md',
    'SkiaSharp-LICENSE.txt', 'SkiaSharp-native-LICENSE.txt', 'SkiaSharp-THIRD-PARTY-NOTICES.txt',
    'LanceDB-LICENSE.txt', 'Apache-Arrow-LICENSE.txt',
  ]) await required(file)
  for (const extension of ['foxwarm-fs', 'foxwarm-scm', 'foxwarm-terminal', 'foxwarm-webui']) {
    await required(`packages/vscode-web/${extension}/package.json`)
    await required(`packages/vscode-web/${extension}/dist/extension.js`)
  }
  assert((await readdir(join(root, 'webui-dist/assets'))).some(file => file.endsWith('.js')), 'Built WebUI JavaScript is missing')
  for (const file of [
    'Foxwarm.Desktop.exe', 'ToolScript/native/monty.exe',
    'e_sqlite3.dll', 'libSkiaSharp.dll', 'lancedb_ffi.dll',
    'node_modules/@esbuild/win32-x64/esbuild.exe',
    'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  ]) await native(file)
  // WebView2's SDK can retain its RID layout or flatten it during publish.
  const files = await readdir(root, { recursive: true })
  const loader = files.find(file => /(^|[\\/])WebView2Loader\.dll$/.test(file) && !/win-(?:x86|arm64)/.test(file))
  assert(loader, 'WebView2 x64 loader is missing')
  await native(loader)
  const runtime = JSON.parse(await required('Foxwarm.Desktop.runtimeconfig.json')).runtimeOptions
  assert.equal(runtime.tfm, 'net10.0')
  assert.equal(runtime.includedFrameworks, undefined, 'A framework-dependent package must not embed shared frameworks')
  const frameworks = runtime.frameworks ?? [runtime.framework]
  for (const name of ['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App', 'Microsoft.AspNetCore.App']) {
    assert(frameworks.some(item => item?.name === name && /^10\./.test(item.version)), `Missing .NET 10 shared framework: ${name}`)
  }
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/')
    assert(!/^(?:state|agents|workspace|logs|\.git|\.github|src|dotnet|test|obj|bin|runtime|shared|host)(?:\/|$)/i.test(normalized), `Installation/build data in package: ${file}`)
    assert(!/^(?:Foxwarm(?:\.exe|\.runtimeconfig\.json)?|data_dir|package(?:-lock)?\.json|coreclr\.dll|hostfxr\.dll|hostpolicy\.dll|System\.Private\.CoreLib\.dll|dotnet\.exe)$/i.test(normalized), `Console entry, source cache or runtime in package: ${file}`)
    assert(!/(?:^|\/)(?:\.env|token|config\.yaml|models\.yaml|\.npm|\.cache)(?:\/|$)/i.test(normalized), `Private state or cache in package: ${file}`)
    assert(!/^node_modules\/(?:\.package-lock\.json|\.bin)(?:\/|$)/.test(normalized), `Source dependency tree in package: ${file}`)
    assert(!/\.(?:pdb|xml)$/i.test(normalized), `Debug/reference artifact in package: ${file}`)
  }
  return { platform: 'win-x64', frameworkDependent: true, entries: files.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: node dotnet/scripts/validate-desktop-package.mjs EXTRACTED_DIRECTORY')
  console.log(JSON.stringify(await validateDesktopPackage(process.argv[2])))
}
