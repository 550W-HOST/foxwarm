import { Channel, ChannelContext, ChannelMessage, getChannelInstance, listRegisteredChannels, registerChannel, unregisterChannel } from './channel';
import { logger } from './common';
import { getChannelConfigById, getNormalizedChannelConfigs, readAppConfigFile } from './config';
import { WeixinChannel } from './channels/weixinChannel';
import { isQQBotChannelConfigReady, QQBotChannel } from './channels/qqbotChannel';
import { TelegramChannel } from './channels/telegramChannel';
import { MatrixChannel } from './channels/matrixChannel';
import { isWeWorkChannelConfigReady, WeWorkWebhookChannel } from './channels/weworkChannel';
import * as sessionManager from './sessionManager';

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
let runtimeCommandHandler: ((ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>) | undefined;

function requireRuntimeMessageHandler(): (ctx: ChannelContext, message: ChannelMessage) => Promise<void> {
  if (!runtimeMessageHandler) {
    throw new Error('Channel runtime is not initialized with a message handler');
  }
  return runtimeMessageHandler;
}

function buildTelegramFactory(channelId: string): ManagedChannelFactory {
  return {
    channelId,
    type: 'telegram',
    create: async () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      const botToken = config.botToken?.trim();
      if (!botToken) {
        throw new Error(`Telegram botToken is missing for channel \`${channelId}\` in state/config.yaml`);
      }
      const channel = new TelegramChannel(config, channelId);
      channel.onMessage(requireRuntimeMessageHandler());
      if (runtimeCommandHandler) {
        channel.onCommand?.(runtimeCommandHandler);
      }
      return channel;
    },
    describe: () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      return {
        configured: Boolean(config.botToken?.trim()),
        enabled: config.enabled !== false,
        details: [
          `botToken=${config.botToken?.trim() ? 'configured' : 'missing'}`,
          `mainAttachUser=${config.mainAttachUser?.trim() || 'unset'}`,
          `allowedUsers=${Array.isArray(config.allowedUsers) ? config.allowedUsers.length : 0}`,
        ],
      };
    },
  };
}

function buildMatrixFactory(channelId: string): ManagedChannelFactory {
  return {
    channelId,
    type: 'matrix',
    create: async () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      if (!config.homeserver?.trim() || !config.accessToken?.trim() || !config.botUserId?.trim()) {
        throw new Error(`Matrix homeserver/accessToken/botUserId are required for channel \`${channelId}\` in state/config.yaml`);
      }
      const channel = new MatrixChannel(config, channelId);
      channel.onMessage(requireRuntimeMessageHandler());
      return channel;
    },
    describe: () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      return {
        configured: Boolean(config.homeserver?.trim() && config.accessToken?.trim() && config.botUserId?.trim()),
        enabled: config.enabled !== false,
        details: [
          `homeserver=${config.homeserver?.trim() || 'missing'}`,
          `accessToken=${config.accessToken?.trim() ? 'configured' : 'missing'}`,
          `botUserId=${config.botUserId?.trim() || 'missing'}`,
        ],
      };
    },
  };
}

function buildWeWorkFactory(channelId: string): ManagedChannelFactory {
  return {
    channelId,
    type: 'wework',
    create: async () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      if (!isWeWorkChannelConfigReady(config)) {
        throw new Error(`WeChat Work webhookUrl, callback listen config, or aibot.websocket botId/secret is missing for channel \`${channelId}\` in state/config.yaml`);
      }
      const channel = new WeWorkWebhookChannel(config, channelId);
      channel.onMessage(requireRuntimeMessageHandler());
      return channel;
    },
    describe: () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      const websocketConfigured = !!(config.aibot?.websocket?.enabled && config.aibot?.websocket?.botId?.trim() && config.aibot?.websocket?.secret?.trim());
      const callbackConfigured = !!(config.listenPort && config.listenPath?.trim() && config.token?.trim() && config.encodingAESKey?.trim());
      return {
        configured: isWeWorkChannelConfigReady(config),
        enabled: config.enabled !== false,
        details: [
          `webhookUrl=${config.webhookUrl?.trim() ? 'configured' : 'unset'}`,
          `callback=${callbackConfigured ? 'configured' : 'unset'}`,
          `token=${config.token?.trim() ? 'configured' : 'unset'}`,
          `aibot.stream=${config.aibot?.stream ? 'enabled' : 'disabled'}`,
          `aibot.websocket=${websocketConfigured ? 'configured' : (config.aibot?.websocket?.enabled ? 'missing credentials' : 'disabled')}`,
          `listenPath=${config.listenPath?.trim() || 'default'}`,
        ],
      };
    },
  };
}

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
      const channel = new WeixinChannel(config, channelId);
      channel.onMessage(requireRuntimeMessageHandler());
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

