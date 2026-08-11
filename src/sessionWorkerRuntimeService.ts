import { defineRpcService, rpcMethod, RpcError, type RpcServiceHandler } from './rpc';
import type { SessionWorkerProjection } from './sessionWorkerPersistence';
import type { SessionWorkerActivationGate } from './sessionWorkerControlService';
import type { SessionWorkerHost } from './sessionWorkerHost';
import type { CompactionRequest, QueueSource } from './types';
import type { ToolNoiseCompactionResult } from './session/history';
import { normalizeSessionTurnDeliverySource } from './sessionTurnDelivery';

export type SessionWorkerIdleStatus = { busy: boolean; queueLength: number; runningExecCount: number };
export type SessionWorkerInterruptResult = { stopping: boolean; abortedInFlight: boolean };
export type SessionWorkerDequeueResult = {
  queuedItems: number;
  stoppedCurrent: boolean;
  abortedInFlight: boolean;
};
export type SessionWorkerSettingsPatch = {
  cwd?: string | null;
  model?: string | null;
  childModelDefault?: string | null;
  currentNode?: string | null;
  compactThresholdTokens?: number | null;
  verbose?: boolean;
};
export type SessionWorkerSettings = {
  cwd: string | null;
  model: string | null;
  childModelDefault: string | null;
  currentNode: string | null;
  compactThresholdTokens: number | null;
  verbose: boolean;
};
export type SessionWorkerSettingsResult = {
  changed: string[];
  previous: SessionWorkerSettings;
  current: SessionWorkerSettings;
  projection: SessionWorkerProjection;
};
export type SessionWorkerHistoryMutationResult = {
  deleted?: number;
  remaining?: number;
  compacted?: boolean;
  latestSeq?: number;
  agentName?: string;
  projection: SessionWorkerProjection;
};
export type SessionWorkerToolNoiseCompactionResult =
  | { empty: true; projection: SessionWorkerProjection }
  | { empty: false; result: ToolNoiseCompactionResult; projection: SessionWorkerProjection };

export const sessionWorkerRuntimeServiceDescriptor = defineRpcService('session-worker-runtime', 7, {
  loadProjection: rpcMethod<Record<string, never>, SessionWorkerProjection>(),
  runPending: rpcMethod<{ limit: number }, SessionWorkerProjection>(),
  retry: rpcMethod<{ source?: QueueSource }, SessionWorkerProjection>(),
  dequeue: rpcMethod<Record<string, never>, SessionWorkerDequeueResult>(),
  compactAwaited: rpcMethod<{ request: CompactionRequest }, { compacted: boolean; projection: SessionWorkerProjection }>(),
  compactToolMessages: rpcMethod<{ keepPercent?: number }, SessionWorkerToolNoiseCompactionResult>(),
  updateSettings: rpcMethod<{ patch: SessionWorkerSettingsPatch }, SessionWorkerSettingsResult>(),
  deleteMessages: rpcMethod<{ num: number }, SessionWorkerHistoryMutationResult>(),
  clearHistory: rpcMethod<Record<string, never>, SessionWorkerHistoryMutationResult>(),
  forceIndex: rpcMethod<Record<string, never>, SessionWorkerHistoryMutationResult>(),
  refreshSnapshot: rpcMethod<Record<string, never>, SessionWorkerHistoryMutationResult>(),
  notifyManualForkCreated: rpcMethod<{ childSessionId: string; initialMessage?: string }, { result: 'appended' | 'queued' }>(),
  idleStatus: rpcMethod<Record<string, never>, SessionWorkerIdleStatus>(),
  interrupt: rpcMethod<Record<string, never>, SessionWorkerInterruptResult>(),
  setPresentationSubscription: rpcMethod<{ active: boolean }, { active: boolean }>(),
});

