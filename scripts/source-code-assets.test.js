'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const root = path.dirname(__dirname);
const dotnet = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet') : 'dotnet';

test('source opt-in collects prepared Code and YAML resources; default distribution and absent assets remain optional', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-code-assets-'));
  try {
    const project = path.join(temp, 'dotnet/Foxwarm');
    fs.mkdirSync(project, { recursive: true });
    fs.copyFileSync(path.join(root, 'dotnet/Foxwarm/Delivery.targets'), path.join(project, 'Delivery.targets'));
    fs.writeFileSync(path.join(project, 'fixture.proj'), `<Project>
      <Import Project="Delivery.targets" />
      <Target Name="Collect">
        <ItemGroup><CodeFile Include="@(Content)" Condition="$([System.String]::Copy('%(Content.Link)').StartsWith('packages/vscode-web/assets/'))" /></ItemGroup>
        <Copy SourceFiles="@(CodeFile)" DestinationFiles="@(CodeFile->'$(OutputPath)%(Link)')" />
      </Target>
    </Project>`);
    const files = [
      'vscode-web/out/nls.messages.js',
      'vscode-web/out/vs/workbench/workbench.web.main.internal.js',
      'vscode-web/out/vs/workbench/workbench.web.main.internal.css',
      'vscode-web/node_modules/example/runtime.js',
      'vscode-web/LICENSE',
      'extensions/redhat.vscode-yaml/package.json',
      'extensions/redhat.vscode-yaml/node_modules/example/runtime.js',
    ];
    const assets = path.join(temp, 'packages/vscode-web/assets');
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(assets, file)), { recursive: true });
      fs.writeFileSync(path.join(assets, file), `fixture:${file}`);
    }
    fs.mkdirSync(path.join(assets, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'unrelated/private.txt'), 'not a Code runtime asset');
    function collect(label, include) {
      const output = path.join(temp, label) + path.sep;
      const result = spawnSync(dotnet, ['msbuild', path.join(project, 'fixture.proj'), '-nologo', '-t:Collect',
        `-p:OutputPath=${output}`, ...(include ? ['-p:FoxwarmIncludeCodeAssets=true'] : [])],
      { encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return output;
    }
    const excluded = collect('distribution', false);
    assert.equal(fs.existsSync(path.join(excluded, 'packages/vscode-web/assets')), false);
    const included = collect('source', true);
    for (const file of files) assert.equal(fs.readFileSync(path.join(included, 'packages/vscode-web/assets', file), 'utf8'), `fixture:${file}`);
    assert.equal(fs.existsSync(path.join(included, 'packages/vscode-web/assets/unrelated')), false);
    fs.rmSync(assets, { recursive: true });
    const absent = collect('absent', true);
    assert.equal(fs.existsSync(path.join(absent, 'packages/vscode-web/assets')), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('the source staging entry explicitly enables prepared Code collection', { skip: process.platform === 'win32' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-source-code-'));
  try {
    fs.mkdirSync(path.join(temp, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(root, 'scripts/build-source.js'), path.join(temp, 'scripts/build-source.js'));
    const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
    const journal = path.join(temp, 'dotnet-args.json');
    fs.writeFileSync(path.join(bin, 'dotnet'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(journal)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.join(temp, 'scripts/build-source.js'), '--core-only', '--stage-only'],
      { cwd: temp, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const args = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.equal(args[0], 'build');
    assert.ok(args.includes('-p:FoxwarmIncludeCodeAssets=true'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
