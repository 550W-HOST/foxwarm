import { NODE_PROVIDERS_CONFIG } from '../config';
import { ExecutableNodeProvider } from './executableProvider';
import { DockerWorktreeNodeProvider } from './dockerWorktreeProvider';
import {
  AuthenticatedRemoteNodeProvider,
  MasterNodeProvider,
  NodeProviderRegistry,
} from './providerRegistry';

export const nodeProviderRegistry = new NodeProviderRegistry([
  new MasterNodeProvider(),
  new AuthenticatedRemoteNodeProvider(),
  ...NODE_PROVIDERS_CONFIG.map(config => config.type === 'executable'
    ? new ExecutableNodeProvider(config)
    : new DockerWorktreeNodeProvider(config)),
]);
