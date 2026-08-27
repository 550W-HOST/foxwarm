import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRuntimeServiceDescriptor } from './sessionRuntimeService';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { sessionWorkerPublicationServiceDescriptor } from './sessionWorkerPublicationService';
import { mainManagementToolServiceDescriptor } from './mainManagementToolService';
import { nodeExecutionServiceDescriptor } from './nodeExecutionService';

test('versioned runtime DTO additions advance every affected RPC contract', () => {
  assert.equal(sessionRuntimeServiceDescriptor.version, 10);
  assert.equal(sessionWorkerRuntimeServiceDescriptor.version, 13);
  assert.equal(sessionWorkerPublicationServiceDescriptor.version, 3);
  assert.equal(mainManagementToolServiceDescriptor.version, 7);
  assert.equal(nodeExecutionServiceDescriptor.version, 3);
});
