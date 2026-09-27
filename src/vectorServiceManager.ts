import { ChildProcess, fork } from 'node:child_process';
import path from 'node:path';
import { logger } from './common';
import {
  LocalRpcTransport,
  ProcessRpcClientTransport,
  RpcClient,
  RpcError,
  RpcServiceRegistry,
  RpcTransport,
} from './rpc';
import { createVectorServiceHandler, toVectorUnavailable, vectorServiceDescriptor } from './vectorService';
import * as runtime from './vectorRuntime';

export type VectorServiceManagerOptions = {
  useWorker: boolean;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
};

export class VectorServiceManager {
  private transport?: RpcTransport;
  private client?: RpcClient<typeof vectorServiceDescriptor>;
  private child?: ChildProcess;
  private mode?: 'local' | 'worker';
  private startPromise?: Promise<void>;
  private stopping = false;
  private generation = Date.now();
  private restartTimer?: NodeJS.Timeout;
  private restartDelayMs: number;
  private readonly restartBaseDelayMs: number;
  private readonly restartMaxDelayMs: number;

  constructor(private readonly options: VectorServiceManagerOptions) {
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? 250;
    this.restartMaxDelayMs = options.restartMaxDelayMs ?? 5_000;
    this.restartDelayMs = this.restartBaseDelayMs;
  }

  async start(): Promise<void> {
    if (this.stopping) {
      throw new RpcError('VECTOR_SHUTTING_DOWN', 'Vector service shutdown is still in progress.', true);
    }
    const requestedMode = this.options.useWorker ? 'worker' : 'local';
    if (this.mode && this.mode !== requestedMode) {
      throw new RpcError('VECTOR_PLACEMENT_CHANGE_REQUIRES_RESTART', 'Vector service placement cannot change after startup.');
    }
    this.mode = requestedMode;
    if (!this.startPromise) {
      this.stopping = false;
      this.startPromise = (requestedMode === 'worker' ? this.startWorker() : this.startLocal())
        .catch((error) => {
          this.startPromise = undefined;
          throw error;
        });
    }
    return this.startPromise;
  }

  getClient(): RpcClient<typeof vectorServiceDescriptor> {
    if (!this.client) {
      throw new RpcError('VECTOR_UNAVAILABLE', 'Vector service is not ready.', true);
    }
    return this.client;
  }

  getStatus(): { mode?: 'local' | 'worker'; ready: boolean; generation?: number; pid?: number } {
    return {
      mode: this.mode,
      ready: !!this.client,
      ...(this.mode === 'worker' ? { generation: this.generation, pid: this.child?.pid } : {}),
    };
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const transport = this.transport;
    const child = this.child;
    const wasReady = !!this.client;
    this.client = undefined;

    if (this.mode === 'local') {
      let drainError: unknown;
      try {
        if (transport && wasReady) await transport.drain(timeoutMs);
      } catch (error) {
        drainError = error;
      } finally {
        await transport?.close();
        await runtime.shutdown();
        this.transport = undefined;
        this.startPromise = undefined;
      }
      if (drainError) throw drainError;
      return;
    }

    const phaseMs = Math.max(1, Math.floor(timeoutMs / 4));
    if (transport && wasReady) {
      try {
        await transport.drain(phaseMs);
      } catch (error) {
        logger.warn({ err: error, pid: child?.pid }, 'Vector worker RPC drain failed; continuing bounded termination');
      }
    }
    await transport?.close();

    if (!child) {
      this.transport = undefined;
      this.startPromise = undefined;
      return;
    }

    let exited = await this.waitForChildExit(child, phaseMs);
    if (!exited) {
      this.signalChild(child, 'SIGTERM');
      exited = await this.waitForChildExit(child, phaseMs);
    }
    if (!exited) {
      this.signalChild(child, 'SIGKILL');
      exited = await this.waitForChildExit(child, phaseMs);
    }
    if (!exited) {
      throw new RpcError(
        'VECTOR_WORKER_EXIT_UNCONFIRMED',
        `Vector worker ${child.pid ?? 'unknown'} did not confirm exit after drain, SIGTERM, and SIGKILL.`,
      );
    }
    if (this.child === child) {
      this.child = undefined;
      this.transport = undefined;
      this.startPromise = undefined;
    }
  }

