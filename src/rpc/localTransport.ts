import { RpcTransport } from './client';
import { RpcServiceRegistry } from './registry';
import {
  buildLinkedAbortController,
  buildRpcRequestId,
  cloneRpcDto,
  resolveRpcDeadline,
  RpcCallOptions,
  RpcError,
  RpcEventListener,
  RpcServiceDescriptor,
} from './types';

export type LocalRpcTransportOptions = {
  processGeneration?: number;
  maxPendingEvents?: number;
};

export class LocalRpcTransport implements RpcTransport {
  private readonly generation: number;
  private readonly maxPendingEvents: number;
  private readonly listeners = new Map<string, Set<RpcEventListener<any>>>();
  private activeRequests = 0;
  private pendingEvents = 0;
  private draining = false;
  private closed = false;
  private drainWaiters: Array<() => void> = [];
  private eventSequence = 0;

  constructor(
    private readonly registry: RpcServiceRegistry,
    options: LocalRpcTransportOptions = {},
  ) {
    this.generation = options.processGeneration ?? 1;
    this.maxPendingEvents = options.maxPendingEvents ?? 256;
  }

  async call(
    descriptor: RpcServiceDescriptor,
    methodName: string,
    input: unknown,
    options: RpcCallOptions = {},
  ): Promise<unknown> {
    if (this.closed || this.draining) {
      throw new RpcError('RPC_DRAINING', `RPC service ${descriptor.name} is draining.`, true);
    }
    const requestId = buildRpcRequestId();
    const traceId = options.traceId || requestId;
    const deadlineAt = resolveRpcDeadline(options);
    const linked = buildLinkedAbortController(options.signal, deadlineAt);
    if (linked.controller.signal.aborted) {
      linked.dispose();
      throw linked.controller.signal.reason instanceof Error
        ? linked.controller.signal.reason
        : new RpcError('RPC_CANCELLED', 'RPC request cancelled.', true);
    }

    this.activeRequests += 1;
    const handlerPromise = Promise.resolve().then(() => this.registry.invoke(
      descriptor.name,
      descriptor.version,
      methodName,
      cloneRpcDto(input),
      {
        signal: linked.controller.signal,
        requestId,
        traceId,
        deadlineAt,
        processGeneration: this.generation,
        emit: (eventName: string, payload: unknown) => this.emit(descriptor, eventName, payload, traceId),
      },
    ));
    handlerPromise.finally(() => this.finishRequest()).catch(() => {});

    const abortPromise = new Promise<never>((_resolve, reject) => {
      linked.controller.signal.addEventListener('abort', () => {
        reject(linked.controller.signal.reason instanceof Error
          ? linked.controller.signal.reason
          : new RpcError('RPC_CANCELLED', 'RPC request cancelled.', true));
      }, { once: true });
    });

    try {
      const result = await Promise.race([handlerPromise, abortPromise]);
      return cloneRpcDto(result);
    } finally {
      linked.dispose();
    }
  }

  subscribe(descriptor: RpcServiceDescriptor, listener: RpcEventListener<any>): () => void {
    const key = this.serviceKey(descriptor);
    const listeners = this.listeners.get(key) || new Set<RpcEventListener<any>>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  async drain(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    if (this.activeRequests === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RpcError('RPC_DRAIN_TIMEOUT', 'Timed out draining local RPC requests.', true));
      }, timeoutMs);
      timer.unref?.();
      this.drainWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.closed = true;
    this.draining = true;
    this.listeners.clear();
  }

  private emit(
    descriptor: RpcServiceDescriptor,
    eventName: string,
    payload: unknown,
    traceId: string,
  ): boolean {
    if (!this.registry.hasEvent(descriptor.name, descriptor.version, eventName)) {
      throw new RpcError('RPC_EVENT_NOT_FOUND', `RPC event ${descriptor.name}.${eventName} is not registered.`);
    }
    if (this.pendingEvents >= this.maxPendingEvents) return false;
    const listeners = [...(this.listeners.get(this.serviceKey(descriptor)) || [])];
    if (listeners.length === 0) return true;
    const cloned = cloneRpcDto(payload);
    const sequence = ++this.eventSequence;
    this.pendingEvents += 1;
    queueMicrotask(() => {
      try {
        for (const listener of listeners) {
          listener(eventName, cloneRpcDto(cloned), {
            traceId,
            processGeneration: this.generation,
            sequence,
          });
        }
      } finally {
        this.pendingEvents -= 1;
      }
    });
    return true;
  }

  private finishRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.draining && this.activeRequests === 0) {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private serviceKey(descriptor: RpcServiceDescriptor): string {
    return `${descriptor.name}@${descriptor.version}`;
  }
}
