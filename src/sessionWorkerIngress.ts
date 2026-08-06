import crypto from 'node:crypto';
import type { ChannelContext } from './channel';
import { RpcError } from './rpc';
import { normalizeSessionTurnDeliverySource } from './sessionTurnDelivery';
import type { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import type { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { isQueueItem, type QueueItem } from './types';

export type SessionWorkerIngressResult = {
  accepted: true;
  mailboxIntentId: number;
  generation: number;
  lastAppliedMailboxId: number;
  messageCount: number;
  busy: boolean;
};

export class SessionWorkerIngressCoordinator {
  constructor(
    private readonly store: SessionWorkerStore,
    private readonly supervisor: SessionWorkerSupervisor,
    readonly sourceContexts: SessionWorkerSourceContextRegistry,
    private readonly resolveCanonicalSessionId: (sessionId: string) => string,
  ) {}

  registerSourceContext(sessionId: string, item: QueueItem, context?: ChannelContext): () => void {
    if (!context || !item.source) return () => {};
    return this.sourceContexts.register(sessionId, normalizeSessionTurnDeliverySource(item.source), context);
  }

  async submitQueuedInput(requestedSessionId: string, item: QueueItem): Promise<SessionWorkerIngressResult> {
    if (typeof requestedSessionId !== 'string' || !requestedSessionId.trim() || requestedSessionId !== requestedSessionId.trim()) {
      throw new RpcError('SESSION_WORKER_INGRESS_INVALID_SESSION', 'submitAndRun requires an exact canonical session ID.');
    }
    const sessionId = this.resolveCanonicalSessionId(requestedSessionId);
    if (sessionId !== requestedSessionId) {
      throw new RpcError('SESSION_WORKER_INGRESS_INVALID_SESSION', 'submitAndRun does not accept a session alias.');
    }
    if (!isQueueItem(item)) throw new RpcError('SESSION_RUNTIME_INVALID_QUEUE_ITEM', 'item must be a current non-empty QueueItem DTO.');
    if (item.type === 'compact-commit') {
      throw new RpcError('SESSION_WORKER_QUEUE_UNSUPPORTED', 'Managed-session and compact-commit queues are not supported by the Session worker yet.', true);
    }
    const payload = structuredClone(item);
    if (payload.source) payload.source = normalizeSessionTurnDeliverySource(payload.source);
    const ownership = this.store.findOwnership(sessionId);
    if (!ownership || ownership.state !== 'ready' || !ownership.incarnationId) {
      throw new RpcError('SESSION_WORKER_INGRESS_UNAVAILABLE', `Session worker ${sessionId} has no activated durable owner.`, true);
    }
    const expected = { generation: ownership.generation, incarnationId: ownership.incarnationId };
    this.supervisor.assertActivatedOwnership(sessionId, expected);
    const intent = this.store.enqueueIntent(sessionId, crypto.randomUUID(), 'enqueue', payload);
    const projection = await this.supervisor.runPendingActivated(sessionId, expected);
    if (projection.lastAppliedMailboxId < intent.id) {
      throw new RpcError('SESSION_WORKER_INGRESS_AMBIGUOUS', `Session worker ${sessionId} did not confirm the durable mailbox intent.`, true);
    }
    return {
      accepted: true,
      mailboxIntentId: intent.id,
      generation: expected.generation,
      lastAppliedMailboxId: projection.lastAppliedMailboxId,
      messageCount: projection.messageCount,
      busy: projection.busy,
    };
  }
}
