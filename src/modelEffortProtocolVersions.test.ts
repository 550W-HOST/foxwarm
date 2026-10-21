import './testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRuntimeServiceDescriptor } from './sessionRuntimeService';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { sessionWorkerPublicationServiceDescriptor } from './sessionWorkerPublicationService';
import { sessionWorkerPresentationServiceDescriptor } from './sessionWorkerPresentationService';
import { mainManagementToolServiceDescriptor } from './mainManagementToolService';
import { nodeExecutionServiceDescriptor } from './nodeExecutionService';

test('versioned runtime DTO additions advance every affected RPC contract', () => {
  assert.equal(sessionRuntimeServiceDescriptor.version, 15);
  assert.equal(sessionWorkerRuntimeServiceDescriptor.version, 17);
  assert.equal(sessionWorkerPublicationServiceDescriptor.version, 3);
  assert.equal(sessionWorkerPresentationServiceDescriptor.version, 2);
  assert.equal(mainManagementToolServiceDescriptor.version, 20);
  assert.equal(nodeExecutionServiceDescriptor.version, 10);
});
