import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SESSION_WORKER_IDLE_SECONDS,
  DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS,
  MAX_SESSION_WORKER_IDLE_SECONDS,
  MIN_SESSION_WORKER_IDLE_SECONDS,
  normalizeDbWorkersEnabled,
  normalizeSessionWorkersConfig,
  normalizeVectorConfig,
  normalizeVectorMaintenanceConfig,
} from './config';
import { validateAppConfigYaml } from './setupConfig';

test('sessionWorkers and vector default off while dbWorkers defaults on', () => {
  assert.deepEqual(normalizeSessionWorkersConfig(undefined), {
    enabled: false,
    idleSeconds: DEFAULT_SESSION_WORKER_IDLE_SECONDS,
  });
  assert.equal(normalizeDbWorkersEnabled(undefined), true);
  assert.deepEqual(normalizeVectorConfig(undefined), { enabled: false, source: 'disabled-default' });
  assert.deepEqual(normalizeVectorMaintenanceConfig(undefined), {
    enabled: true,
    retentionHours: DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS,
  });
});

test('vector config validates explicit enablement and preserves exact API roots', () => {
  assert.deepEqual(normalizeVectorConfig(false), { enabled: false, source: 'vector' });
  assert.deepEqual(normalizeVectorConfig({ enabled: false }), { enabled: false, source: 'vector' });
  assert.deepEqual(normalizeVectorConfig({ enabled: false, baseUrl: ' https://example.test/openai/v1/ ' }), {
    enabled: false, baseUrl: 'https://example.test/openai/v1', source: 'vector',
  });
  assert.deepEqual(normalizeVectorConfig({ baseUrl: 'http://host.test:3082/v1/' }), {
    enabled: true, baseUrl: 'http://host.test:3082/v1', source: 'vector',
  });
  assert.deepEqual(normalizeVectorConfig({ enabled: true, baseUrl: 'https://gateway.test/openai/v1/' }), {
    enabled: true, baseUrl: 'https://gateway.test/openai/v1', source: 'vector',
  });
  assert.throws(() => normalizeVectorConfig(true), /must be false or an object/);
  assert.throws(() => normalizeVectorConfig('enabled'), /must be false or an object/);
  assert.throws(() => normalizeVectorConfig({}), /baseUrl.*non-empty absolute http\(s\) URL/);
  assert.throws(() => normalizeVectorConfig({ enabled: 'yes', baseUrl: 'https://example.test/v1' }), /enabled.*boolean/);
  assert.throws(() => normalizeVectorConfig({ baseUrl: '/v1' }), /absolute http\(s\) URL/);
  assert.throws(() => normalizeVectorConfig({ baseUrl: 'ftp://example.test/v1' }), /absolute http\(s\) URL/);
  assert.throws(() => normalizeVectorConfig({ baseUrl: 'https://user@example.test/v1' }), /absolute http\(s\) URL/);
  assert.throws(() => normalizeVectorConfig({ baseUrl: 'https://user:pass@example.test/v1' }), /absolute http\(s\) URL/);
  assert.throws(() => normalizeVectorConfig({ baseUrl: 'https://example.test/v1?tenant=one' }), /absolute http\(s\) URL/);
  assert.throws(() => normalizeVectorConfig({ baseUrl: 'https://example.test/v1#embedding' }), /absolute http\(s\) URL/);
  assert.deepEqual(normalizeVectorConfig({ baseUrl: 'https://example.test/' }), {
    enabled: true, baseUrl: 'https://example.test', source: 'vector',
  });
});

test('legacy llm.ollamaBaseUrl enables vector only when top-level vector is absent', () => {
  assert.deepEqual(normalizeVectorConfig(undefined, ' http://legacy.test:3082/ '), {
    enabled: true, baseUrl: 'http://legacy.test:3082/v1', source: 'legacy-ollama',
  });
  assert.deepEqual(normalizeVectorConfig(undefined, 'http://legacy.test:3082/v1/'), {
    enabled: true, baseUrl: 'http://legacy.test:3082/v1', source: 'legacy-ollama',
  });
  assert.deepEqual(normalizeVectorConfig(undefined, 'https://gateway.test/openai/v1/'), {
    enabled: true, baseUrl: 'https://gateway.test/openai/v1', source: 'legacy-ollama',
  });
  assert.throws(() => normalizeVectorConfig(undefined, 'https://user@legacy.test'), /absolute http\(s\) URL/);
  assert.throws(() => normalizeVectorConfig(undefined, 'https://legacy.test?tenant=one'), /absolute http\(s\) URL/);
  assert.throws(() => normalizeVectorConfig(undefined, 'https://legacy.test#embedding'), /absolute http\(s\) URL/);
  assert.deepEqual(normalizeVectorConfig(false, 'http://legacy.test:3082'), { enabled: false, source: 'vector' });
  assert.deepEqual(normalizeVectorConfig({ baseUrl: 'https://new.test/custom/v1' }, 'http://legacy.test:3082'), {
    enabled: true, baseUrl: 'https://new.test/custom/v1', source: 'vector',
  });
});

