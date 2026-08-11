import type { ChildProcess } from 'node:child_process';
import { RpcTransport } from './client';
import {
  buildRpcRequestId,
  cloneRpcDto,
  DEFAULT_RPC_BUILD_ID,
  deserializeRpcError,
  resolveRpcDeadline,
  RPC_PROTOCOL_VERSION,
  RpcCallOptions,
  RpcError,
  RpcEventListener,
  RpcServiceDescriptor,
} from './types';

type RpcReadyMessage = {
  kind: 'rpc-ready'; protocolVersion: number; buildId: string; generation: number;
  services: Array<{ name: string; version: number }>;
};
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  dispose: () => void;
};

export type ProcessRpcClientOptions = {
  generation: number;
  buildId?: string;
  readyTimeoutMs?: number;
  maxPendingRequests?: number;
  direction?: 'forward' | 'reverse';
};

type IpcClientPeer = ChildProcess | (NodeJS.Process & { send?: NodeJS.Process['send']; connected?: boolean });

export class ProcessRpcClientTransport implements RpcTransport {
  private readonly generation: number;
  private readonly buildId: string;
  private readonly readyTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<RpcEventListener<any>>>();
  private readonly readyPromise: Promise<RpcReadyMessage>;
  private resolveReady!: (message: RpcReadyMessage) => void;
  private rejectReady!: (error: unknown) => void;
  private ready?: RpcReadyMessage;
  private drainPending?: { requestId: string; resolve: () => void; reject: (error: unknown) => void; timer: NodeJS.Timeout };
  private draining = false;
  private closed = false;
  private terminalError?: RpcError;
  private readyRetryTimer?: NodeJS.Timeout;

  private readonly direction: 'forward' | 'reverse';

  constructor(private readonly child: IpcClientPeer, options: ProcessRpcClientOptions) {
    this.generation = options.generation;
    this.buildId = options.buildId || DEFAULT_RPC_BUILD_ID;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.maxPendingRequests = options.maxPendingRequests ?? 256;
    this.direction = options.direction || 'forward';
    this.readyPromise = new Promise<RpcReadyMessage>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    child.on('message', this.onMessage);
    child.once('error', this.onChildError);
    child.once('disconnect', this.onChildDisconnect);
    child.once('exit', this.onChildExit);
    if (this.direction === 'reverse') this.announceReverseReady();
  }

