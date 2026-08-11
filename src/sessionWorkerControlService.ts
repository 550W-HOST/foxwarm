import {
  defineRpcService,
  rpcMethod,
  RpcError,
  RpcServiceHandler,
} from './rpc';

export type SessionWorkerIdentity = {
  sessionId: string;
  generation: number;
  incarnationId: string;
  pid: number;
  processIdentity: string;
};

export const sessionWorkerControlServiceDescriptor = defineRpcService('session-worker-control', 2, {
  status: rpcMethod<Record<string, never>, SessionWorkerIdentity & { active: boolean }>(),
  activate: rpcMethod<Record<string, never>, { activated: true }>(),
  touch: rpcMethod<{ timestamp?: number }, { accepted: true; timestamp: number }>(),
});

export class SessionWorkerActivationGate {
  private active = false;

  activate(): void {
    this.active = true;
  }

  isActive(): boolean {
    return this.active;
  }

  assertActive(): void {
    if (!this.active) {
      throw new RpcError('SESSION_WORKER_NOT_ACTIVATED', 'Session worker incarnation is not durably activated.', true);
    }
  }
}

export function createSessionWorkerControlServiceHandler(
  identity: SessionWorkerIdentity,
  verifyActivation: () => void | Promise<void>,
  gate = new SessionWorkerActivationGate(),
): RpcServiceHandler<typeof sessionWorkerControlServiceDescriptor> {
  if (!identity.sessionId || !identity.incarnationId || !identity.processIdentity
    || !Number.isSafeInteger(identity.generation) || identity.generation <= 0) {
    throw new RpcError('SESSION_WORKER_INVALID_IDENTITY', 'Session worker identity is invalid.');
  }
  return {
    async status() {
      return { ...identity, active: gate.isActive() };
    },
    async activate() {
      await verifyActivation();
      gate.activate();
      return { activated: true };
    },
    async touch(input) {
      gate.assertActive();
      const timestamp = input.timestamp === undefined ? Date.now() : input.timestamp;
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new RpcError('SESSION_WORKER_INVALID_ACTIVITY', 'Session worker activity timestamp is invalid.');
      }
      return { accepted: true, timestamp };
    },
  };
}