function buildQQBotFactory(channelId: string): ManagedChannelFactory {
  return {
    channelId,
    type: 'qqbot',
    create: async () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      if (!isQQBotChannelConfigReady(config)) {
        throw new Error(`QQ Bot appId/clientSecret are required for channel \`${channelId}\` in state/config.yaml`);
      }
      const channel = new QQBotChannel(config, channelId);
      channel.onMessage(requireRuntimeMessageHandler());
      return channel;
    },
    describe: () => {
      const entry = getChannelConfigById(channelId, readAppConfigFile());
      const config = (entry?.config || {}) as any;
      return {
        configured: isQQBotChannelConfigReady(config),
        enabled: config.enabled !== false,
        details: [
          `appId=${config.appId?.trim() ? 'configured' : 'missing'}`,
          `clientSecret=${config.clientSecret?.trim() ? 'configured' : 'missing'}`,
          `allowedUsers=${Array.isArray(config.allowedUsers) ? config.allowedUsers.length : 0}`,
        ],
      };
    },
  };
}

function rebuildFactories(): void {
  managedFactories.clear();
  for (const entry of getNormalizedChannelConfigs(readAppConfigFile())) {
    if (entry.type === 'telegram') {
      managedFactories.set(entry.id, buildTelegramFactory(entry.id));
    } else if (entry.type === 'matrix') {
      managedFactories.set(entry.id, buildMatrixFactory(entry.id));
    } else if (entry.type === 'wework') {
      managedFactories.set(entry.id, buildWeWorkFactory(entry.id));
    } else if (entry.type === 'weixin') {
      managedFactories.set(entry.id, buildWeixinFactory(entry.id));
    } else if (entry.type === 'qqbot') {
      managedFactories.set(entry.id, buildQQBotFactory(entry.id));
    }
  }
}

function ensureFactories(): void {
  rebuildFactories();
}

export function initializeChannelRuntime(
  handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>,
  commandHandler?: (ctx: ChannelContext, command: string, args: string[], rawArgs?: string) => Promise<boolean>,
): void {
  runtimeMessageHandler = handler;
  runtimeCommandHandler = commandHandler;
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
    const configEntry = getChannelConfigById(channelId, readAppConfigFile());
    const config = (configEntry?.config || {}) as any;
    if (factory.type === 'telegram' && config.mainAttachUser) {
      sessionManager.attachChannel(channelId, config.mainAttachUser, 'main');
    } else if (factory.type === 'matrix' && config.botUserId) {
      sessionManager.attachChannel(channelId, config.botUserId, 'main');
    }
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

async function stopRegisteredChannel(channelId: string): Promise<boolean> {
  const existing = getChannelInstance(channelId);
  if (!existing) {
    return false;
  }
  await existing.stop();
  unregisterChannel(channelId);
  logger.info({ channelId, type: existing.platform }, 'Channel stopped for runtime reload');
  return true;
}

export async function reloadManagedChannels(): Promise<{ stopped: string[]; started: string[]; statuses: ChannelRuntimeStatus[] }> {
  const previousIds = new Set<string>([
    ...managedFactories.keys(),
    ...listRegisteredChannels()
      .filter(item => ['telegram', 'matrix', 'wework', 'weixin', 'qqbot'].includes(item.type))
      .map(item => item.channelInstanceId),
  ]);

  const stopped: string[] = [];
  for (const channelId of Array.from(previousIds).sort()) {
    try {
      if (await stopRegisteredChannel(channelId)) {
        stopped.push(channelId);
      }
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      lastChannelErrors.set(channelId, message);
      logger.error({ err, channelId }, 'Failed to stop channel during runtime reload');
    }
  }

  rebuildFactories();

  const started: string[] = [];
  for (const [channelId, factory] of Array.from(managedFactories.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const status = getChannelRuntimeStatus(channelId);
    if (!status?.enabled || !status.configured) {
      continue;
    }
    try {
      const result = await startManagedChannel(channelId);
      if (result.started) {
        started.push(channelId);
      }
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      lastChannelErrors.set(channelId, message);
      logger.error({ err, channelId, type: factory.type }, 'Failed to start channel during runtime reload');
    }
  }

  return {
    stopped,
    started,
    statuses: listChannelRuntimeStatuses(),
  };
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
    ...listRegisteredChannels().map(item => item.channelInstanceId),
    ...getNormalizedChannelConfigs(readAppConfigFile()).map(item => item.id),
  ]);
  return Array.from(channelIds)
    .sort()
    .map(channelId => getChannelRuntimeStatus(channelId))
    .filter((value): value is ChannelRuntimeStatus => Boolean(value))
    .filter(status => !filter?.type || status.type === filter.type);
}