  async waitUntilReady(): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (this.ready) return;
    if (this.direction === 'reverse' && !this.readyRetryTimer) {
      this.readyRetryTimer = setInterval(() => this.announceReverseReady(), 50);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RpcError('RPC_READY_TIMEOUT', 'Timed out waiting for RPC child readiness.', true)), this.readyTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (this.direction === 'reverse' && error instanceof RpcError && error.code === 'RPC_READY_TIMEOUT') {
        this.terminalError = error;
        this.stopReadyRetry();
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async call(
    descriptor: RpcServiceDescriptor,
    methodName: string,
    input: unknown,
    options: RpcCallOptions = {},
  ): Promise<unknown> {
    if (this.terminalError) throw this.terminalError;
    if (this.closed || this.draining) {
      throw new RpcError('RPC_DRAINING', `RPC service ${descriptor.name} is draining.`, true);
    }
    await this.waitUntilReady();
    if (this.terminalError) throw this.terminalError;
    if (this.closed || this.draining) throw new RpcError('RPC_DRAINING', `RPC service ${descriptor.name} is draining.`, true);
    this.assertServiceAvailable(descriptor);
    // Validate/clone before allocating a pending slot, abort listener, or
    // deadline timer. Invalid DTO attempts therefore cannot consume capacity.
    const clonedInput = cloneRpcDto(input);
    if (this.pending.size >= this.maxPendingRequests) {
      throw new RpcError('RPC_BACKPRESSURE', 'RPC child has too many pending requests.', true);
    }

    const requestId = buildRpcRequestId();
    const traceId = options.traceId || requestId;
    const deadlineAt = resolveRpcDeadline(options);
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new RpcError('RPC_CANCELLED', 'RPC request cancelled.', true);
    }

    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const abort = () => {
        this.send({ kind: this.kind('rpc-cancel'), generation: this.generation, requestId } as any);
        this.rejectPending(requestId, options.signal?.reason instanceof Error
          ? options.signal.reason
          : new RpcError('RPC_CANCELLED', 'RPC request cancelled.', true));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (deadlineAt !== undefined) {
        timer = setTimeout(() => {
          this.send({ kind: this.kind('rpc-cancel'), generation: this.generation, requestId } as any);
          this.rejectPending(requestId, new RpcError('RPC_DEADLINE_EXCEEDED', 'RPC request deadline exceeded.', true));
        }, Math.max(0, deadlineAt - Date.now()));
        timer.unref?.();
      }
      this.pending.set(requestId, {
        resolve,
        reject,
        dispose: () => {
          options.signal?.removeEventListener('abort', abort);
          if (timer) clearTimeout(timer);
        },
      });
      try {
        this.send({
          kind: this.kind('rpc-request'),
          protocolVersion: RPC_PROTOCOL_VERSION,
          buildId: this.buildId,
          generation: this.generation,
          requestId,
          traceId,
          service: descriptor.name,
          serviceVersion: descriptor.version,
          method: methodName,
          deadlineAt,
          input: clonedInput,
        }, (error) => {
          if (error) this.rejectPending(requestId, new RpcError('RPC_SEND_FAILED', error.message, true));
        });
      } catch (error: any) {
        this.rejectPending(requestId, new RpcError('RPC_SEND_FAILED', error?.message || String(error), true));
      }
    });
  }

  subscribe(descriptor: RpcServiceDescriptor, listener: RpcEventListener<any>): () => void {
    if (this.direction === 'reverse') throw new RpcError('RPC_EVENTS_UNSUPPORTED', 'Reverse process RPC does not support events.');
    const key = this.serviceKey(descriptor.name, descriptor.version);
    const listeners = this.listeners.get(key) || new Set<RpcEventListener<any>>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  async drain(timeoutMs = 10_000): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (this.closed) return;
    await this.waitUntilReady();
    if (this.drainPending) {
      throw new RpcError('RPC_DRAINING', 'RPC child is already draining.', true);
    }
    this.draining = true;
    const requestId = buildRpcRequestId();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.drainPending = undefined;
        reject(new RpcError('RPC_DRAIN_TIMEOUT', 'Timed out draining RPC child.', true));
      }, timeoutMs);
      timer.unref?.();
      this.drainPending = { requestId, resolve, reject, timer };
      this.send({ kind: this.kind('rpc-drain'), generation: this.generation, requestId, deadlineAt: Date.now() + timeoutMs } as any);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.draining = true;
    this.child.off('message', this.onMessage);
    this.child.off('error', this.onChildError);
    this.child.off('disconnect', this.onChildDisconnect);
    this.child.off('exit', this.onChildExit);
    const error = new RpcError('RPC_CLOSED', 'RPC transport closed.', true);
    this.rejectReady(error);
    this.rejectAll(error);
    if (this.drainPending) {
      clearTimeout(this.drainPending.timer);
      this.drainPending.reject(error);
      this.drainPending = undefined;
    }
    this.listeners.clear();
    this.stopReadyRetry();
  }

  private readonly onMessage = (raw: unknown): void => {
    const message = raw as any;
    if (!message || typeof message !== 'object' || (message as any).generation !== this.generation) return;
    if (message.kind === this.kind('rpc-ready')) {
      if (message.protocolVersion !== RPC_PROTOCOL_VERSION || message.buildId !== this.buildId) {
        this.failTerminal(new RpcError('RPC_PROTOCOL_MISMATCH', 'RPC child protocol or build does not match.'));
        return;
      }
      this.ready = message as RpcReadyMessage;
      this.stopReadyRetry();
      this.resolveReady(message);
      return;
    }
    if (message.kind === this.kind('rpc-response')) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      pending.dispose();
      if (message.error) pending.reject(deserializeRpcError(message.error));
      else pending.resolve(cloneRpcDto(message.result));
      return;
    }
    if (message.kind === this.kind('rpc-event')) {
      const key = this.serviceKey(message.service, message.serviceVersion);
      for (const listener of this.listeners.get(key) || []) {
        listener(message.event, cloneRpcDto(message.payload), {
          traceId: message.traceId,
          processGeneration: message.generation,
          sequence: message.sequence,
        });
      }
      this.send({ kind: this.kind('rpc-event-ack'), generation: this.generation, sequence: message.sequence } as any);
      return;
    }
    if (message.kind === this.kind('rpc-drained') && this.drainPending?.requestId === message.requestId) {
      const pending = this.drainPending;
      this.drainPending = undefined;
      clearTimeout(pending.timer);
      if (message.error) pending.reject(deserializeRpcError(message.error));
      else pending.resolve();
    }
  };

  private readonly onChildError = (error: Error): void => this.failChild(error);
  private readonly onChildDisconnect = (): void => {
    this.failChild(new Error('RPC child IPC disconnected.'));
  };
  private readonly onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.failChild(new Error(`RPC child exited (${code ?? signal ?? 'unknown'}).`));
  };

  private failChild(error: Error): void {
    const rpcError = new RpcError('RPC_UNAVAILABLE', error.message, true);
    this.failTerminal(rpcError);
  }

  private failTerminal(rpcError: RpcError): void {
    if (this.terminalError) return;
    this.terminalError = rpcError;
    this.stopReadyRetry();
    this.draining = true;
    this.rejectReady(rpcError);
    this.rejectAll(rpcError);
    if (this.drainPending) {
      clearTimeout(this.drainPending.timer);
      this.drainPending.reject(rpcError);
      this.drainPending = undefined;
    }
    this.child.off('message', this.onMessage);
    this.child.off('error', this.onChildError);
    this.child.off('disconnect', this.onChildDisconnect);
    this.child.off('exit', this.onChildExit);
  }

  private rejectPending(requestId: string, error: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.dispose();
    pending.reject(error);
  }

  private rejectAll(error: unknown): void {
    for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, error);
  }

  private assertServiceAvailable(descriptor: RpcServiceDescriptor): void {
    const service = this.ready?.services.find(candidate => candidate.name === descriptor.name);
    if (!service) throw new RpcError('RPC_SERVICE_NOT_FOUND', `RPC child does not host ${descriptor.name}.`, true);
    if (service.version !== descriptor.version) {
      throw new RpcError('RPC_SERVICE_VERSION_MISMATCH', `RPC child hosts ${descriptor.name}@${service.version}, requested ${descriptor.version}.`);
    }
  }

  private serviceKey(name: string, version: number): string {
    return `${name}@${version}`;
  }

  private kind(kind: string): string {
    return this.direction === 'reverse' ? kind.replace('rpc-', 'rpc-reverse-') : kind;
  }

  private stopReadyRetry(): void {
    if (this.readyRetryTimer) clearInterval(this.readyRetryTimer);
    this.readyRetryTimer = undefined;
  }

  private announceReverseReady(): void {
    this.send({ kind: 'rpc-reverse-init', generation: this.generation } as any);
  }

  private send(message: any, callback?: (error: Error | null) => void): void {
    if (this.child.connected === false || !this.child.send) {
      callback?.(new Error('RPC child IPC is disconnected.'));
      return;
    }
    (this.child.send as any).call(this.child, message, (error: Error | null) => callback?.(error || null));
  }
}
