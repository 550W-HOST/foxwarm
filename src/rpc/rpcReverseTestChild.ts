import { ProcessRpcClientTransport, RpcClient, RpcError } from './index';
import { rpcTestService } from './rpcTestService';

const generation = Number(process.env.FOXWARM_RPC_GENERATION || 1);
const transport = new ProcessRpcClientTransport(process, {
  generation,
  direction: 'reverse',
  readyTimeoutMs: Number(process.env.FOXWARM_RPC_READY_TIMEOUT_MS || 2_000),
  maxPendingRequests: Number(process.env.FOXWARM_RPC_MAX_PENDING || 2),
});
const client = new RpcClient(rpcTestService, transport);

function summary(error: any): { code?: string; message: string; retryable?: boolean; details?: unknown } {
  return { ...(error?.code ? { code: error.code } : {}), message: error?.message || String(error),
    ...(error?.retryable === true ? { retryable: true } : {}), ...(error?.details === undefined ? {} : { details: error.details }) };
}

async function command(input: any): Promise<unknown> {
  switch (input.name) {
    case 'echo': return client.call('echo', { nested: { value: input.value } });
    case 'fail': return client.call('fail', { code: input.code });
    case 'deadline': return client.call('wait', { delayMs: input.delayMs }, { timeoutMs: input.timeoutMs });
    case 'cancel': {
      const controller = new AbortController();
      const pending = client.call('wait', { delayMs: input.delayMs }, { signal: controller.signal });
      setTimeout(() => controller.abort(new RpcError('TEST_CANCEL', 'test cancelled', true)), input.cancelAfterMs);
      return pending;
    }
    case 'backpressure': {
      const first = client.call('wait', { delayMs: input.delayMs });
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = client.call('echo', { nested: { value: 1 } }).catch(summary);
      return { second: await second, first: await first };
    }
    case 'wait': return client.call('wait', { delayMs: input.delayMs });
    case 'event': {
      try { client.subscribe(() => {}); return { subscribed: true }; }
      catch (error) { throw error; }
    }
    case 'close': await transport.close(); return { closed: true };
    default: throw new Error(`Unknown reverse RPC test command: ${input.name}`);
  }
}

void transport.waitUntilReady().then(() => {
  process.send?.({ kind: 'reverse-test-ready' });
  process.on('message', (input: any) => {
    if (input?.kind !== 'reverse-test-command') return;
    void command(input).then(
      result => process.send?.({ kind: 'reverse-test-result', id: input.id, result }),
      error => process.send?.({ kind: 'reverse-test-result', id: input.id, error: summary(error) }),
    );
  });
}).catch(error => {
  process.send?.({ kind: 'reverse-test-start-error', error: summary(error) });
});
