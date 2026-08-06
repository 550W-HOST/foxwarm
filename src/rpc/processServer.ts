import type { ChildProcess } from 'node:child_process';
import { RpcServiceRegistry } from './registry';
import {
  buildLinkedAbortController,
  cloneRpcDto,
  DEFAULT_RPC_BUILD_ID,
  RPC_PROTOCOL_VERSION,
  RpcError,
  serializeRpcError,
} from './types';

export type ProcessRpcServerOptions = {
  generation: number;
  buildId?: string;
  maxPendingEvents?: number;
  onDrain?: () => Promise<void> | void;
  exitOnDrain?: boolean;
  disconnectCleanupTimeoutMs?: number;
  peer?: ChildProcess;
  direction?: 'forward' | 'reverse';
  exitOnDisconnect?: boolean;
};

type RequestMessage = {
  kind: 'rpc-request'; protocolVersion: number; buildId: string; generation: number;
  requestId: string; traceId: string; service: string; serviceVersion: number; method: string;
  deadlineAt?: number; input: unknown;
};
type DrainMessage = { kind: 'rpc-drain'; generation: number; requestId: string; deadlineAt: number };

export class ProcessRpcServer {
  private readonly generation: number;
  private readonly buildId: string;
  private readonly maxPendingEvents: number;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly pendingEventSequences = new Set<number>();
  private eventSequence = 0;
  private draining = false;
  private drainRequest?: DrainMessage;
  private drainStarted = false;
  private started = false;
  private cleanupPromise?: Promise<void>;
  private intentionalDisconnect = false;
  private disconnectCleanupStarted = false;
  private readonly peer: any;
  private readonly direction: 'forward' | 'reverse';

  constructor(
    private readonly registry: RpcServiceRegistry,
    private readonly options: ProcessRpcServerOptions,
  ) {
    this.generation = options.generation;
    this.buildId = options.buildId || DEFAULT_RPC_BUILD_ID;
    this.maxPendingEvents = options.maxPendingEvents ?? 256;
    this.peer = options.peer || process;
    this.direction = options.direction || 'forward';
  }

  start(): void {
    if (this.started) return;
    if (!this.peer.send) throw new Error('Process RPC server requires a child-process IPC channel.');
    this.started = true;
    this.peer.on('message', this.onMessage);
    this.peer.once('disconnect', this.onParentDisconnect);
    if (this.direction === 'forward') this.send({
      kind: 'rpc-ready',
      protocolVersion: RPC_PROTOCOL_VERSION,
      buildId: this.buildId,
      generation: this.generation,
      services: this.registry.listServices(),
    });
  }

  private readonly onMessage = (raw: unknown): void => {
    const message = raw as any;
    if (!message || typeof message !== 'object' || message.generation !== this.generation) return;
    if (this.direction === 'reverse' && (message as any).kind === 'rpc-reverse-init') {
      this.sendReady();
    } else if (message.kind === this.kind('rpc-request')) {
      void this.handleRequest(message);
    } else if (message.kind === this.kind('rpc-cancel')) {
      this.activeRequests.get(message.requestId)?.abort(new RpcError('RPC_CANCELLED', 'RPC request cancelled.', true));
    } else if (message.kind === this.kind('rpc-drain')) {
      this.draining = true;
      this.drainRequest = message;
      void this.maybeFinishDrain();
    } else if (message.kind === this.kind('rpc-event-ack')) {
      this.pendingEventSequences.delete(message.sequence);
    }
  };

  private async handleRequest(message: RequestMessage): Promise<void> {
    if (message.protocolVersion !== RPC_PROTOCOL_VERSION || message.buildId !== this.buildId) {
      this.respondError(message.requestId, new RpcError('RPC_PROTOCOL_MISMATCH', 'RPC protocol or build does not match.'));
      return;
    }
    if (this.draining) {
      this.respondError(message.requestId, new RpcError('RPC_DRAINING', 'RPC child is draining.', true));
      return;
    }

    const linked = buildLinkedAbortController(undefined, message.deadlineAt);
    this.activeRequests.set(message.requestId, linked.controller);
    try {
      const result = await this.registry.invoke(
        message.service,
        message.serviceVersion,
        message.method,
        cloneRpcDto(message.input),
        {
          signal: linked.controller.signal,
          requestId: message.requestId,
          traceId: message.traceId,
          deadlineAt: message.deadlineAt,
          processGeneration: this.generation,
          emit: (eventName: string, payload: unknown) => this.emit(
            message.service,
            message.serviceVersion,
            eventName,
            payload,
            message.traceId,
          ),
        },
      );
      if (!linked.controller.signal.aborted) {
        this.send({
          kind: this.kind('rpc-response'),
          protocolVersion: RPC_PROTOCOL_VERSION,
          buildId: this.buildId,
          generation: this.generation,
          requestId: message.requestId,
          result: cloneRpcDto(result),
        });
      }
    } catch (error) {
      this.respondError(message.requestId, linked.controller.signal.aborted
        ? (linked.controller.signal.reason || error)
        : error);
    } finally {
      linked.dispose();
      this.activeRequests.delete(message.requestId);
      void this.maybeFinishDrain();
    }
  }

