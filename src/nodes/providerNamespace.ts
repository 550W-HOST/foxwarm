import type { NodeProvider, NodeProviderDescriptor, NodeLifecycleResult } from './providerRegistry';
import { splitProviderNodeId } from '../../packages/shared/dist/nodeIdentity';

/** Core-facing adapter. The executable protocol and its persisted resource IDs stay local. */
export function namespaceNodeProvider(provider: NodeProvider): NodeProvider {
  const qualify = (id: string): string => `${provider.id}/${id}`;
  const local = (id: string): string => {
    const identity = splitProviderNodeId(id);
    if (!identity || identity.providerId !== provider.id) throw new Error(`Node does not belong to provider \`${provider.id}\`.`);
    return identity.localId;
  };
  const descriptor = (node: NodeProviderDescriptor): NodeProviderDescriptor => ({ ...node, id: qualify(node.id) });
  const result = (value: NodeLifecycleResult): NodeLifecycleResult => ({
    ...value,
    ...(value.node ? { node: descriptor(value.node) } : {}),
    ...(value.nodeId ? { nodeId: qualify(value.nodeId) } : {}),
  });
  return {
    id: provider.id,
    namespaceNodeIds: true,
    ...(provider.deferredLookup ? { deferredLookup: true } : {}),
    ...(provider.supportsExecWaitCancellation ? { supportsExecWaitCancellation: true } : {}),
    ...(provider.initialize ? { initialize: () => provider.initialize!() } : {}),
    ...(provider.shutdown ? { shutdown: () => provider.shutdown!() } : {}),
    listNodes: async options => (await provider.listNodes(options)).map(descriptor),
    getNode: async (nodeId, options) => {
      const identity = splitProviderNodeId(nodeId);
      if (!identity || identity.providerId !== provider.id) return undefined;
      const node = await provider.getNode(identity.localId, options);
      return node && descriptor(node);
    },
    ...(provider.describe ? { describe: options => provider.describe!(options) } : {}),
    ...(provider.invokeFilesystem ? {
      invokeFilesystem: (request, options) => provider.invokeFilesystem!({
        ...request, nodeId: local(request.nodeId),
      }, options),
    } : {}),
    ...(provider.startExec ? {
      startExec: (request, options) => provider.startExec!({ ...request, nodeId: local(request.nodeId) }, options),
    } : {}),
    ...(provider.pollExec ? {
      pollExec: request => provider.pollExec!({ ...request, nodeId: local(request.nodeId) }),
    } : {}),
    ...(provider.getDefaultCwd ? {
      getDefaultCwd: (request, options) => provider.getDefaultCwd!({ ...request, nodeId: local(request.nodeId) }, options),
    } : {}),
    ...(provider.createNode ? {
      createNode: async (request, options) => result(await provider.createNode!({
        ...request, ...(request.nodeId ? { nodeId: local(request.nodeId) } : {}),
      }, options)),
    } : {}),
    ...(provider.ensureNode ? {
      ensureNode: async (request, options) => result(await provider.ensureNode!({
        ...request, ...(request.nodeId ? { nodeId: local(request.nodeId) } : {}),
      }, options)),
    } : {}),
    ...(provider.inspectNode ? {
      inspectNode: async (request, options) => result(await provider.inspectNode!({
        ...request, nodeId: local(request.nodeId),
      }, options)),
    } : {}),
    ...(provider.destroyNode ? {
      destroyNode: async (request, options) => result(await provider.destroyNode!({
        ...request, nodeId: local(request.nodeId),
      }, options)),
    } : {}),
  };
}
