import {
  RpcCallOptions,
  RpcEventListener,
  RpcMethodInput,
  RpcMethodOutput,
  RpcServiceDescriptor,
} from './types';

export interface RpcTransport {
  call(
    descriptor: RpcServiceDescriptor,
    methodName: string,
    input: unknown,
    options?: RpcCallOptions,
  ): Promise<unknown>;
  subscribe(
    descriptor: RpcServiceDescriptor,
    listener: RpcEventListener<any>,
  ): () => void;
  drain(timeoutMs?: number): Promise<void>;
  close(): Promise<void> | void;
}

export class RpcClient<Descriptor extends RpcServiceDescriptor> {
  constructor(
    readonly descriptor: Descriptor,
    private readonly transport: RpcTransport,
  ) {}

  call<MethodName extends keyof Descriptor['methods'] & string>(
    methodName: MethodName,
    input: RpcMethodInput<Descriptor['methods'][MethodName]>,
    options: RpcCallOptions = {},
  ): Promise<RpcMethodOutput<Descriptor['methods'][MethodName]>> {
    return this.transport.call(this.descriptor, methodName, input, options) as Promise<RpcMethodOutput<Descriptor['methods'][MethodName]>>;
  }

  subscribe(listener: RpcEventListener<Descriptor>): () => void {
    return this.transport.subscribe(this.descriptor, listener as RpcEventListener<any>);
  }
}