  private emit(service: string, serviceVersion: number, event: string, payload: unknown, traceId: string): boolean {
    if (this.direction === 'reverse') throw new RpcError('RPC_EVENTS_UNSUPPORTED', 'Reverse process RPC does not support events.');
    if (!this.registry.hasEvent(service, serviceVersion, event)) {
      throw new RpcError('RPC_EVENT_NOT_FOUND', `RPC event ${service}.${event} is not registered.`);
    }
    if (this.pendingEventSequences.size >= this.maxPendingEvents) return false;
    const sequence = ++this.eventSequence;
    this.pendingEventSequences.add(sequence);
    this.send({
      kind: this.kind('rpc-event'),
      protocolVersion: RPC_PROTOCOL_VERSION,
      buildId: this.buildId,
      generation: this.generation,
      sequence,
      service,
      serviceVersion,
      event,
      traceId,
      payload: cloneRpcDto(payload),
    }, (error) => {
      if (error) this.pendingEventSequences.delete(sequence);
    });
    return true;
  }

  private async maybeFinishDrain(): Promise<void> {
    if (!this.draining || !this.drainRequest || this.activeRequests.size > 0 || this.drainStarted) return;
    this.drainStarted = true;
    const request = this.drainRequest;
    let error: unknown;
    try {
      await this.runCleanup();
    } catch (caught) {
      error = caught;
    }
    this.send({
      kind: this.kind('rpc-drained'),
      protocolVersion: RPC_PROTOCOL_VERSION,
      buildId: this.buildId,
      generation: this.generation,
      requestId: request.requestId,
      ...(error ? { error: serializeRpcError(error) } : {}),
    }, () => {
      if (this.options.exitOnDrain) {
        this.intentionalDisconnect = true;
        this.peer.off('message', this.onMessage);
        process.disconnect?.();
      }
    });
  }

  private readonly onParentDisconnect = (): void => {
    if (this.intentionalDisconnect) {
      process.exit(0);
      return;
    }
    if (this.disconnectCleanupStarted) return;
    this.disconnectCleanupStarted = true;
    this.draining = true;
    this.peer.off('message', this.onMessage);
    const reason = new RpcError('RPC_PARENT_DISCONNECTED', 'Parent IPC disconnected.', true);
    for (const controller of this.activeRequests.values()) controller.abort(reason);
    void this.cleanupAfterParentDisconnect();
  };

  private async cleanupAfterParentDisconnect(): Promise<void> {
    const timeoutMs = this.options.disconnectCleanupTimeoutMs ?? 2_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.runCleanup().catch(() => {}),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, Math.max(1, timeoutMs));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.options.exitOnDisconnect !== false) process.exit(0);
    }
  }

  private runCleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = Promise.resolve().then(() => this.options.onDrain?.()).then(() => {});
    }
    return this.cleanupPromise;
  }

  private respondError(requestId: string, error: unknown): void {
    this.send({
      kind: this.kind('rpc-response'),
      protocolVersion: RPC_PROTOCOL_VERSION,
      buildId: this.buildId,
      generation: this.generation,
      requestId,
      error: serializeRpcError(error),
    });
  }

  private send(message: any, callback?: (error: Error | null) => void): void {
    if (!this.peer.send || this.peer.connected === false) {
      callback?.(new Error('Parent IPC is disconnected.'));
      return;
    }
    this.peer.send(message, (error: Error | null) => callback?.(error || null));
  }

  async drain(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    const deadline = Date.now() + timeoutMs;
    while (this.activeRequests.size > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (this.activeRequests.size > 0) throw new RpcError('RPC_DRAIN_TIMEOUT', 'Timed out draining process RPC server.', true);
    await this.runCleanup();
  }

  close(reason = new RpcError('RPC_CLOSED', 'RPC server closed.', true)): void {
    this.draining = true;
    this.peer.off('message', this.onMessage);
    this.peer.off('disconnect', this.onParentDisconnect);
    for (const controller of this.activeRequests.values()) controller.abort(reason);
  }

  private sendReady(): void {
    this.send({ kind: this.kind('rpc-ready'), protocolVersion: RPC_PROTOCOL_VERSION, buildId: this.buildId,
      generation: this.generation, services: this.registry.listServices() });
  }

  private kind(kind: string): string {
    return this.direction === 'reverse' ? kind.replace('rpc-', 'rpc-reverse-') : kind;
  }
}
