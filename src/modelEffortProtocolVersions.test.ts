import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRuntimeServiceDescriptor } from './sessionRuntimeService';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { sessionWorkerPublicationServiceDescriptor } from './sessionWorkerPublicationService';
import { mainManagementToolServiceDescriptor } from './mainManagementToolService';

test('versioned runtime DTO additions advance every affected RPC contract', () => {
  assert.equal(sessionRuntimeServiceDescriptor.version, 9);
  assert.equal(sessionWorkerRuntimeServiceDescriptor.version, 12);
  assert.equal(sessionWorkerPublicationServiceDescriptor.version, 3);
  assert.equal(mainManagementToolServiceDescriptor.version, 5);
});
