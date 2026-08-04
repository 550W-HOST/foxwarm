import {
  defineRpcService,
  rpcMethod,
  RpcError,
  RpcServiceHandler,
} from './rpc';

export type SessionWorkerIdentity = {
  sessionId: string;
  generation: number;
  pid: number;
};

export const sessionWorkerControlServiceDescriptor = defineRpcService('session-worker-control', 1, {
  status: rpcMethod<Record<string, never>, SessionWorkerIdentity & { ready: true }>(),
  touch: rpcMethod<{ timestamp?: number }, { accepted: true; timestamp: number }>(),
});

export function createSessionWorkerControlServiceHandler(
  identity: SessionWorkerIdentity,
): RpcServiceHandler<typeof sessionWorkerControlServiceDescriptor> {
  if (!identity.sessionId || !Number.isSafeInteger(identity.generation) || identity.generation <= 0) {
    throw new RpcError('SESSION_WORKER_INVALID_IDENTITY', 'Session worker identity is invalid.');
  }
  return {
    async status() {
      return { ...identity, ready: true };
    },
    async touch(input) {
      const timestamp = input.timestamp === undefined ? Date.now() : input.timestamp;
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new RpcError('SESSION_WORKER_INVALID_ACTIVITY', 'Session worker activity timestamp is invalid.');
      }
      return { accepted: true, timestamp };
    },
  };
}
