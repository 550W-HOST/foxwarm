import { LocalRpcTransport, RpcClient, RpcError, RpcServiceRegistry, type RpcTransport } from './rpc';
import { createSessionWorkerPublicationServiceHandler, sessionWorkerPublicationServiceDescriptor,
  SessionWorkerProjectionRegistry, type SessionWorkerPublicationIdentity } from './sessionWorkerPublicationService';
import type { SessionWorkerProjection } from './sessionWorkerPersistence';

let transport: RpcTransport | undefined; let client: RpcClient<typeof sessionWorkerPublicationServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined; let initializingTransport: RpcTransport | null | undefined;
let terminal = false; let ownsTransport = true;
function assertLive() { if (terminal) throw new RpcError('SESSION_WORKER_PUBLICATION_SHUTDOWN', 'Publication service is shutting down.', true); }

export async function initializeSessionWorkerPublication(options: { transport?: RpcTransport; identity: SessionWorkerPublicationIdentity }) {
  assertLive();
  if (client) { if (options.transport && transport !== options.transport) throw new RpcError('SESSION_WORKER_PUBLICATION_PLACEMENT_LOCKED', 'Publication placement is locked.'); return; }
  if (initializing) { if (initializingTransport !== (options.transport || null)) throw new RpcError('SESSION_WORKER_PUBLICATION_PLACEMENT_LOCKED', 'Publication initialization is locked.'); return await initializing; }
  initializingTransport = options.transport || null;
  initializing = Promise.resolve().then(() => {
    assertLive();
    if (options.transport) { transport = options.transport; ownsTransport = false; client = new RpcClient(sessionWorkerPublicationServiceDescriptor, transport); return; }
    const registry = new RpcServiceRegistry(); const projections = new SessionWorkerProjectionRegistry(); projections.establish(options.identity);
    registry.register(sessionWorkerPublicationServiceDescriptor, createSessionWorkerPublicationServiceHandler({ expected: options.identity, registry: projections }));
    const next = new LocalRpcTransport(registry, { maxPendingRequests: 128 }); transport = next; client = new RpcClient(sessionWorkerPublicationServiceDescriptor, next);
  });
  const pending = initializing; try { await pending; } finally { if (initializing === pending) { initializing = undefined; initializingTransport = undefined; } }
}
export async function publishCommitted(identity: SessionWorkerPublicationIdentity, projection: SessionWorkerProjection): Promise<void> {
  assertLive();
  if (!client) throw new RpcError('SESSION_WORKER_PUBLICATION_UNAVAILABLE', 'Publication service is unavailable.', true);
  await client.call('publishCommitted', { sessionId: identity.sessionId, generation: identity.generation,
    incarnationId: identity.incarnationId, projection });
}
export async function shutdownSessionWorkerPublication(timeoutMs = 10_000) {
  terminal = true; if (initializing) await initializing.catch(() => {}); const current = transport;
  if (!current) { client = undefined; return; }
  if (!ownsTransport) { client = undefined; transport = undefined; return; }
  try { await current.drain(timeoutMs); } finally { current.close(); client = undefined; transport = undefined; initializing = undefined; }
}
export function resetSessionWorkerPublicationForTests() {
  if (transport || client || initializing) throw new RpcError('SESSION_WORKER_PUBLICATION_TEST_RESET_ACTIVE', 'Publication service is active.');
  terminal = false; ownsTransport = true; initializingTransport = undefined;
}
