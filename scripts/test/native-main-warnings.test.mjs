import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { classify, normalizeCaller, parseWarnings } from './native-main-warnings.mjs'

const script = path.join(import.meta.dirname, 'native-main-warnings.mjs')
const root = '/build/checkout'
const ilc = (file, line, code, caller, member) =>
  `${root}/${file}(${line}): ${code === 'IL2026' ? 'Trim' : 'AOT'} analysis warning ${code}: ${caller}: Using member '${member}' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. [${root}/dotnet/Foxwarm/Foxwarm.csproj]`
const added = ilc('dotnet/Foxwarm/Sessions/Example.cs', 12, 'IL3050', 'Foxwarm.Sessions.Example.<RunAsync>d__7.MoveNext()', 'System.Text.Json.Nodes.JsonArray.Add<String>(String)')
const reviewedKey = 'IL3050 | dotnet/Foxwarm/Vector/VectorWire.cs | Foxwarm.Vector.VectorWire.Read(JsonNode) | System.Text.Json.JsonSerializer.Deserialize<VectorSearchOptions>(JsonNode,JsonSerializerOptions)'
const log = [
  '  Foxwarm -> /build/out/',
  added,
  // MSBuild repeats warnings in its summary; one key remains.
  added,
  ilc('dotnet/Foxwarm/Vector/VectorWire.cs', 40, 'IL3050', 'Foxwarm.Vector.VectorWire.Read(JsonNode)', 'System.Text.Json.JsonSerializer.Deserialize<VectorSearchOptions>(JsonNode,JsonSerializerOptions)'),
  ilc('dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Usage.cs', 92, 'IL3050', 'Foxwarm.Channels.WebUi.WebUIChannel.<<RegisterUsageRoutes>b__11_0>d.MoveNext()', 'Microsoft.AspNetCore.Http.Results.Json<JsonObject>(JsonObject,JsonSerializerOptions,String,Nullable`1<Int32>)'),
  ilc('dotnet/Foxwarm/Sessions/UsageOverview.cs', 50, 'IL3050', 'Foxwarm.Sessions.UsageOverview.Query(Int32)', 'System.Text.Json.Nodes.JsonArray.Add<JsonObject>(JsonObject)'),
  ilc('dotnet/Foxwarm.LanceDb/obj/upstream/src/Connection.cs', 276, 'IL3050', 'LanceDB.Connection.Open()', 'System.Text.Json.JsonSerializer.SerializeToUtf8Bytes<String>(String,JsonSerializerOptions)'),
  '/packages/yamldotnet/18.1.0/lib/net10.0/YamlDotNet.dll : warning IL3053: Assembly \'YamlDotNet\' produced AOT analysis warnings. [/build/checkout/dotnet/Foxwarm/Foxwarm.csproj]',
  // Compile-time analyzer duplicates do not identify a caller; ILC output is authoritative.
  `${root}/dotnet/Foxwarm/Sessions/Example.cs(12,9): warning IL3050: Using member 'System.Text.Json.Nodes.JsonArray.Add<T>(T)' which has 'RequiresDynamicCodeAttribute'. [${root}/dotnet/Foxwarm/Foxwarm.csproj]`,
].join('\n')

test('compiler-generated ordinals do not change a caller key', () => {
  assert.equal(
    normalizeCaller('Foxwarm.X.<>c__DisplayClass74_0.<<MapTaskWrite>b__0>d.MoveNext()'),
    normalizeCaller('Foxwarm.X.<>c__DisplayClass75_3.<<MapTaskWrite>b__0>d.MoveNext()'),
  )
  assert.equal(normalizeCaller('Foxwarm.X.<<Register>b__31_0>d__4.MoveNext()'), 'Foxwarm.X.<<Register>b__N>d__N.MoveNext()')
  assert.equal(normalizeCaller('Foxwarm.X.<Generate>g__Add|12_0(String)'), 'Foxwarm.X.<Generate>g__Add|N(String)')
})

test('only first-party ILC warnings outside the JSON DOM-safe calls need review', () => {
  const result = classify(log, `# comment\n${reviewedKey}\nIL3050 | dotnet/Foxwarm/Old.cs | Foxwarm.Old.Run() | System.Type.MakeGenericType(Type[])\n`)
  assert.equal(parseWarnings(log).keys.size, 5)
  assert.equal(result.firstParty, 4)
  assert.equal(result.domSafe, 2)
  assert.deepEqual(result.added, [{ key: 'IL3050 | dotnet/Foxwarm/Sessions/Example.cs | Foxwarm.Sessions.Example.<RunAsync>d__N.MoveNext() | System.Text.Json.Nodes.JsonArray.Add<String>(String)', lines: [12] }])
  assert.deepEqual(result.stale, ['IL3050 | dotnet/Foxwarm/Old.cs | Foxwarm.Old.Run() | System.Type.MakeGenericType(Type[])'])
  assert.equal(result.nonFirstParty.length, 1)
  assert.equal(result.other.length, 1)
})

test('the command fails on new warnings and rejects a log without a completed publish', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-warnings-'))
  try {
    const file = path.join(directory, 'publish.log')
    await fs.writeFile(file, log)
    const failed = await promisify(execFile)(process.execPath, [script, file]).then(() => null, error => error)
    assert.equal(failed?.code, 1)
    assert.match(failed.stderr, /Example\.cs \| .*Add<String>\(String\) \(line 12\)/)
    await fs.writeFile(file, '')
    const empty = await promisify(execFile)(process.execPath, [script, file]).then(() => null, error => error)
    assert.equal(empty?.code, 2)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
