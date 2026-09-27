import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import Module from 'node:module';

class MockUri {
  constructor(scheme, authority, path) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
  }
  static parse(value) {
    const parsed = new URL(value);
    return new MockUri(parsed.protocol.slice(0, -1), parsed.host, parsed.pathname);
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

const vscodeMock = {
  Uri: MockUri,
  extensions: { getExtension: () => undefined },
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const extension = require('../dist/extension.js');
const files = {
  app: { kind: 'app', nodeId: 'master', path: '/data root/state/config.yaml' },
  models: { kind: 'models', nodeId: 'master', path: '/data root/state/models.yaml' },
};

test('schema contributor matches only exact canonical master config URIs', () => {
  assert.equal(
    extension.getFoxwarmConfigSchemaUri('foxwarm://node+master/data%20root/state/models.yaml', files),
    extension.FOXWARM_MODELS_SCHEMA_URI,
  );
  assert.equal(
    extension.getFoxwarmConfigSchemaUri('foxwarm://node+master/data%20root/state/./config.yaml', files),
    extension.FOXWARM_APP_SCHEMA_URI,
  );
  assert.equal(extension.getFoxwarmConfigSchemaUri('foxwarm://node+worker-1/data%20root/state/models.yaml', files), undefined);
  assert.equal(extension.getFoxwarmConfigSchemaUri('foxwarm://node+master/other/models.yaml', files), undefined);
  assert.equal(extension.getFoxwarmConfigSchemaUri('file:///data%20root/state/models.yaml', files), undefined);
  assert.equal(extension.getFoxwarmConfigSchemaUri('not a URI', files), undefined);
});

test('schema contributor returns bundled shared schemas without config data or external URLs', () => {
  const models = JSON.parse(extension.getFoxwarmConfigSchemaContent(extension.FOXWARM_MODELS_SCHEMA_URI));
  const app = JSON.parse(extension.getFoxwarmConfigSchemaContent(extension.FOXWARM_APP_SCHEMA_URI));
  assert.equal(models.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(app.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(models.title, 'Foxwarm models configuration');
  assert.equal(app.title, 'Foxwarm application configuration');
  const providerValue = models.properties.providers.additionalProperties;
  const aliasSchema = providerValue.oneOf.find(entry => entry.type === 'string');
  assert.equal(aliasSchema.pattern, '\\S');
  assert.equal(app.properties.llm.properties.maxOutput.default, 32768);
  assert.equal(app.properties.llm.properties.compactKeepPercent.default, 0.3);
  assert.equal(app.properties.llm.properties.compactThresholdPercent.default, 0.85);
  assert.equal(Object.hasOwn(app.properties.llm.properties, 'compactPercent'), false);
  assert.equal(app.properties.vector.oneOf.some(entry => entry.const === false), true);
  assert.equal(app.properties.vector.oneOf.find(entry => entry.type === 'object').properties.baseUrl.pattern, '^https?://');
  const nodeProviderVariants = app.properties.nodeProviders.additionalProperties.oneOf;
  assert.deepEqual(nodeProviderVariants.map(entry => entry.properties.type.const), ['executable', 'docker-worktree']);
  const dockerWorktree = nodeProviderVariants.find(entry => entry.properties.type.const === 'docker-worktree');
  assert.deepEqual(dockerWorktree.required, ['type', 'command', 'image', 'allowedWorktreeRoots']);
  assert.deepEqual(dockerWorktree.properties.networkModes.default, ['none']);
  assert.equal(dockerWorktree.properties.memory.default, '2g');
  assert.equal(dockerWorktree.properties.cpus.default, 2);
  assert.equal(dockerWorktree.properties.pidsLimit.default, 256);
  assert.equal(dockerWorktree.properties.tmpfsSize.default, '256m');
  assert.match(app.properties.llm.properties.ollamaBaseUrl.description, /Legacy vector endpoint root/);
  assert.equal(JSON.stringify({ models, app }).includes('apiKeyValue'), false);
  assert.throws(() => extension.getFoxwarmConfigSchemaContent('https://example.invalid/schema.json'), /Unknown/);
});

test('registers the Red Hat YAML contributor and degrades cleanly when the extension is absent', async () => {
  let registration;
  const registered = await extension.registerFoxwarmConfigSchemas(files, {
    getExtension: (id) => ({
      activate: async () => ({
        registerContributor: (...args) => {
          registration = { id, args };
          return true;
        },
      }),
    }),
  });
  assert.equal(registered, true);
  assert.equal(registration.id, 'redhat.vscode-yaml');
  assert.equal(registration.args[0], 'foxwarm-config');
  assert.equal(registration.args[1]('foxwarm://node+master/data%20root/state/models.yaml'), extension.FOXWARM_MODELS_SCHEMA_URI);
  assert.equal(JSON.parse(registration.args[2](extension.FOXWARM_APP_SCHEMA_URI)).title, 'Foxwarm application configuration');

  assert.equal(await extension.registerFoxwarmConfigSchemas(files, { getExtension: () => undefined }), false);
});
