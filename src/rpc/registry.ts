import {
  RpcError,
  RpcHandlerContext,
  RpcServiceDescriptor,
  RpcServiceHandler,
} from './types';

type RegisteredService = {
  descriptor: RpcServiceDescriptor;
  handler: RpcServiceHandler<any>;
};

export class RpcServiceRegistry {
  private readonly services = new Map<string, RegisteredService>();

  register<Descriptor extends RpcServiceDescriptor>(
    descriptor: Descriptor,
    handler: RpcServiceHandler<Descriptor>,
  ): () => void {
    if (this.services.has(descriptor.name)) {
      throw new RpcError('RPC_SERVICE_ALREADY_REGISTERED', `RPC service ${descriptor.name} is already registered.`);
    }
    const registered: RegisteredService = { descriptor, handler };
    this.services.set(descriptor.name, registered);
    return () => {
      if (this.services.get(descriptor.name) === registered) {
        this.services.delete(descriptor.name);
      }
    };
  }

  listServices(): Array<{ name: string; version: number }> {
    return [...this.services.values()]
      .map(({ descriptor }) => ({ name: descriptor.name, version: descriptor.version }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getService(name: string, version: number): RegisteredService {
    const registered = this.services.get(name);
    if (!registered) {
      throw new RpcError('RPC_SERVICE_NOT_FOUND', `RPC service ${name} is not registered.`, true);
    }
    if (registered.descriptor.version !== version) {
      throw new RpcError(
        'RPC_SERVICE_VERSION_MISMATCH',
        `RPC service ${name} requires version ${registered.descriptor.version}, received ${version}.`,
      );
    }
    return registered;
  }

  async invoke(
    serviceName: string,
    serviceVersion: number,
    methodName: string,
    input: unknown,
    context: RpcHandlerContext,
  ): Promise<unknown> {
    const { descriptor, handler } = this.getService(serviceName, serviceVersion);
    if (!Object.prototype.hasOwnProperty.call(descriptor.methods, methodName)) {
      throw new RpcError('RPC_METHOD_NOT_FOUND', `RPC method ${serviceName}.${methodName} is not registered.`);
    }
    const method = (handler as any)[methodName];
    if (typeof method !== 'function') {
      throw new RpcError('RPC_HANDLER_MISSING', `RPC handler ${serviceName}.${methodName} is missing.`);
    }
    return method(input, context);
  }

  hasEvent(serviceName: string, serviceVersion: number, eventName: string): boolean {
    const { descriptor } = this.getService(serviceName, serviceVersion);
    return Object.prototype.hasOwnProperty.call(descriptor.events, eventName);
  }
}