test('vectorMaintenance defaults on with a validated retention window', () => {
  assert.deepEqual(normalizeVectorMaintenanceConfig({}), { enabled: true, retentionHours: 24 });
  assert.deepEqual(normalizeVectorMaintenanceConfig(true), { enabled: true, retentionHours: 24 });
  assert.deepEqual(normalizeVectorMaintenanceConfig(false), { enabled: false, retentionHours: 24 });
  assert.deepEqual(normalizeVectorMaintenanceConfig({ enabled: false, retentionHours: 48 }), {
    enabled: false,
    retentionHours: 48,
  });
  assert.throws(() => normalizeVectorMaintenanceConfig({ enabled: 'yes' }), /enabled.*boolean/);
  assert.throws(() => normalizeVectorMaintenanceConfig({ retentionHours: '24' }), /retentionHours.*number/);
  assert.throws(() => normalizeVectorMaintenanceConfig({ retentionHours: 0 }), /positive integer/);
  assert.throws(() => normalizeVectorMaintenanceConfig({ retentionHours: 1.5 }), /positive integer/);
});

test('sessionWorkers boolean and object forms normalize predictably', () => {
  assert.deepEqual(normalizeSessionWorkersConfig(false), {
    enabled: false,
    idleSeconds: DEFAULT_SESSION_WORKER_IDLE_SECONDS,
  });
  assert.deepEqual(normalizeSessionWorkersConfig(true), {
    enabled: true,
    idleSeconds: DEFAULT_SESSION_WORKER_IDLE_SECONDS,
  });
  assert.deepEqual(normalizeSessionWorkersConfig({}), {
    enabled: true,
    idleSeconds: DEFAULT_SESSION_WORKER_IDLE_SECONDS,
  });
  assert.deepEqual(normalizeSessionWorkersConfig({ enabled: false, idleSeconds: 15 }), {
    enabled: false,
    idleSeconds: 15,
  });
});

test('sessionWorkers idleSeconds accepts the documented inclusive range', () => {
  assert.equal(normalizeSessionWorkersConfig({ idleSeconds: MIN_SESSION_WORKER_IDLE_SECONDS }).idleSeconds, 1);
  assert.equal(normalizeSessionWorkersConfig({ idleSeconds: MAX_SESSION_WORKER_IDLE_SECONDS }).idleSeconds, 86_400);
  assert.throws(() => normalizeSessionWorkersConfig({ idleSeconds: 0 }), /integer between 1 and 86400/);
  assert.throws(() => normalizeSessionWorkersConfig({ idleSeconds: 1.5 }), /integer between 1 and 86400/);
  assert.throws(() => normalizeSessionWorkersConfig({ idleSeconds: 86_401 }), /integer between 1 and 86400/);
  assert.throws(() => normalizeSessionWorkersConfig({ idleSeconds: true }), /idleSeconds.*number/);
  assert.throws(() => normalizeSessionWorkersConfig({ idleSeconds: '60' }), /idleSeconds.*number/);
});

test('app YAML validation rejects invalid worker switch shapes', () => {
  assert.deepEqual(validateAppConfigYaml('sessionWorkers: {}\ndbWorkers: false\nvectorMaintenance: false\n'), {
    sessionWorkers: {},
    dbWorkers: false,
    vectorMaintenance: false,
  });
  assert.deepEqual(validateAppConfigYaml('vectorMaintenance:\n  retentionHours: 48\n'), {
    vectorMaintenance: { retentionHours: 48 },
  });
  assert.deepEqual(validateAppConfigYaml('vector:\n  baseUrl: https://example.test/openai/v1\n'), {
    vector: { baseUrl: 'https://example.test/openai/v1' },
  });
  assert.deepEqual(validateAppConfigYaml('llm:\n  ollamaBaseUrl: http://legacy.test:3082\n'), {
    llm: { ollamaBaseUrl: 'http://legacy.test:3082' },
  });
  assert.throws(() => validateAppConfigYaml('sessionWorkers: yes\n'), /sessionWorkers.*boolean or object/);
  assert.throws(() => validateAppConfigYaml('sessionWorkers:\n  enabled: yes\n'), /sessionWorkers.enabled.*boolean/);
  assert.throws(() => validateAppConfigYaml('sessionWorkers:\n  idleSeconds: true\n'), /idleSeconds.*number/);
  assert.throws(() => validateAppConfigYaml('sessionWorkers:\n  idleSeconds: "60"\n'), /idleSeconds.*number/);
  assert.throws(() => validateAppConfigYaml('dbWorkers: child\n'), /dbWorkers.*boolean/);
  assert.throws(() => validateAppConfigYaml('vector: true\n'), /vector.*false or an object/);
  assert.throws(() => validateAppConfigYaml('vector: {}\n'), /vector.baseUrl.*non-empty absolute/);
  assert.throws(() => validateAppConfigYaml('vectorMaintenance: maybe\n'), /vectorMaintenance.*boolean or object/);
  assert.throws(() => validateAppConfigYaml('vectorMaintenance:\n  retentionHours: 0\n'), /positive integer/);
});
