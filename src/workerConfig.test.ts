import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SESSION_WORKER_IDLE_SECONDS,
  DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS,
  MAX_SESSION_WORKER_IDLE_SECONDS,
  MIN_SESSION_WORKER_IDLE_SECONDS,
  normalizeDbWorkersEnabled,
  normalizeSessionWorkersConfig,
  normalizeVectorMaintenanceConfig,
} from './config';
import { validateAppConfigYaml } from './setupConfig';

test('sessionWorkers defaults off while dbWorkers defaults on', () => {
  assert.deepEqual(normalizeSessionWorkersConfig(undefined), {
    enabled: false,
    idleSeconds: DEFAULT_SESSION_WORKER_IDLE_SECONDS,
  });
  assert.equal(normalizeDbWorkersEnabled(undefined), true);
  assert.deepEqual(normalizeVectorMaintenanceConfig(undefined), {
    enabled: true,
    retentionHours: DEFAULT_VECTOR_MAINTENANCE_RETENTION_HOURS,
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
  assert.throws(() => validateAppConfigYaml('sessionWorkers: yes\n'), /sessionWorkers.*boolean or object/);
  assert.throws(() => validateAppConfigYaml('sessionWorkers:\n  enabled: yes\n'), /sessionWorkers.enabled.*boolean/);
  assert.throws(() => validateAppConfigYaml('sessionWorkers:\n  idleSeconds: true\n'), /idleSeconds.*number/);
  assert.throws(() => validateAppConfigYaml('sessionWorkers:\n  idleSeconds: "60"\n'), /idleSeconds.*number/);
  assert.throws(() => validateAppConfigYaml('dbWorkers: child\n'), /dbWorkers.*boolean/);
  assert.throws(() => validateAppConfigYaml('vectorMaintenance: maybe\n'), /vectorMaintenance.*boolean or object/);
  assert.throws(() => validateAppConfigYaml('vectorMaintenance:\n  retentionHours: 0\n'), /positive integer/);
});
