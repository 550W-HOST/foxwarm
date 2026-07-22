import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelConfigEntry } from './config';
import {
  beginVirtualRoutingRequest,
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
  const request = beginVirtualRoutingRequest('fallback', entry);
  let now = 100;
  setVirtualRoutingClockForTests(() => now);

  const first = selectVirtualTarget(request, 'cache');
  assert.equal(first.targetKey, 'a/model');
  assert.deepEqual(recordVirtualTargetFailure(request, first), {
    terminal: false,
    enteredCooldown: false,
    consecutiveFailures: 1,
  });
  recordVirtualTargetSuccess(request, 'a/model');
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', entry), {});

  recordVirtualTargetFailure(request, first);
  assert.equal(recordVirtualTargetFailure(request, first).enteredCooldown, true);
  assert.equal(selectVirtualTarget(request, 'cache').targetKey, 'b/model');

  now = 1100;
  assert.equal(selectVirtualTarget(request, 'cache').targetKey, 'a/model');
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', entry), {});
  assert.equal(recordVirtualTargetFailure(request, first).consecutiveFailures, 1);
});

test('last-target failure clears route state, invalidates shared requests, and next request starts at A', () => {
  const entry = failoverEntry();
  const request = beginVirtualRoutingRequest('fallback', entry);
  const concurrentRequest = beginVirtualRoutingRequest('fallback', entry);
  const first = selectVirtualTarget(request, 'cache');
  recordVirtualTargetFailure(request, first);
  recordVirtualTargetFailure(request, first);
  const last = selectVirtualTarget(request, 'cache');
  assert.equal(last.targetKey, 'b/model');
  assert.deepEqual(recordVirtualTargetFailure(request, last), {
    terminal: true,
    enteredCooldown: false,
    consecutiveFailures: 1,
  });
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', entry), {});
  assert.equal(recordVirtualTargetFailure(concurrentRequest, first).consecutiveFailures, 0);
  const nextRequest = beginVirtualRoutingRequest('fallback', entry);
  assert.equal(selectVirtualTarget(nextRequest, 'cache').targetKey, 'a/model');
});

test('health is isolated by virtual key and config fingerprint', () => {
  const firstConfig = failoverEntry('fp-one');
  const changedConfig = failoverEntry('fp-two');
  const firstRequest = beginVirtualRoutingRequest('fallback', firstConfig);
  const first = selectVirtualTarget(firstRequest, 'cache');
  recordVirtualTargetFailure(firstRequest, first);
  recordVirtualTargetFailure(firstRequest, first);

  assert.equal(selectVirtualTarget(firstRequest, 'cache').targetKey, 'b/model');
  const otherRouteRequest = beginVirtualRoutingRequest('other-route', firstConfig);
  assert.equal(selectVirtualTarget(otherRouteRequest, 'cache').targetKey, 'a/model');
  const changedRequest = beginVirtualRoutingRequest('fallback', changedConfig);
  assert.equal(selectVirtualTarget(changedRequest, 'cache').targetKey, 'a/model');
  assert.deepEqual(recordVirtualTargetFailure(firstRequest, first), {
    terminal: false,
    enteredCooldown: false,
    consecutiveFailures: 0,
  }, 'an in-flight completion from a stale config must not affect the active route');
  assert.equal(selectVirtualTarget(changedRequest, 'cache').targetKey, 'a/model');
});

test('old retries cannot reactivate an obsolete fingerprint or disturb the new generation', () => {
  const oldConfig = failoverEntry('fp-old');
  const newConfig = failoverEntry('fp-new');

  const oldRequest = beginVirtualRoutingRequest('fallback', oldConfig);
  const oldFirst = selectVirtualTarget(oldRequest, 'cache');
  assert.equal(recordVirtualTargetFailure(oldRequest, oldFirst).consecutiveFailures, 1);

  const newRequest = beginVirtualRoutingRequest('fallback', newConfig);
  const newFirst = selectVirtualTarget(newRequest, 'cache');
  assert.equal(recordVirtualTargetFailure(newRequest, newFirst).consecutiveFailures, 1);
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', newConfig), {
    'a/model': { consecutiveFailures: 1, cooldownUntil: 0 },
  });

  const oldRetry = selectVirtualTarget(oldRequest, 'cache');
  assert.equal(oldRetry.targetKey, 'a/model', 'retry uses the old request snapshot without activating it');
  assert.equal(recordVirtualTargetFailure(oldRequest, oldRetry).consecutiveFailures, 0);
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', newConfig), {
    'a/model': { consecutiveFailures: 1, cooldownUntil: 0 },
  }, 'stale selection and completion leave the new state intact');

  assert.equal(recordVirtualTargetFailure(newRequest, newFirst).enteredCooldown, true);
  assert.equal(selectVirtualTarget(newRequest, 'cache').targetKey, 'b/model');

  const rolledBackRequest = beginVirtualRoutingRequest('fallback', oldConfig);
  assert.equal(selectVirtualTarget(rolledBackRequest, 'cache').targetKey, 'a/model');
  assert.deepEqual(getVirtualRoutingStateForTests('fallback', oldConfig), {}, 'an actual rollback request activates a fresh old fingerprint');
});

test('completion-order outcomes define consecutive failures', () => {
  const entry = failoverEntry();
  const request = beginVirtualRoutingRequest('fallback', entry);
  const selection = selectVirtualTarget(request, 'cache');
  recordVirtualTargetFailure(request, selection);
  recordVirtualTargetSuccess(request, selection.targetKey);
  const afterSuccess = recordVirtualTargetFailure(request, selection);
  assert.equal(afterSuccess.consecutiveFailures, 1);
  assert.equal(afterSuccess.enteredCooldown, false);
});
