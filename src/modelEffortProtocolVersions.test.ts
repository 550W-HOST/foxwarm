import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRuntimeServiceDescriptor } from './sessionRuntimeService';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { sessionWorkerPublicationServiceDescriptor } from './sessionWorkerPublicationService';
import { mainManagementToolServiceDescriptor } from './mainManagementToolService';

test('model-effort DTO additions advance every affected versioned RPC contract', () => {
  assert.equal(sessionRuntimeServiceDescriptor.version, 7);
  assert.equal(sessionWorkerRuntimeServiceDescriptor.version, 9);
  assert.equal(sessionWorkerPublicationServiceDescriptor.version, 2);
  assert.equal(mainManagementToolServiceDescriptor.version, 5);
});
