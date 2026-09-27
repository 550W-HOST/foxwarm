import { defineRpcService, rpcEvent, rpcMethod, RpcError, RpcServiceHandler } from './index';

export const rpcTestService = defineRpcService('rpc-test', 1, {
  echo: rpcMethod<{ nested: { value: number } }, { nested: { value: number }; handlerSaw: number }>(),
  fail: rpcMethod<{ code: string }, never>(),
  plainFail: rpcMethod<Record<string, never>, never>(),
  wait: rpcMethod<{ delayMs: number }, { completed: true }>(),
  publish: rpcMethod<{ value: string }, { accepted: boolean }>(),
}, {
  progress: rpcEvent<{ value: string }>(),
});

const handlerOwnedDetails = { safe: { value: 1 } };

export const rpcTestHandler: RpcServiceHandler<typeof rpcTestService> = {
  async echo(input) {
    const handlerSaw = input.nested.value;
    input.nested.value += 1;
    return { nested: input.nested, handlerSaw };
  },
  async fail(input) {
    throw new RpcError(input.code, 'expected failure', true, handlerOwnedDetails);
  },
  async plainFail() {
    throw new Error('plain handler failure');
  },
  async wait(input, context) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, input.delayMs);
      const abort = () => {
        clearTimeout(timer);
        reject(context.signal.reason || new RpcError('RPC_CANCELLED', 'cancelled', true));
      };
      if (context.signal.aborted) abort();
      else context.signal.addEventListener('abort', abort, { once: true });
    });
    return { completed: true };
  },
  async publish(input, context) {
    return { accepted: context.emit('progress', { value: input.value }) };
  },
};
