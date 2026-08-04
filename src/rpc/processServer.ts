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
};

type RequestMessage = {
  kind: 'rpc-request'; protocolVersion: number; buildId: string; generation: number;
  requestId: string; traceId: string; service: string; serviceVersion: number; method: string;
  deadlineAt?: number; input: unknown;
};
type CancelMessage = { kind: 'rpc-cancel'; generation: number; requestId: string };
type DrainMessage = { kind: 'rpc-drain'; generation: number; requestId: string; deadlineAt: number };
type EventAckMessage = { kind: 'rpc-event-ack'; generation: number; sequence: number };
type IncomingMessage = RequestMessage | CancelMessage | DrainMessage | EventAckMessage;

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

  constructor(
    private readonly registry: RpcServiceRegistry,
    private readonly options: ProcessRpcServerOptions,
  ) {
    this.generation = options.generation;
    this.buildId = options.buildId || DEFAULT_RPC_BUILD_ID;
    this.maxPendingEvents = options.maxPendingEvents ?? 256;
  }

  start(): void {
    if (this.started) return;
    if (!process.send) throw new Error('Process RPC server requires a child-process IPC channel.');
    this.started = true;
    process.on('message', this.onMessage);
    this.send({
      kind: 'rpc-ready',
      protocolVersion: RPC_PROTOCOL_VERSION,
      buildId: this.buildId,
      generation: this.generation,
      services: this.registry.listServices(),
    });
  }

  private readonly onMessage = (raw: unknown): void => {
    const message = raw as IncomingMessage;
    if (!message || typeof message !== 'object' || message.generation !== this.generation) return;
    if (message.kind === 'rpc-request') {
      void this.handleRequest(message);
    } else if (message.kind === 'rpc-cancel') {
      this.activeRequests.get(message.requestId)?.abort(new RpcError('RPC_CANCELLED', 'RPC request cancelled.', true));
    } else if (message.kind === 'rpc-drain') {
      this.draining = true;
      this.drainRequest = message;
      void this.maybeFinishDrain();
    } else if (message.kind === 'rpc-event-ack') {
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
          kind: 'rpc-response',
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
    if (!this.registry.hasEvent(service, serviceVersion, event)) {
      throw new RpcError('RPC_EVENT_NOT_FOUND', `RPC event ${service}.${event} is not registered.`);
    }
    if (this.pendingEventSequences.size >= this.maxPendingEvents) return false;
    const sequence = ++this.eventSequence;
    this.pendingEventSequences.add(sequence);
    this.send({
      kind: 'rpc-event',
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
      await this.options.onDrain?.();
    } catch (caught) {
      error = caught;
    }
    this.send({
      kind: 'rpc-drained',
      protocolVersion: RPC_PROTOCOL_VERSION,
      buildId: this.buildId,
      generation: this.generation,
      requestId: request.requestId,
      ...(error ? { error: serializeRpcError(error) } : {}),
    }, () => {
      if (this.options.exitOnDrain) {
        process.off('message', this.onMessage);
        process.disconnect?.();
      }
    });
  }

  private respondError(requestId: string, error: unknown): void {
    this.send({
      kind: 'rpc-response',
      protocolVersion: RPC_PROTOCOL_VERSION,
      buildId: this.buildId,
      generation: this.generation,
      requestId,
      error: serializeRpcError(error),
    });
  }

  private send(message: any, callback?: (error: Error | null) => void): void {
    if (!process.send || !process.connected) {
      callback?.(new Error('Parent IPC is disconnected.'));
      return;
    }
    process.send(message, (error) => callback?.(error || null));
  }
}
