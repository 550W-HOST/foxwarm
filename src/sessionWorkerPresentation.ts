import { RpcClient, RpcError, type RpcTransport } from './rpc';
import { sessionWorkerPresentationServiceDescriptor } from './sessionWorkerPresentationService';
import type { SessionWorkerPublicationIdentity } from './sessionWorkerPublicationService';
import type { Message, SessionStreamEvent } from './types';

/** Child-side client for the transient presentation channel. Borrowed reverse transport only. */

let transport: RpcTransport | undefined;
let client: RpcClient<typeof sessionWorkerPresentationServiceDescriptor> | undefined;
let terminal = false;

function assertLive() { if (terminal) throw new RpcError('SESSION_WORKER_PRESENTATION_SHUTDOWN', 'Presentation channel is shutting down.', true); }

export async function initializeSessionWorkerPresentation(options: { transport: RpcTransport }): Promise<void> {
  assertLive();
  if (client) return;
  transport = options.transport;
  client = new RpcClient(sessionWorkerPresentationServiceDescriptor, transport);
}

export async function publishPresentationMessage(identity: SessionWorkerPublicationIdentity, message: Message): Promise<void> {
  assertLive();
  if (!client) throw new RpcError('SESSION_WORKER_PRESENTATION_UNAVAILABLE', 'Presentation channel is unavailable.', true);
  await client.call('message', { sessionId: identity.sessionId, generation: identity.generation, incarnationId: identity.incarnationId, message });
}

export async function publishPresentationModelStream(identity: SessionWorkerPublicationIdentity, event: SessionStreamEvent): Promise<void> {
  assertLive();
  if (!client) throw new RpcError('SESSION_WORKER_PRESENTATION_UNAVAILABLE', 'Presentation channel is unavailable.', true);
  await client.call('modelStream', { sessionId: identity.sessionId, generation: identity.generation, incarnationId: identity.incarnationId, event });
}

export async function shutdownSessionWorkerPresentation(): Promise<void> {
  terminal = true;
  client = undefined;
  transport = undefined;
}

export function resetSessionWorkerPresentationForTests(): void {
  if (transport || client) throw new RpcError('SESSION_WORKER_PRESENTATION_TEST_RESET_ACTIVE', 'Presentation channel is active.');
  terminal = false;
}
