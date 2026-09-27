import crypto from 'node:crypto';

export const RPC_PROTOCOL_VERSION = 1;
export const DEFAULT_RPC_BUILD_ID = 'foxwarm-1.0.0';

export type RpcMethodDefinition<Input, Output> = {
  readonly kind: 'unary';
  readonly _input?: Input;
  readonly _output?: Output;
};

export type RpcEventDefinition<Payload> = {
  readonly kind: 'event';
  readonly _payload?: Payload;
};

export type RpcMethodMap = Record<string, RpcMethodDefinition<any, any>>;
export type RpcEventMap = Record<string, RpcEventDefinition<any>>;

export type RpcServiceDescriptor<Methods extends RpcMethodMap = RpcMethodMap, Events extends RpcEventMap = RpcEventMap> = {
  readonly name: string;
  readonly version: number;
  readonly methods: Methods;
  readonly events: Events;
};

export function rpcMethod<Input, Output>(): RpcMethodDefinition<Input, Output> {
  return { kind: 'unary' };
}

export function rpcEvent<Payload>(): RpcEventDefinition<Payload> {
  return { kind: 'event' };
}

export function defineRpcService<Methods extends RpcMethodMap, Events extends RpcEventMap = Record<string, never>>(
  name: string,
  version: number,
  methods: Methods,
  events?: Events,
): RpcServiceDescriptor<Methods, Events> {
  if (!name || !Number.isInteger(version) || version < 1) {
    throw new Error('RPC service descriptors require a name and positive integer version.');
  }
  return Object.freeze({
    name,
    version,
    methods: Object.freeze({ ...methods }),
    events: Object.freeze({ ...(events || {} as Events) }),
  });
}

export type RpcMethodInput<Definition> = Definition extends RpcMethodDefinition<infer Input, any> ? Input : never;
export type RpcMethodOutput<Definition> = Definition extends RpcMethodDefinition<any, infer Output> ? Output : never;
export type RpcEventPayload<Definition> = Definition extends RpcEventDefinition<infer Payload> ? Payload : never;

export type RpcCallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  deadlineAt?: number;
  traceId?: string;
};

export type RpcHandlerContext<Events extends RpcEventMap = RpcEventMap> = {
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly traceId: string;
  readonly deadlineAt?: number;
  readonly processGeneration: number;
  emit<EventName extends keyof Events & string>(eventName: EventName, payload: RpcEventPayload<Events[EventName]>): boolean;
};

export type RpcServiceHandler<Descriptor extends RpcServiceDescriptor> = {
  [MethodName in keyof Descriptor['methods']]: (
    input: RpcMethodInput<Descriptor['methods'][MethodName]>,
    context: RpcHandlerContext<Descriptor['events']>,
  ) => Promise<RpcMethodOutput<Descriptor['methods'][MethodName]>> | RpcMethodOutput<Descriptor['methods'][MethodName]>;
};

export type RpcEventListener<Descriptor extends RpcServiceDescriptor> = <EventName extends keyof Descriptor['events'] & string>(
  eventName: EventName,
  payload: RpcEventPayload<Descriptor['events'][EventName]>,
  meta: { traceId: string; processGeneration: number; sequence: number },
) => void;

export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export type SerializedRpcError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};

export function serializeRpcError(error: unknown): SerializedRpcError {
  if (error instanceof RpcError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: cloneRpcDto(error.details) }),
    };
  }
  const candidate = error as any;
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : 'RPC_HANDLER_ERROR',
    message: candidate?.message || String(error),
    retryable: candidate?.retryable === true,
  };
}

export function deserializeRpcError(error: SerializedRpcError): RpcError {
  return new RpcError(error.code, error.message, error.retryable, error.details);
}

export function cloneRpcDto<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (error: any) {
    throw new RpcError('RPC_INVALID_DTO', `RPC values must be structured-cloneable: ${error?.message || String(error)}`);
  }
}

export function buildRpcRequestId(): string {
  return crypto.randomUUID();
}

export function resolveRpcDeadline(options: RpcCallOptions): number | undefined {
  if (options.deadlineAt !== undefined) {
    if (!Number.isFinite(options.deadlineAt)) {
      throw new RpcError('RPC_INVALID_DEADLINE', 'RPC deadlineAt must be finite.');
    }
    return options.deadlineAt;
  }
  if (options.timeoutMs === undefined) return undefined;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RpcError('RPC_INVALID_DEADLINE', 'RPC timeoutMs must be a positive finite number.');
  }
  return Date.now() + options.timeoutMs;
}

export function buildLinkedAbortController(signal?: AbortSignal, deadlineAt?: number): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason || new RpcError('RPC_CANCELLED', 'RPC request cancelled.', true));
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener('abort', abortFromParent, { once: true });

  const timeoutMs = deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now());
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    controller.abort(new RpcError('RPC_DEADLINE_EXCEEDED', 'RPC request deadline exceeded.', true));
  }, timeoutMs);
  timer?.unref?.();

  return {
    controller,
    dispose: () => {
      signal?.removeEventListener('abort', abortFromParent);
      if (timer) clearTimeout(timer);
    },
  };
}
