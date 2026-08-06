import { defineRpcService, rpcMethod, RpcError, type RpcServiceHandler } from './rpc';
import type { SessionWorkerProjection } from './sessionWorkerPersistence';
import type { SessionWorkerActivationGate } from './sessionWorkerControlService';
import type { SessionWorkerHost } from './sessionWorkerHost';

export const sessionWorkerRuntimeServiceDescriptor = defineRpcService('session-worker-runtime', 1, {
  runPending: rpcMethod<{ limit: number }, SessionWorkerProjection>(),
});

export function createSessionWorkerRuntimeServiceHandler(
  gate: SessionWorkerActivationGate,
  host: SessionWorkerHost,
): RpcServiceHandler<typeof sessionWorkerRuntimeServiceDescriptor> {
  return {
    async runPending(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'limit')
        || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 4096) {
        throw new RpcError('SESSION_WORKER_MAILBOX_LIMIT', 'Mailbox prefix limit must be an integer from 1 through 4096.');
      }
      return host.runPending(input.limit);
    },
  };
}
