import { SESSION_WORKERS_ENABLED } from './config';
import {
  LocalRpcTransport,
  RpcClient,
  RpcError,
  RpcEventListener,
  RpcServiceRegistry,
} from './rpc';
import {
  createSessionRuntimeServiceHandler,
  SessionRuntimeControlAction,
  SessionRuntimeControlResultDto,
  SessionRuntimeCompactionResultDto,
  SessionRuntimeEventPayloads,
  SessionRuntimeHistoryDto,
  SessionRuntimeSessionDto,
  SessionRuntimeSettingsPatchDto,
  SessionRuntimeSettingsResultDto,
  SessionRuntimeWorkerProjectionOptions,
  sessionRuntimeServiceDescriptor,
} from './sessionRuntimeService';
import type { QueueItem } from './types';
import type { ChannelContext } from './channel';
import type { SessionWorkerIngressCoordinator, SessionWorkerIngressResult } from './sessionWorkerIngress';
import { normalizeSessionWorkerIngressRequest } from './sessionWorkerIngress';

export type SessionRuntimeEventListener = RpcEventListener<typeof sessionRuntimeServiceDescriptor>;

let transport: LocalRpcTransport | undefined;
let client: RpcClient<typeof sessionRuntimeServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;
let eventsStarted = false;
let workerIngress: SessionWorkerIngressCoordinator | undefined;

export async function initializeSessionRuntime(options?: { worker?: SessionRuntimeWorkerProjectionOptions }): Promise<void> {
  if (client) return;
  if (!initializing) {
    initializing = Promise.resolve().then(() => {
      const registry = new RpcServiceRegistry();
      registry.register(sessionRuntimeServiceDescriptor, createSessionRuntimeServiceHandler(options));
      workerIngress = options?.worker?.ingress;
      transport = new LocalRpcTransport(registry, { maxPendingEvents: 4096 });
      client = new RpcClient(sessionRuntimeServiceDescriptor, transport);
    }).catch((error) => {
      initializing = undefined;
      throw error;
    });
  }
  await initializing;
}

async function getClient(): Promise<RpcClient<typeof sessionRuntimeServiceDescriptor>> {
  await initializeSessionRuntime();
  if (!client) throw new RpcError('SESSION_RUNTIME_UNAVAILABLE', 'Session runtime is unavailable.', true);
  return client;
}

export async function getSession(sessionId: string): Promise<SessionRuntimeSessionDto | null> {
  return (await (await getClient()).call('getSession', { sessionId })).session;
}

export async function listSessions(): Promise<SessionRuntimeSessionDto[]> {
  return (await (await getClient()).call('listSessions', {})).sessions;
}

export async function getHistory(sessionId: string): Promise<SessionRuntimeHistoryDto | null> {
  return (await getClient()).call('getHistory', { sessionId });
}

export async function enqueue(sessionId: string, item: QueueItem): Promise<void> {
  await (await getClient()).call('enqueue', { sessionId, item });
}

export async function submitAndRun(
  sessionId: string,
  item: QueueItem,
  sourceContext?: ChannelContext,
): Promise<SessionWorkerIngressResult> {
  const normalized = normalizeSessionWorkerIngressRequest({ sessionId, item });
  sessionId = normalized.sessionId; item = normalized.item;
  const runtimeClient = await getClient();
  if (!workerIngress) throw new RpcError('SESSION_WORKER_INGRESS_UNAVAILABLE', 'Session-worker ingress is unavailable.', true);
  const cleanup = workerIngress.registerSourceContext(sessionId, item, sourceContext);
  try { return await runtimeClient.call('submitAndRun', { sessionId, item }); }
  finally { cleanup(); }
}

export async function queueEvent(
  sessionId: string,
  text: string,
  type: 'background' | 'trigger' | 'onboot' = 'background',
): Promise<void> {
  await (await getClient()).call('queueEvent', { sessionId, text, type });
}

export async function requestCompaction(sessionId: string, keepPercent?: number, toolNoise = false): Promise<SessionRuntimeCompactionResultDto> {
  return (await getClient()).call('requestCompaction', { sessionId, keepPercent, toolNoise: toolNoise || undefined });
}

export async function updateSettings(
  sessionId: string,
  patch: SessionRuntimeSettingsPatchDto,
): Promise<SessionRuntimeSettingsResultDto> {
  return (await getClient()).call('updateSettings', { sessionId, patch });
}

export async function control(
  sessionId: string,
  action: SessionRuntimeControlAction,
): Promise<SessionRuntimeControlResultDto> {
  return (await getClient()).call('control', { sessionId, action });
}

export function subscribe(listener: SessionRuntimeEventListener): () => void {
  if (!client) {
    throw new RpcError('SESSION_RUNTIME_UNAVAILABLE', 'Initialize the session runtime before subscribing.', true);
  }
  return client.subscribe(listener);
}

export async function startEvents(): Promise<void> {
  if (eventsStarted) return;
  await (await getClient()).call('startEvents', {});
  eventsStarted = true;
}

export function getSessionRuntimeStatus(): {
  placement: 'local' | 'worker';
  ready: boolean;
  eventsStarted: boolean;
} {
  return {
    placement: SESSION_WORKERS_ENABLED ? 'worker' : 'local',
    ready: !!client,
    eventsStarted,
  };
}

export async function shutdownSessionRuntime(timeoutMs = 10_000): Promise<void> {
  const currentClient = client;
  const currentTransport = transport;
  if (!currentTransport) return;
  let shutdownError: unknown;
  if (eventsStarted && currentClient) {
    try {
      await currentClient.call('stopEvents', {});
    } catch (error) {
      shutdownError = error;
    } finally {
      eventsStarted = false;
    }
  }
  try {
    await currentTransport.drain(timeoutMs);
  } catch (error) {
    shutdownError ||= error;
  } finally {
    currentTransport.close();
    client = undefined;
    transport = undefined;
    initializing = undefined;
    workerIngress = undefined;
  }
  if (shutdownError) throw shutdownError;
}

export type {
  SessionRuntimeControlAction,
  SessionRuntimeControlResultDto,
  SessionRuntimeCompactionResultDto,
  SessionRuntimeEventPayloads,
  SessionRuntimeHistoryDto,
  SessionRuntimeSessionDto,
  SessionRuntimeSettingsPatchDto,
  SessionRuntimeSettingsResultDto,
  SessionWorkerIngressResult,
};
