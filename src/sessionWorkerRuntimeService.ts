import { defineRpcService, rpcMethod, RpcError, type RpcServiceHandler } from './rpc';
import type { SessionWorkerProjection } from './sessionWorkerPersistence';
import type { SessionWorkerActivationGate } from './sessionWorkerControlService';
import type { SessionWorkerHost } from './sessionWorkerHost';
import type { CompactionRequest } from './types';

export type SessionWorkerIdleStatus = { busy: boolean; queueLength: number; runningExecCount: number };
export type SessionWorkerInterruptResult = { stopping: boolean; abortedInFlight: boolean };

export const sessionWorkerRuntimeServiceDescriptor = defineRpcService('session-worker-runtime', 2, {
  runPending: rpcMethod<{ limit: number }, SessionWorkerProjection>(),
  compactAwaited: rpcMethod<{ request: CompactionRequest }, { compacted: boolean; projection: SessionWorkerProjection }>(),
  idleStatus: rpcMethod<Record<string, never>, SessionWorkerIdleStatus>(),
  interrupt: rpcMethod<Record<string, never>, SessionWorkerInterruptResult>(),
});

export function createSessionWorkerRuntimeServiceHandler(
  gate: SessionWorkerActivationGate,
  host: SessionWorkerHost,
): RpcServiceHandler<typeof sessionWorkerRuntimeServiceDescriptor> {
  return {
    async idleStatus(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw new RpcError('SESSION_WORKER_IDLE_STATUS_INVALID', 'idleStatus takes an empty request object.');
      }
      return host.idleStatus();
    },
    async interrupt(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw new RpcError('SESSION_WORKER_INTERRUPT_INVALID', 'interrupt takes an empty request object.');
      }
      return host.interrupt();
    },
    async runPending(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'limit')
        || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 4096) {
        throw new RpcError('SESSION_WORKER_MAILBOX_LIMIT', 'Mailbox prefix limit must be an integer from 1 through 4096.');
      }
      return host.runPending(input.limit);
    },
    async compactAwaited(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
        || !input.request || typeof input.request !== 'object' || Array.isArray(input.request)) {
        throw new RpcError('SESSION_WORKER_COMPACTION_INVALID', 'Compaction request must be a plain bounded object.');
      }
      const keys = Object.keys(input.request); const allowed = new Set(['keepPercent', 'compactGuidance', 'completionMarker']);
      if (keys.some(key => !allowed.has(key))) throw new RpcError('SESSION_WORKER_COMPACTION_INVALID', 'Compaction request contains unsupported fields.');
      const request = input.request;
      if (request.keepPercent !== undefined && (!Number.isFinite(request.keepPercent) || request.keepPercent! <= 0 || request.keepPercent! > 1)) throw new RpcError('SESSION_WORKER_COMPACTION_INVALID', 'keepPercent must be greater than zero and at most one.');
      for (const key of ['compactGuidance', 'completionMarker'] as const) {
        const value = request[key]; if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16_384)) throw new RpcError('SESSION_WORKER_COMPACTION_INVALID', `${key} must be a bounded string.`);
      }
      return host.compactAwaited(structuredClone(request));
    },
  };
}
