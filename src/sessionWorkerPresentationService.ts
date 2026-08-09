import { defineRpcService, rpcMethod, RpcError, type RpcServiceHandler } from './rpc';
import { stableSessionWorkerJson } from './sessionWorkerStableJson';
import type { SessionWorkerPublicationIdentity } from './sessionWorkerPublicationService';
import type { Message, SessionStreamEvent } from './types';

/**
 * Transient presentation channel from a Session worker to Main. These events
 * are presentation-only copies: Main handlers MUST be pure pass-throughs into
 * the existing WebUI/SSE fan-out and must never update semantic state, the
 * catalog, or the session stub. Events may be dropped without any correction;
 * the committed projection and detached history reads stay authoritative.
 */

type PresentationRequest = SessionWorkerPublicationIdentity & { message?: Message; event?: SessionStreamEvent };

export const sessionWorkerPresentationServiceDescriptor = defineRpcService('session-worker-presentation', 1, {
  message: rpcMethod<PresentationRequest, { delivered: true }>(),
  modelStream: rpcMethod<PresentationRequest, { delivered: true }>(),
});

function identityKey(identity: SessionWorkerPublicationIdentity) { return `${identity.sessionId}\0${identity.generation}\0${identity.incarnationId}`; }

function assertRequest(input: any, payloadKey: 'message' | 'event'): asserts input is PresentationRequest {
  const keys = input && typeof input === 'object' ? Reflect.ownKeys(input) : [];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
    || keys.length !== 4 || keys.some(key => typeof key !== 'string' || !['sessionId', 'generation', 'incarnationId', payloadKey].includes(key))) {
    throw new RpcError('SESSION_WORKER_PRESENTATION_INVALID', 'Presentation request has an invalid shape.');
  }
  const identity = input;
  if (typeof identity.sessionId !== 'string' || !identity.sessionId || identity.sessionId.length > 256
    || !Number.isSafeInteger(identity.generation) || identity.generation <= 0
    || typeof identity.incarnationId !== 'string' || !identity.incarnationId || identity.incarnationId.length > 256) {
    throw new RpcError('SESSION_WORKER_PRESENTATION_INVALID', 'Presentation identity is invalid.');
  }
  let json: string;
  try { json = stableSessionWorkerJson(input[payloadKey]); }
  catch { throw new RpcError('SESSION_WORKER_PRESENTATION_INVALID', 'Presentation payload must be plain JSON.'); }
  if (Buffer.byteLength(json, 'utf8') > 256 * 1024) throw new RpcError('SESSION_WORKER_PRESENTATION_INVALID', 'Presentation payload exceeds 256 KiB.');
}

export function createSessionWorkerPresentationServiceHandler(options: {
  expected: SessionWorkerPublicationIdentity;
  /** Pure pass-through into the WebUI SSE fan-out; never writes semantic state. */
  broadcastMessage: (sessionId: string, message: Message) => void;
  /** Pure pass-through into the session stream-event bus; never writes semantic state. */
  notifySessionEvent: (sessionId: string, event: SessionStreamEvent) => void;
}): RpcServiceHandler<typeof sessionWorkerPresentationServiceDescriptor> {
  const assertSource = (input: PresentationRequest) => {
    if (identityKey(input) !== identityKey(options.expected)) {
      throw new RpcError('SESSION_WORKER_PRESENTATION_SOURCE_MISMATCH', 'Presentation source identity mismatch.');
    }
  };
  return {
    async message(input) {
      assertRequest(input, 'message');
      assertSource(input);
      const message = input.message as any;
      if (!message || typeof message !== 'object' || typeof message.role !== 'string' || !Array.isArray(message.parts)) {
        throw new RpcError('SESSION_WORKER_PRESENTATION_INVALID', 'Presentation message has an invalid shape.');
      }
      options.broadcastMessage(input.sessionId, message);
      return { delivered: true };
    },
    async modelStream(input) {
      assertRequest(input, 'event');
      assertSource(input);
      const event = input.event as any;
      if (!event || typeof event !== 'object' || !['model-stream-update', 'model-stream-reset'].includes(event.type)) {
        throw new RpcError('SESSION_WORKER_PRESENTATION_INVALID', 'Presentation stream event has an invalid shape.');
      }
      options.notifySessionEvent(input.sessionId, event);
      return { delivered: true };
    },
  };
}