  private async startLocal(): Promise<void> {
    const registry = new RpcServiceRegistry();
    registry.register(vectorServiceDescriptor, createVectorServiceHandler());
    const transport = new LocalRpcTransport(registry, { processGeneration: 1 });
    const client = new RpcClient(vectorServiceDescriptor, transport);
    await client.call('init', {});
    this.transport = transport;
    this.client = client;
  }

  private async startWorker(): Promise<void> {
    const generation = ++this.generation;
    const child = fork(path.join(__dirname, 'vectorWorker.js'), [], {
      env: {
        ...process.env,
        FOXWARM_VECTOR_WORKER_GENERATION: String(generation),
      },
      serialization: 'advanced',
    });
    const transport = new ProcessRpcClientTransport(child, { generation });
    this.child = child;
    this.transport = transport;
    child.once('disconnect', () => this.handleWorkerDisconnect(child, transport));
    child.once('exit', (code, signal) => this.handleWorkerExit(child, transport, code, signal));
    try {
      await transport.waitUntilReady();
    } catch (error) {
      await transport.close();
      await this.terminateChildAndConfirm(child, 2_000);
      throw toVectorUnavailable(error);
    }
    if (this.stopping || this.child !== child) {
      await transport.close();
      await this.terminateChildAndConfirm(child, 2_000);
      throw new RpcError('VECTOR_UNAVAILABLE', 'Vector worker startup was superseded.', true);
    }
    this.client = new RpcClient(vectorServiceDescriptor, transport);
    this.restartDelayMs = this.restartBaseDelayMs;
    logger.info({ pid: child.pid, generation }, 'Vector worker ready');
  }

  private handleWorkerDisconnect(child: ChildProcess, transport: ProcessRpcClientTransport): void {
    if (this.child !== child) return;
    transport.close();
    this.client = undefined;
    // Keep child/start ownership until an actual exit event confirms that a new
    // generation cannot overlap the disconnected process.
    if (!this.stopping) {
      logger.warn({ pid: child.pid }, 'Vector worker IPC disconnected; waiting for process exit');
    }
  }

  private handleWorkerExit(
    child: ChildProcess,
    transport: ProcessRpcClientTransport,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    transport.close();
    this.child = undefined;
    this.transport = undefined;
    this.client = undefined;
    this.startPromise = undefined;
    if (this.stopping) return;
    logger.error({ pid: child.pid, code, signal }, 'Vector worker exited unexpectedly');
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartMaxDelayMs, Math.max(this.restartBaseDelayMs, delay * 2));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.startPromise = this.startWorker().catch((error) => {
        logger.error({ err: error }, 'Vector worker restart failed');
        this.startPromise = undefined;
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    let timer: NodeJS.Timeout | undefined;
    let onExit: (() => void) | undefined;
    const exited = await new Promise<boolean>(resolve => {
      onExit = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
      timer = setTimeout(() => {
        if (onExit) child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
    });
    if (timer) clearTimeout(timer);
    return exited;
  }

  private async terminateChildAndConfirm(child: ChildProcess, timeoutMs: number): Promise<void> {
    const phaseMs = Math.max(1, Math.floor(timeoutMs / 3));
    let exited = await this.waitForChildExit(child, phaseMs);
    if (!exited) {
      this.signalChild(child, 'SIGTERM');
      exited = await this.waitForChildExit(child, phaseMs);
    }
    if (!exited) {
      this.signalChild(child, 'SIGKILL');
      exited = await this.waitForChildExit(child, phaseMs);
    }
    if (!exited) {
      throw new RpcError(
        'VECTOR_WORKER_EXIT_UNCONFIRMED',
        `Vector worker ${child.pid ?? 'unknown'} did not confirm exit after startup failure.`,
      );
    }
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch (error) {
      logger.warn({ err: error, pid: child.pid, signal }, 'Failed to signal vector worker');
    }
  }
}
