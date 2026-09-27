import { LocalRpcTransport, RpcClient, RpcError, RpcServiceRegistry, type RpcTransport } from './rpc';
import { createFileDeliveryServiceHandler, fileDeliveryServiceDescriptor, type FileDeliveryRequest } from './fileDeliveryService';

let transport: RpcTransport | undefined;
let client: RpcClient<typeof fileDeliveryServiceDescriptor> | undefined;
let initializing: Promise<void> | undefined;
let initializingTransport: RpcTransport | null | undefined;
let terminal = false;
let ownsTransport = true;
let placement: 'local' | 'child-reverse' = 'local';

function assertLive() { if (terminal) throw new RpcError('FILE_DELIVERY_SHUTDOWN', 'File delivery service is shutting down.', true); }

export async function initializeFileDelivery(options: { transport?: RpcTransport; placement?: 'child-reverse' } = {}) {
  assertLive();
  if (client) {
    if ((options.transport && transport !== options.transport) || (!options.transport && placement !== 'local')) throw new RpcError('FILE_DELIVERY_PLACEMENT_LOCKED', 'File delivery placement is already initialized.');
    return;
  }
  if (initializing) {
    if (initializingTransport !== (options.transport || null)) throw new RpcError('FILE_DELIVERY_PLACEMENT_LOCKED', 'File delivery placement initialization is already in progress.');
    return await initializing;
  }
  initializingTransport = options.transport || null;
  initializing = Promise.resolve().then(() => {
    assertLive();
    if (options.transport) { transport = options.transport; ownsTransport = false; placement = 'child-reverse'; client = new RpcClient(fileDeliveryServiceDescriptor, transport); return; }
    const registry = new RpcServiceRegistry(); registry.register(fileDeliveryServiceDescriptor, createFileDeliveryServiceHandler());
    const next = new LocalRpcTransport(registry, { maxPendingRequests: 32 });
    if (terminal) { next.close(); assertLive(); }
    transport = next; client = new RpcClient(fileDeliveryServiceDescriptor, next);
  });
  const pending = initializing;
  try { await pending; } finally { if (initializing === pending) { initializing = undefined; initializingTransport = undefined; } }
}

async function getClient() {
  assertLive(); if (!client) await initializeFileDelivery();
  if (!client) throw new RpcError('FILE_DELIVERY_UNAVAILABLE', 'File delivery service is unavailable.', true);
  return client;
}

export async function deliverFile(request: FileDeliveryRequest) {
  try { return await (await getClient()).call('deliver', request); }
  catch (error) {
    if (error instanceof RpcError && ['RPC_UNAVAILABLE', 'RPC_CLOSED', 'RPC_SEND_FAILED', 'RPC_READY_TIMEOUT', 'RPC_DRAINING',
      'RPC_PROTOCOL_MISMATCH', 'RPC_SERVICE_NOT_FOUND', 'RPC_SERVICE_VERSION_MISMATCH'].includes(error.code)) {
      throw new RpcError('FILE_DELIVERY_UNAVAILABLE', error.message, true);
    }
    throw error;
  }
}

export async function shutdownFileDelivery(timeoutMs = 10_000) {
  terminal = true; if (initializing) await initializing.catch(() => {});
  const current = transport;
  if (!current) { client = undefined; initializing = undefined; initializingTransport = undefined; return; }
  if (!ownsTransport) { client = undefined; transport = undefined; initializing = undefined; initializingTransport = undefined; return; }
  try { await current.drain(timeoutMs); } finally { current.close(); client = undefined; transport = undefined; initializing = undefined; initializingTransport = undefined; }
}

export function resetFileDeliveryForTests() {
  if (transport || client || initializing) throw new RpcError('FILE_DELIVERY_TEST_RESET_ACTIVE', 'Shut down file delivery before resetting tests.');
  terminal = false; ownsTransport = true; placement = 'local'; initializingTransport = undefined;
}

export function getFileDeliveryStatus() { return { placement, ready: !!client }; }
