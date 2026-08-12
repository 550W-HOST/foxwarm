import test from 'node:test';
import assert from 'node:assert/strict';
import { definitions } from './definitions';

const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

test('Stage 3 model-facing creation and child-setting schemas expose canonical effort fields', () => {
  const child = definitions.find(def => def.name === 'create_child_session')!;
  const create = definitions.find(def => def.name === 'create_session')!;
  const settings = definitions.find(def => def.name === 'set_session_child_model')!;
  assert.deepEqual((child.parameters.properties as any).effort.enum, efforts);
  assert.equal(typeof (child.parameters.properties as any).model, 'object');
  assert.deepEqual((create.parameters.properties as any).effort.enum, efforts);
  assert.deepEqual((settings.parameters.properties as any).effort.enum, [...efforts, 'default', 'unset']);
  assert.equal((settings.parameters.properties as any).clearEffort, undefined);
});
