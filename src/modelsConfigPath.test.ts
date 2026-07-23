import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_MODELS_CONFIG_PATH,
  getActiveModelsConfigPath,
  getModelsConfigReadPath,
  resolveDataModelsConfigPath,
} from './config';

const execFileAsync = promisify(execFile);

test('models config path follows the Foxwarm data directory only', () => {
  assert.equal(resolveDataModelsConfigPath('/srv/foxwarm-a'), path.join('/srv/foxwarm-a', 'state', 'models.yaml'));
  assert.equal(resolveDataModelsConfigPath('/srv/foxwarm-b'), path.join('/srv/foxwarm-b', 'state', 'models.yaml'));
  assert.equal(getActiveModelsConfigPath(), DEFAULT_MODELS_CONFIG_PATH);

  const oldOverride = process.env.MODELS_CONFIG_PATH;
  process.env.MODELS_CONFIG_PATH = '/ignored/legacy-models.yaml';
  try {
    assert.equal(getActiveModelsConfigPath(), DEFAULT_MODELS_CONFIG_PATH);
  } finally {
    if (oldOverride === undefined) delete process.env.MODELS_CONFIG_PATH;
    else process.env.MODELS_CONFIG_PATH = oldOverride;
  }
});

test('template is a read-only fallback and never the editable models path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-models-path-'));
  const activePath = path.join(dir, 'data', 'state', 'models.yaml');
  const templatePath = path.join(dir, 'templates', 'models.example.yaml');
  await fs.ensureDir(path.dirname(templatePath));
  await fs.writeFile(templatePath, 'default: example\nproviders: {}\n', 'utf8');

  try {
    assert.equal(getModelsConfigReadPath(activePath, templatePath), templatePath);
    await fs.ensureDir(path.dirname(activePath));
    await fs.writeFile(activePath, 'default: active\nproviders: {}\n', 'utf8');
    assert.equal(getModelsConfigReadPath(activePath, templatePath), activePath);
  } finally {
    await fs.remove(dir);
  }
});

test('runtime, Setup diagnostics, OOBE, and writes share the data-directory models path', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-models-data-root-'));
  const removedOverridePath = path.join(dataRoot, 'removed-models-path.yaml');
  await fs.ensureDir(path.join(dataRoot, 'state'));
  await fs.writeFile(
    path.join(dataRoot, 'state', 'config.yaml'),
    `paths:\n  modelsConfigPath: ${JSON.stringify(removedOverridePath)}\n`,
    'utf8',
  );
  const script = `
    const fs = require('fs');
    const config = require('./lib/config.js');
    const setup = require('./lib/setupConfig.js');
    const webui = require('./lib/channels/webuiChannel.js');
    const before = webui.getModelsSetupDiagnostics();
    const fallback = config.getModelsConfigReadPath();
    const yaml = 'default: local\\nproviders:\\n  local:\\n    providerType: openai-completions\\n    models: [model-a]\\n';
    setup.writeRawModelsConfig(yaml);
    const after = webui.getModelsSetupDiagnostics();
    const loaded = config.loadModelsConfig();
    process.stdout.write('__FOXWARM_RESULT__' + JSON.stringify({
      active: config.getActiveModelsConfigPath(),
      fallback,
      beforePath: before.path,
      beforeOobe: before.oobe,
      afterPath: after.path,
      afterOobe: after.oobe,
      written: fs.readFileSync(config.getActiveModelsConfigPath(), 'utf8'),
      defaultModel: loaded.default,
      removedOverrideExists: fs.existsSync(${JSON.stringify(removedOverridePath)}),
    }) + '\\n', () => process.exit(0));
  `;

  try {
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FOXWARM_DATA_DIR: dataRoot,
        MODELS_CONFIG_PATH: path.join(dataRoot, 'ignored-legacy-models.yaml'),
      },
    });
    const resultLine = stdout.split('\n').find((line) => line.startsWith('__FOXWARM_RESULT__'));
    assert.ok(resultLine, `child process did not return a result: ${stdout}`);
    const result = JSON.parse(resultLine.slice('__FOXWARM_RESULT__'.length));
    const expectedPath = path.join(dataRoot, 'state', 'models.yaml');
    assert.equal(result.active, expectedPath);
    assert.equal(result.beforePath, expectedPath);
    assert.equal(result.beforeOobe, true);
    assert.equal(result.afterPath, expectedPath);
    assert.equal(result.afterOobe, false);
    assert.match(result.fallback, /templates[/\\]models\.example\.yaml$/);
    assert.match(result.written, /^default: local/);
    assert.equal(result.defaultModel, 'local');
    assert.equal(result.removedOverrideExists, false);
  } finally {
    await fs.remove(dataRoot);
  }
});