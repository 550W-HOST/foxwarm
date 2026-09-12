import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRuntimeServiceDescriptor } from './sessionRuntimeService';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { sessionWorkerPublicationServiceDescriptor } from './sessionWorkerPublicationService';
import { mainManagementToolServiceDescriptor } from './mainManagementToolService';
import { nodeExecutionServiceDescriptor } from './nodeExecutionService';

test('versioned runtime DTO additions advance every affected RPC contract', () => {
  assert.equal(sessionRuntimeServiceDescriptor.version, 11);
  assert.equal(sessionWorkerRuntimeServiceDescriptor.version, 14);
  assert.equal(sessionWorkerPublicationServiceDescriptor.version, 3);
  assert.equal(mainManagementToolServiceDescriptor.version, 11);
  assert.equal(nodeExecutionServiceDescriptor.version, 4);
});
