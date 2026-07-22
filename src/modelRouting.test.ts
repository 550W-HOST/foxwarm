import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelConfigEntry } from './config';
import {
  getVirtualRoutingStateForTests,
  recordVirtualTargetFailure,
  recordVirtualTargetSuccess,
  resetVirtualRoutingStateForTests,
  selectSessionHashTarget,
  selectVirtualTarget,
  setVirtualRoutingClockForTests,
} from './modelRouting';

function failoverEntry(fingerprint = 'fp-one'): ModelConfigEntry {
  return {
    providerKey: 'fallback',
    providerType: 'failover',
    model: '',
    virtualRouting: {
      strategy: 'failover',
      targets: ['a/model', 'b/model'],
      failureThreshold: 2,
      cooldownMs: 1000,
      fingerprint,
    },
  };
}

test.afterEach(() => resetVirtualRoutingStateForTests());

test('session-hash uses stable namespaced SHA-256 HRW vectors independent of target order', () => {
  const targets = ['a/model', 'b/model', 'c/model'];
  assert.equal(selectSessionHashTarget('pool', '11111111-2222-3333-4444-555555555555', targets).targetKey, 'b/model');
  assert.equal(selectSessionHashTarget('pool', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', targets).targetKey, 'c/model');
  assert.equal(selectSessionHashTarget('other', '11111111-2222-3333-4444-555555555555', targets).targetKey, 'a/model');
  assert.equal(
    selectSessionHashTarget('pool', '11111111-2222-3333-4444-555555555555', [...targets].reverse()).targetKey,
    'b/model',
  );
});

test('failover cools a target at threshold, resets its streak after expiry, and resets on success', () => {
  const entry = failoverEntry();
  let now = 100;
  setVirtualRoutingClockForTests(() => now);

  const first = selectVirtualTarget('fallback', entry, 'cache');
  assert.equal(first.targetKey, 'a/model');
  assert.deepEqual(recordVirtualTargetFailure('fallback', entry, first), {
    terminal: false,
    enteredCooldown: false,
    consecutiveFailures: 1,
  });
  recordVirtualTargetSuccess('fallback', entry, 'a/model');
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', entry), {});

  recordVirtualTargetFailure('fallback', entry, first);
  assert.equal(recordVirtualTargetFailure('fallback', entry, first).enteredCooldown, true);
  assert.equal(selectVirtualTarget('fallback', entry, 'cache').targetKey, 'b/model');

  now = 1100;
  assert.equal(selectVirtualTarget('fallback', entry, 'cache').targetKey, 'a/model');
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', entry), {});
  assert.equal(recordVirtualTargetFailure('fallback', entry, first).consecutiveFailures, 1);
});

test('last-target failure clears route state and makes the current request terminal', () => {
  const entry = failoverEntry();
  const first = selectVirtualTarget('fallback', entry, 'cache');
  recordVirtualTargetFailure('fallback', entry, first);
  recordVirtualTargetFailure('fallback', entry, first);
  const last = selectVirtualTarget('fallback', entry, 'cache');
  assert.equal(last.targetKey, 'b/model');
  assert.deepEqual(recordVirtualTargetFailure('fallback', entry, last), {
    terminal: true,
    enteredCooldown: false,
    consecutiveFailures: 1,
  });
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', entry), {});
  assert.equal(selectVirtualTarget('fallback', entry, 'cache').targetKey, 'a/model');
});

test('health is isolated by virtual key and config fingerprint', () => {
  const firstConfig = failoverEntry('fp-one');
  const changedConfig = failoverEntry('fp-two');
  const first = selectVirtualTarget('fallback', firstConfig, 'cache');
  recordVirtualTargetFailure('fallback', firstConfig, first);
  recordVirtualTargetFailure('fallback', firstConfig, first);

  assert.equal(selectVirtualTarget('fallback', firstConfig, 'cache').targetKey, 'b/model');
  assert.equal(selectVirtualTarget('other-route', firstConfig, 'cache').targetKey, 'a/model');
  assert.equal(selectVirtualTarget('fallback', changedConfig, 'cache').targetKey, 'a/model');
  assert.deepEqual(recordVirtualTargetFailure('fallback', firstConfig, first), {
    terminal: false,
    enteredCooldown: false,
    consecutiveFailures: 0,
  }, 'an in-flight completion from a stale config must not affect the active route');
  assert.equal(selectVirtualTarget('fallback', changedConfig, 'cache').targetKey, 'a/model');
});

test('completion-order outcomes define consecutive failures', () => {
  const entry = failoverEntry();
  const selection = selectVirtualTarget('fallback', entry, 'cache');
  recordVirtualTargetFailure('fallback', entry, selection);
  recordVirtualTargetSuccess('fallback', entry, selection.targetKey);
  const afterSuccess = recordVirtualTargetFailure('fallback', entry, selection);
  assert.equal(afterSuccess.consecutiveFailures, 1);
  assert.equal(afterSuccess.enteredCooldown, false);
});
