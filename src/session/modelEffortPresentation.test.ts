import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelsConfigFromObject } from '../config';
import { buildSessionModelEffortPresentation } from './modelEffortPresentation';

const config = loadModelsConfigFromObject({
  default: 'a/one',
  providers: {
    a: { providerType: 'openai-responses', effort: { allowed: ['low', 'high'], default: 'high' }, models: ['one'] },
    b: { providerType: 'anthropic', effort: { allowed: ['medium', 'max'], default: 'medium' }, models: ['two'] },
    route: { providerType: 'failover', targets: ['a/one', 'b/two'] },
  },
});

test('model effort presentation exposes concrete defaults, virtual union, and tolerant stale fallback', () => {
  const concrete = buildSessionModelEffortPresentation({ model: 'a/one', effort: 'low' }, config);
  assert.deepEqual(concrete.effort, { raw: 'low', effective: 'low', allowed: ['low', 'high'], defaultEffort: 'high' });

  const stale = buildSessionModelEffortPresentation({ model: 'a/one', effort: 'max' }, config);
  assert.equal(stale.effort.raw, 'max');
  assert.equal(stale.effort.effective, 'high');

  const virtual = buildSessionModelEffortPresentation({ childModelDefault: 'route', childEffortDefault: 'medium' }, config);
  assert.deepEqual(virtual.childEffort.allowed, ['low', 'medium', 'high', 'max']);
  assert.equal(virtual.childEffort.defaultEffort, null);
  assert.equal(virtual.childEffort.effective, 'medium');
  const virtualUnset = buildSessionModelEffortPresentation({ model: 'route' }, config);
  assert.equal(virtualUnset.effort.raw, null);
  assert.equal(virtualUnset.effort.effective, 'default');
  assert.equal(virtualUnset.effort.defaultEffort, null);
  assert.equal(virtualUnset.childEffort.raw, null);
  assert.equal(virtualUnset.childEffort.effective, 'default');
  assert.equal(virtualUnset.childEffort.defaultEffort, null);
  assert.equal(buildSessionModelEffortPresentation({ model: 'a/one', effort: 'low' }, config).childEffort.effective, 'low');
});
