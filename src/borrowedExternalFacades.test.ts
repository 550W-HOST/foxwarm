import test from 'node:test';
import assert from 'node:assert/strict';
import type { RpcTransport } from './rpc';
import { initializeMainManagementTools, resetMainManagementToolsForTests, shutdownMainManagementTools } from './mainManagementTools';
import { initializeNodeExecution, resetNodeExecutionForTests, shutdownNodeExecution } from './nodeExecution';
import { initializeMcpExternalService, resetMcpExternalServiceForTests, shutdownMcpExternalService } from './mcpExternalService';

test('borrowed reverse facades clear clients without draining or closing their shared transport', async () => {
  let drains = 0; let closes = 0;
  const transport: RpcTransport = {
    async call() { return {}; }, subscribe: () => () => {},
    async drain() { drains += 1; }, close() { closes += 1; },
  };
  await initializeMainManagementTools({ transport, placement: 'child-reverse' });
  await initializeNodeExecution({ transport, placement: 'child-reverse' });
  await initializeMcpExternalService({ transport, placement: 'child-reverse' });
  await Promise.all([shutdownMainManagementTools(), shutdownNodeExecution(), shutdownMcpExternalService()]);
  assert.equal(drains, 0);
  assert.equal(closes, 0);
  resetMainManagementToolsForTests(); resetNodeExecutionForTests(); resetMcpExternalServiceForTests();
});
