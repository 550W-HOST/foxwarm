import { Channel, ChannelContext, ChannelMessage, getChannelInstance, listRegisteredChannels, registerChannel, unregisterChannel } from './channel';
import { logger } from './common';
import { getChannelConfigById, getNormalizedChannelConfigs, readAppConfigFile } from './config';
import { WeixinChannel } from './channels/weixinChannel';

export type ChannelRuntimeStatus = {
  channelId: string;
  type: string;
  managed: boolean;
  running: boolean;
  channelName?: string;
  configured: boolean;
  enabled: boolean;
  details: string[];
  lastError?: string;
};

type ManagedChannelFactory = {
  channelId: string;
  type: string;
  create: () => Promise<Channel>;
  describe: () => { configured: boolean; enabled: boolean; details: string[] };
};

const managedFactories = new Map<string, ManagedChannelFactory>();
const lastChannelErrors = new Map<string, string>();
let runtimeMessageHandler: ((ctx: ChannelContext, message: ChannelMessage) => Promise<void>) | undefined;

function buildWeixinFactory(channelId: string): ManagedChannelFactory {
  return {
    channelId,
    type: 'weixin',
    create: async () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      const token = config.token?.trim();
      if (!token) {
        throw new Error(`Weixin token is missing for channel \`${channelId}\` in state/config.yaml`);
      }
      if (!runtimeMessageHandler) {
        throw new Error('Channel runtime is not initialized with a message handler');
      }
      const channel = new WeixinChannel({
        baseUrl: config.baseUrl || 'https://ilinkai.weixin.qq.com',
        token,
        routeTag: config.routeTag,
        longPollTimeoutMs: config.longPollTimeoutMs,
      }, channelId);
      channel.onMessage(runtimeMessageHandler);
      return channel;
    },
    describe: () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      const details = [
        `baseUrl=${config.baseUrl || 'https://ilinkai.weixin.qq.com'}`,
        `token=${config.token?.trim() ? 'configured' : 'missing'}`,
        `routeTag=${config.routeTag?.trim() || 'unset'}`,
      ];
      return {
        configured: Boolean(config.token?.trim()),
        enabled: config.enabled !== false,
        details,
      };
    },
  };
}

function rebuildFactories(): void {
  managedFactories.clear();
  for (const entry of getNormalizedChannelConfigs(readAppConfigFile())) {
    if (entry.type === 'weixin') {
      managedFactories.set(entry.id, buildWeixinFactory(entry.id));
    }
  }
}

function ensureFactories(): void {
  rebuildFactories();
}

export function initializeChannelRuntime(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
  runtimeMessageHandler = handler;
  ensureFactories();
}

export function getManagedChannelIds(): string[] {
  ensureFactories();
  return Array.from(managedFactories.keys()).sort();
}

export async function startManagedChannel(channelId: string): Promise<{ started: boolean; status: ChannelRuntimeStatus }> {
  ensureFactories();
  const factory = managedFactories.get(channelId);
  if (!factory) {
    throw new Error(`Channel \`${channelId}\` is not dynamically managed`);
  }

  const existing = getChannelInstance(channelId);
  if (existing) {
    return {
      started: false,
      status: getChannelRuntimeStatus(channelId)!,
    };
  }

  const channel = await factory.create();
  try {
    await channel.start();
    registerChannel(channelId, channel);
    lastChannelErrors.delete(channelId);
    logger.info({ channelId, type: factory.type }, 'Managed channel started');
    return {
      started: true,
      status: getChannelRuntimeStatus(channelId)!,
    };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    lastChannelErrors.set(channelId, message);
    throw err;
  }
}

export async function stopManagedChannel(channelId: string): Promise<{ stopped: boolean; status: ChannelRuntimeStatus }> {
  ensureFactories();
  const factory = managedFactories.get(channelId);
  if (!factory) {
    throw new Error(`Channel \`${channelId}\` is not dynamically managed`);
  }

  const existing = getChannelInstance(channelId);
  if (!existing) {
    return {
      stopped: false,
      status: getChannelRuntimeStatus(channelId)!,
    };
  }

  await existing.stop();
  unregisterChannel(channelId);
  logger.info({ channelId, type: factory.type }, 'Managed channel stopped');
  return {
    stopped: true,
    status: getChannelRuntimeStatus(channelId)!,
  };
}

export async function restartManagedChannel(channelId: string): Promise<{ restarted: boolean; status: ChannelRuntimeStatus }> {
  ensureFactories();
  const factory = managedFactories.get(channelId);
  if (!factory) {
    throw new Error(`Channel \`${channelId}\` is not dynamically managed`);
  }

  const existing = getChannelInstance(channelId);
  if (existing) {
    await existing.stop();
    unregisterChannel(channelId);
  }

  const result = await startManagedChannel(channelId);
  return {
    restarted: true,
    status: result.status,
  };
}

export function getChannelRuntimeStatus(channelId: string): ChannelRuntimeStatus | undefined {
  ensureFactories();
  const factory = managedFactories.get(channelId);
  const registered = getChannelInstance(channelId);
  const configEntry = getChannelConfigById(channelId, readAppConfigFile());
  if (!factory && !registered && !configEntry) {
    return undefined;
  }

  const type = factory?.type || configEntry?.type || registered?.platform || channelId;
  const base = factory?.describe() || {
    configured: true,
    enabled: true,
    details: configEntry ? [`configuredType=${configEntry.type}`] : [],
  };
  return {
    channelId,
    type,
    managed: Boolean(factory),
    running: Boolean(registered),
    channelName: registered?.name,
    configured: base.configured,
    enabled: base.enabled,
    details: base.details,
    lastError: lastChannelErrors.get(channelId),
  };
}

export function listChannelRuntimeStatuses(filter?: { type?: string }): ChannelRuntimeStatus[] {
  ensureFactories();
  const channelIds = new Set<string>([
    ...getManagedChannelIds(),
    ...listRegisteredChannels().map(item => item.channelId),
    ...getNormalizedChannelConfigs(readAppConfigFile()).map(item => item.id),
  ]);
  return Array.from(channelIds)
    .sort()
    .map(channelId => getChannelRuntimeStatus(channelId))
    .filter((value): value is ChannelRuntimeStatus => Boolean(value))
    .filter(status => !filter?.type || status.type === filter.type);
}