export function createSessionWorkerRuntimeServiceHandler(
  gate: SessionWorkerActivationGate,
  host: SessionWorkerHost,
  options: {
    beforeRetry?: () => void | Promise<void>;
    afterRetryBeforeResponse?: () => void | Promise<void>;
  } = {},
): RpcServiceHandler<typeof sessionWorkerRuntimeServiceDescriptor> {
  return {
    async loadProjection(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw new RpcError('SESSION_WORKER_LOAD_INVALID', 'loadProjection takes an empty request object.');
      }
      return host.loadProjection();
    },
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
    async dequeue(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw new RpcError('SESSION_WORKER_DEQUEUE_INVALID', 'dequeue takes an empty request object.');
      }
      return host.dequeue();
    },
    async setPresentationSubscription(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || typeof input.active !== 'boolean') {
        throw new RpcError('SESSION_WORKER_PRESENTATION_SUBSCRIPTION_INVALID', 'setPresentationSubscription takes { active: boolean }.');
      }
      host.setPresentationSubscription(input.active);
      return { active: input.active };
    },
    async updateSettings(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
        throw new RpcError('SESSION_WORKER_SETTINGS_INVALID', 'updateSettings takes { patch: object }.');
      }
      const allowed = new Set(['cwd', 'model', 'childModelDefault', 'currentNode', 'compactThresholdTokens', 'verbose']);
      const keys = Object.keys(input.patch);
      if (keys.some(key => !allowed.has(key))) throw new RpcError('SESSION_WORKER_SETTINGS_INVALID', 'Session worker settings contain unsupported fields.');
      for (const key of ['cwd', 'model', 'childModelDefault', 'currentNode'] as const) {
        if (!Object.prototype.hasOwnProperty.call(input.patch, key)) continue;
        const value = input.patch[key];
        if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096)) {
          throw new RpcError('SESSION_WORKER_SETTINGS_INVALID', `${key} must be a bounded string or null.`);
        }
      }
      if (Object.prototype.hasOwnProperty.call(input.patch, 'compactThresholdTokens')) {
        const value = input.patch.compactThresholdTokens;
        if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
          throw new RpcError('SESSION_WORKER_SETTINGS_INVALID', 'compactThresholdTokens must be a positive integer or null.');
        }
      }
      if (Object.prototype.hasOwnProperty.call(input.patch, 'verbose') && typeof input.patch.verbose !== 'boolean') {
        throw new RpcError('SESSION_WORKER_SETTINGS_INVALID', 'verbose must be boolean.');
      }
      return host.updateSettings(structuredClone(input.patch));
    },
    async deleteMessages(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || !Number.isSafeInteger(input.num) || input.num === 0) {
        throw new RpcError('SESSION_WORKER_HISTORY_INVALID', 'deleteMessages takes one non-zero integer num.');
      }
      return host.deleteMessages(input.num);
    },
    async clearHistory(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw new RpcError('SESSION_WORKER_HISTORY_INVALID', 'clearHistory takes an empty request object.');
      }
      return host.clearHistory();
    },
    async forceIndex(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw new RpcError('SESSION_WORKER_HISTORY_INVALID', 'forceIndex takes an empty request object.');
      }
      return host.forceIndex();
    },
    async refreshSnapshot(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw new RpcError('SESSION_WORKER_SNAPSHOT_INVALID', 'refreshSnapshot takes an empty request object.');
      }
      return host.refreshSnapshot();
    },
    async notifyManualForkCreated(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || !Object.prototype.hasOwnProperty.call(input, 'childSessionId')
        || Object.keys(input).some(key => !['childSessionId', 'initialMessage'].includes(key))
        || typeof input.childSessionId !== 'string' || !input.childSessionId.trim()
        || (input.initialMessage !== undefined && typeof input.initialMessage !== 'string')) {
        throw new RpcError('SESSION_WORKER_FORK_INVALID', 'notifyManualForkCreated takes a bounded childSessionId and optional initialMessage.');
      }
      return host.notifyManualForkCreated(input.childSessionId, input.initialMessage);
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
    async retry(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'source')) {
        throw new RpcError('SESSION_WORKER_RETRY_INVALID', 'retry takes an optional serialized source only.');
      }
      const source = Object.prototype.hasOwnProperty.call(input, 'source')
        ? normalizeSessionTurnDeliverySource(input.source)
        : undefined;
      await options.beforeRetry?.();
      const projection = await host.retry(source);
      await options.afterRetryBeforeResponse?.();
      return projection;
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
    async compactToolMessages(input) {
      gate.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'keepPercent')) {
        throw new RpcError('SESSION_WORKER_COMPACTION_INVALID', 'Tool-noise compaction takes an optional keepPercent.');
      }
      if (input.keepPercent !== undefined
        && (!Number.isFinite(input.keepPercent) || input.keepPercent <= 0 || input.keepPercent > 1)) {
        throw new RpcError('SESSION_WORKER_COMPACTION_INVALID', 'keepPercent must be greater than zero and at most one.');
      }
      return host.compactToolMessages(input.keepPercent);
    },
  };
}
