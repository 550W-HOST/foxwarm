import { Channel, ChannelContext, ChannelMessage, getChannelInstance, listRegisteredChannels, registerChannel, unregisterChannel } from './channel';
import { logger } from './common';
import { readAppConfigFile } from './config';
import { WeixinChannel } from './channels/weixinChannel';

export type ChannelRuntimeStatus = {
  platform: string;
  managed: boolean;
  running: boolean;
  channelName?: string;
  configured: boolean;
  enabled: boolean;
  details: string[];
  lastError?: string;
};

type ManagedChannelFactory = {
  platform: string;
  create: () => Promise<Channel>;
  describe: () => { configured: boolean; enabled: boolean; details: string[] };
};

const managedFactories = new Map<string, ManagedChannelFactory>();
const lastChannelErrors = new Map<string, string>();
let runtimeMessageHandler: ((ctx: ChannelContext, message: ChannelMessage) => Promise<void>) | undefined;

function buildWeixinFactory(): ManagedChannelFactory {
  return {
    platform: 'weixin',
    create: async () => {
      const config = readAppConfigFile().channels?.weixin || {};
      const token = config.token?.trim();
      if (!token) {
        throw new Error('Weixin token is missing in state/config.yaml');
      }
      if (!runtimeMessageHandler) {
        throw new Error('Channel runtime is not initialized with a message handler');
      }
      const channel = new WeixinChannel({
        baseUrl: config.baseUrl || 'https://ilinkai.weixin.qq.com',
        token,
        routeTag: config.routeTag,
        longPollTimeoutMs: config.longPollTimeoutMs,
      });
      channel.onMessage(runtimeMessageHandler);
      return channel;
    },
    describe: () => {
      const config = readAppConfigFile().channels?.weixin || {};
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

function ensureFactories(): void {
  if (managedFactories.size > 0) {
    return;
  }
  const weixin = buildWeixinFactory();
  managedFactories.set(weixin.platform, weixin);
}

export function initializeChannelRuntime(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
  runtimeMessageHandler = handler;
  ensureFactories();
}

export function getManagedChannelPlatforms(): string[] {
  ensureFactories();
  return Array.from(managedFactories.keys()).sort();
}

export async function startManagedChannel(platform: string): Promise<{ started: boolean; status: ChannelRuntimeStatus }> {
  ensureFactories();
  const factory = managedFactories.get(platform);
  if (!factory) {
    throw new Error(`Channel platform "${platform}" is not dynamically managed`);
  }

  const existing = getChannelInstance(platform);
  if (existing) {
    return {
      started: false,
      status: getChannelRuntimeStatus(platform)!,
    };
  }

  const channel = await factory.create();
  try {
    await channel.start();
    registerChannel(platform, channel);
    lastChannelErrors.delete(platform);
    logger.info({ platform }, 'Managed channel started');
    return {
      started: true,
      status: getChannelRuntimeStatus(platform)!,
    };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    lastChannelErrors.set(platform, message);
    throw err;
  }
}

export async function stopManagedChannel(platform: string): Promise<{ stopped: boolean; status: ChannelRuntimeStatus }> {
  ensureFactories();
  const factory = managedFactories.get(platform);
  if (!factory) {
    throw new Error(`Channel platform "${platform}" is not dynamically managed`);
  }

  const existing = getChannelInstance(platform);
  if (!existing) {
    return {
      stopped: false,
      status: getChannelRuntimeStatus(platform)!,
    };
  }

  await existing.stop();
  unregisterChannel(platform);
  logger.info({ platform }, 'Managed channel stopped');
  return {
    stopped: true,
    status: getChannelRuntimeStatus(platform)!,
  };
}

export async function restartManagedChannel(platform: string): Promise<{ restarted: boolean; status: ChannelRuntimeStatus }> {
  ensureFactories();
  const factory = managedFactories.get(platform);
  if (!factory) {
    throw new Error(`Channel platform "${platform}" is not dynamically managed`);
  }

  const existing = getChannelInstance(platform);
  if (existing) {
    await existing.stop();
    unregisterChannel(platform);
  }

  const result = await startManagedChannel(platform);
  return {
    restarted: true,
    status: result.status,
  };
}

export function getChannelRuntimeStatus(platform: string): ChannelRuntimeStatus | undefined {
  ensureFactories();
  const factory = managedFactories.get(platform);
  const registered = getChannelInstance(platform);
  if (!factory && !registered) {
    return undefined;
  }

  const base = factory?.describe() || { configured: true, enabled: true, details: [] };
  return {
    platform,
    managed: Boolean(factory),
    running: Boolean(registered),
    channelName: registered?.name,
    configured: base.configured,
    enabled: base.enabled,
    details: base.details,
    lastError: lastChannelErrors.get(platform),
  };
}

export function listChannelRuntimeStatuses(): ChannelRuntimeStatus[] {
  ensureFactories();
  const platforms = new Set<string>([
    ...getManagedChannelPlatforms(),
    ...listRegisteredChannels().map(item => item.platform),
  ]);
  return Array.from(platforms)
    .sort()
    .map(platform => getChannelRuntimeStatus(platform))
    .filter((value): value is ChannelRuntimeStatus => Boolean(value));
}
