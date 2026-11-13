// Validate the extracted delivery, not the source tree or an intermediate build.
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { peImports } from '../../scripts/release/windows-imports.mjs'

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
    return bytes
  }
  const release = JSON.parse(await required('release.json'))
  assert.equal(release.target, 'desktop-win-x64')
  assert.equal(release.native, true, 'The Windows Desktop is a NativeAOT package')
  for (const file of [
    'Foxwarm.ico', 'VC-RUNTIME-NOTICE.txt', 'Microsoft.UI.Xaml.Controls.pri', 'WindowsAppSDK-LICENSE.txt', 'WindowsAppSDK-NOTICE.txt',
    'webui-dist/index.html', 'packages/webui/login.html',
    'templates/agents/00_SYSTEM.md', 'templates/models.example.yaml',
    'templates/node/run.ps1', 'templates/node/run.sh',
    'skills/code-index/SKILL.md', 'skills/code-index/INITIALIZATION.md',
    'skills/react-artifacts/examples/sorting.json',
    'packages/cli-node/dist/client.bundle.js', 'packages/cli-node/dist/tui.bundle.js',
    'packages/browser-host/dist/browser-host.bundle.cjs', 'packages/browser-host/dist/browser-host.bundle.cjs.LEGAL.txt',
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
    'packages/vscode-web/assets/vscode-web/out/nls.messages.js',
    'packages/vscode-web/assets/vscode-web/out/vs/workbench/workbench.web.main.internal.js',
    'packages/vscode-web/assets/vscode-web/out/vs/workbench/workbench.web.main.internal.css',
    'packages/vscode-web/assets/vscode-web/LICENSE.txt',
    'packages/vscode-web/assets/vscode-web/ThirdPartyNotices.txt',
    'packages/vscode-web/assets/extensions/redhat.vscode-yaml/package.json',
    'packages/vscode-web/assets/extensions/redhat.vscode-yaml/LICENSE.txt',
    'packages/vscode-web/assets/extensions/redhat.vscode-yaml/thirdpartynotices.txt',
  ]) await required(file)
  for (const extension of ['foxwarm-fs', 'foxwarm-scm', 'foxwarm-terminal', 'foxwarm-webui']) {
    await required(`packages/vscode-web/${extension}/package.json`)
    await required(`packages/vscode-web/${extension}/dist/extension.js`)
  }
  assert((await readdir(join(root, 'webui-dist/assets'))).some(file => file.endsWith('.js')), 'Built WebUI JavaScript is missing')
  for (const file of [
    'Foxwarm.Desktop.exe', 'ToolScript/native/monty.exe', 'vcruntime140.dll', 'ToolScript/native/vcruntime140.dll',
    'Microsoft.UI.Xaml.dll', 'Microsoft.WindowsAppRuntime.dll', 'Microsoft.Web.WebView2.Core.dll',
    'e_sqlite3.dll', 'libSkiaSharp.dll', 'lancedb_ffi.dll',
    'node_modules/@esbuild/win32-x64/esbuild.exe',
    'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  ]) await native(file)
  // WebView2's SDK can retain its RID layout or flatten it during publish.
  const files = await readdir(root, { recursive: true })
  const loader = files.find(file => /(^|[\\/])WebView2Loader\.dll$/.test(file) && !/win-(?:x86|arm64)/.test(file))
  assert(loader, 'WebView2 x64 loader is missing')
  await native(loader)
  // NativeAOT compiles Main, Desktop and the WinRT projections into the executable: the package
  // has no .NET runtime, host configuration or managed assembly.
  const excluded = /^(?:Foxwarm(?:\.exe)?|data_dir|package(?:-lock)?\.json|dotnet\.exe|coreclr\.dll|hostfxr\.dll|hostpolicy\.dll|clrjit\.dll|System\.Private\.CoreLib\.dll|.*\.runtimeconfig\.json|.*\.deps\.json)$/i
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/')
    if (/\.(?:dll|exe)$/i.test(normalized) && !normalized.startsWith('node_modules/')) {
      // peImports reads native PE images and returns null for managed assemblies.
      assert(peImports(await readFile(join(root, file))) !== null, `Managed assembly in the NativeAOT package: ${file}`)
    }
    assert(!/^(?:state|agents|workspace|logs|\.git|\.github|src|dotnet|test|obj|bin|runtime|shared|host)(?:\/|$)/i.test(normalized), `Installation/build data in package: ${file}`)
    assert(!excluded.test(normalized), `Console entry, source cache or runtime in package: ${file}`)
    assert(!/(?:^|\/)(?:\.env|token|config\.yaml|models\.yaml|\.npm|\.cache)(?:\/|$)/i.test(normalized), `Private state or cache in package: ${file}`)
    assert(!/^node_modules\/(?:\.package-lock\.json|\.bin)(?:\/|$)/.test(normalized), `Source dependency tree in package: ${file}`)
    assert(normalized.startsWith('packages/vscode-web/assets/') || !/\.(?:pdb|xml)$/i.test(normalized), `Debug/reference artifact in package: ${file}`)
  }
  return { platform: 'win-x64', native: true, entries: files.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, 'Usage: node dotnet/scripts/validate-desktop-package.mjs EXTRACTED_DIRECTORY')
  console.log(JSON.stringify(await validateDesktopPackage(process.argv[2])))
}
