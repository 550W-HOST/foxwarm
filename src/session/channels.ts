import { ChannelFile, ChannelSendFileOptions, getChannelInstance } from '../channel';
import { logger } from '../common';
import { CHANNELS_FILE } from '../config';
import { Session, SessionBroadcast } from '../types';
import { DiskJsonData } from '../utils/diskJsonData';
import { parseFoxwarmTagLine } from '../utils/promptWrappers';

export type ChannelMode = 'send-only' | undefined;
type LegacyChannelMode = 'push-only';

export interface ChannelConfig {
  sessionId: string;
  mode?: ChannelMode | LegacyChannelMode;
  dangerouslyAllowAllUsers?: boolean;
  dangerouslyAllowAllGroupMembers?: boolean; // legacy compatibility on load/read only
}

export interface FileDeliveryResult {
  deliveredChannels: string[];
  skippedChannels: Array<{ channelId: string; reason: string }>;
  failedChannels: Array<{ channelId: string; error: string }>;
}

type SessionChannelDeps = {
  getExistingSession: (sessionId: string) => Promise<Session | null>;
};

export type ChannelTarget = {
  channelInstanceId: string;
  conversationId: string;
};

const channelAttachments = new Map<string, ChannelConfig>();

function normalizeChannelsPayload(raw: any, filePath: string): { channels: Record<string, ChannelConfig> } {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid channels payload in ${filePath}`);
  }

  const channels = raw.channels && typeof raw.channels === 'object' ? raw.channels : {};
  return { channels };
}

export function createChannelsStore(filePath: string = CHANNELS_FILE): DiskJsonData<{ channels: Record<string, ChannelConfig> }> {
  return new DiskJsonData<{ channels: Record<string, ChannelConfig> }>(filePath, {
    backup: false,
    normalizeLoadedData: normalizeChannelsPayload,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read channels candidate');
    },
  });
}

let channelsStore = createChannelsStore();

export function setChannelsStoreForTests(store: DiskJsonData<{ channels: Record<string, ChannelConfig> }> | null): void {
  channelsStore = store || createChannelsStore();
  channelAttachments.clear();
}

export function resetChannelsForTests(): void {
  channelAttachments.clear();
}

function makeChannelKey(channelInstanceId: string, conversationId: string): string {
  return `${channelInstanceId}:${conversationId}`;
}

export function parseChannelTargetId(channelTargetId: string): ChannelTarget {
  const [channelInstanceId, ...rest] = channelTargetId.split(':');
  const conversationId = rest.join(':');
  if (!channelInstanceId || !conversationId) {
    throw new Error('Invalid channelTargetId format. Use <channel-instance-id>:<conversation-id>');
  }

  return { channelInstanceId, conversationId };
}

function normalizeChannelConfig(config: ChannelConfig): ChannelConfig {
  const normalized: ChannelConfig = {
    sessionId: config.sessionId,
  };

  if (config.mode === 'send-only' || config.mode === 'push-only') {
    normalized.mode = 'send-only';
  }

  const dangerouslyAllowAllUsers = config.dangerouslyAllowAllUsers ?? config.dangerouslyAllowAllGroupMembers;
  if (dangerouslyAllowAllUsers !== undefined) {
    normalized.dangerouslyAllowAllUsers = Boolean(dangerouslyAllowAllUsers);
  }

  return normalized;
}

async function persistChannels(): Promise<void> {
  try {
    const data: any = { channels: {} };
    for (const [channelKey, config] of channelAttachments.entries()) {
      data.channels[channelKey] = normalizeChannelConfig(config);
    }
    await channelsStore.write(data);
  } catch (e) {
    logger.error(e, 'Failed to save channels');
  }
}

export async function loadChannels(): Promise<void> {
  channelAttachments.clear();

  const loaded = await channelsStore.loadFirstAvailable();
  if (loaded) {
    try {
      const data = loaded.data;
      if (data.channels) {
        for (const [channelKey, config] of Object.entries(data.channels)) {
          channelAttachments.set(channelKey, normalizeChannelConfig(config as ChannelConfig));
        }
      }
      if (loaded.source !== channelsStore.filePath) {
        logger.warn({ source: loaded.source }, 'Recovering channels from fallback source');
        await channelsStore.write(data);
      }
      logger.info({ attachmentCount: channelAttachments.size }, 'Channels loaded');
    } catch (e) {
      logger.error(e, 'Failed to load channels');
    }
  }
}

export async function saveChannels(): Promise<void> {
  await persistChannels();
}

export async function importLegacyChannelAttachments(attachments: Record<string, string | ChannelConfig>): Promise<void> {
  for (const [channelKey, value] of Object.entries(attachments)) {
    if (typeof value === 'string') {
      channelAttachments.set(channelKey, { sessionId: value });
    } else if (value && typeof value === 'object' && typeof value.sessionId === 'string') {
      channelAttachments.set(channelKey, normalizeChannelConfig(value));
    }
  }

  await persistChannels();
}

export function attachChannel(channelId: string, conversationId: string, sessionId: string, configUpdates?: Partial<ChannelConfig>): string {
  const channelKey = makeChannelKey(channelId, conversationId);
  channelAttachments.set(channelKey, normalizeChannelConfig({ sessionId, ...(configUpdates || {}) } as ChannelConfig));
  void persistChannels();
  logger.info({ channelId, conversationId, sessionId, configUpdates }, 'Channel attached to session');
  return sessionId;
}

export function getSessionByChannel(channelId: string, conversationId: string): string | undefined {
  return channelAttachments.get(makeChannelKey(channelId, conversationId))?.sessionId;
}

export function getChannelConfig(channelId: string, conversationId: string): ChannelConfig | undefined {
  const config = channelAttachments.get(makeChannelKey(channelId, conversationId));
  return config ? normalizeChannelConfig(config) : undefined;
}

export function setChannelMode(channelId: string, conversationId: string, mode: ChannelMode | undefined): void {
  const channelKey = makeChannelKey(channelId, conversationId);
  const existing = channelAttachments.get(channelKey);
  if (!existing) {
    throw new Error(`Channel ${channelKey} not attached`);
  }
  channelAttachments.set(channelKey, normalizeChannelConfig({ ...existing, mode }));
  void persistChannels();
}

export function getChannelDangerouslyAllowAllUsers(channelId: string, conversationId: string): boolean {
  const config = channelAttachments.get(makeChannelKey(channelId, conversationId));
  return Boolean(config?.dangerouslyAllowAllUsers ?? config?.dangerouslyAllowAllGroupMembers);
}

export function setChannelDangerouslyAllowAllUsers(channelId: string, conversationId: string, value: boolean): void {
  const channelKey = makeChannelKey(channelId, conversationId);
  const existing = channelAttachments.get(channelKey);
  if (!existing) {
    throw new Error(`Channel ${channelKey} not attached`);
  }
  channelAttachments.set(channelKey, normalizeChannelConfig({ ...existing, dangerouslyAllowAllUsers: value }));
  void persistChannels();
}

export function detachChannel(channelId: string, conversationId: string): void {
  channelAttachments.delete(makeChannelKey(channelId, conversationId));
  void persistChannels();
  logger.info({ channelId, conversationId }, 'Channel detached from session');
}

export async function sendToChannelTargetId(channelTargetId: string, message: string): Promise<void> {
  const { channelInstanceId, conversationId } = parseChannelTargetId(channelTargetId);
  const channel = getChannelInstance(channelInstanceId);
  if (!channel) {
    throw new Error(`Channel instance \`${channelInstanceId}\` not found`);
  }
  await channel.sendMessage(conversationId, message);
}

export async function sendFileToChannelTargetId(channelTargetId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<void> {
  const { channelInstanceId, conversationId } = parseChannelTargetId(channelTargetId);
  const channel = getChannelInstance(channelInstanceId);
  if (!channel) {
    throw new Error(`Channel instance \`${channelInstanceId}\` not found`);
  }
  if (!channel.sendFile) {
    throw new Error(`Channel instance \`${channelInstanceId}\` does not support file sending yet`);
  }

  await channel.sendFile(conversationId, file, options);
}

export async function sendFileToSession(
  deps: SessionChannelDeps,
  sessionId: string,
  file: ChannelFile,
  options?: ChannelSendFileOptions
): Promise<FileDeliveryResult> {
  const session = await deps.getExistingSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found`);
  }

  const channels = getChannelsBySession(sessionId);
  if (channels.length === 0) {
    throw new Error(`Session \`${sessionId}\` has no attached channels`);
  }

  const result: FileDeliveryResult = {
    deliveredChannels: [],
    skippedChannels: [],
    failedChannels: [],
  };

  for (const channelInfo of channels) {
    const targetId = `${channelInfo.channelId}:${channelInfo.conversationId}`;
    const channelConfig = getChannelConfig(channelInfo.channelId, channelInfo.conversationId);
    if (channelConfig?.mode === 'send-only') {
      result.skippedChannels.push({ channelId: targetId, reason: 'send-only' });
      continue;
    }

    const channel = getChannelInstance(channelInfo.channelId);
    if (!channel) {
      result.failedChannels.push({ channelId: targetId, error: `Channel \`${channelInfo.channelId}\` not found` });
      continue;
    }

    if (!channel.sendFile) {
      result.skippedChannels.push({ channelId: targetId, reason: 'channel does not support file sending yet' });
      continue;
    }

    try {
      await channel.sendFile(channelInfo.conversationId, file, options);
      result.deliveredChannels.push(targetId);
    } catch (err: any) {
      result.failedChannels.push({ channelId: targetId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

export function getChannelsBySession(sessionId: string): Array<{ channelId: string; conversationId: string }> {
  const channels: { channelId: string; conversationId: string }[] = [];
  for (const [channelKey, info] of channelAttachments.entries()) {
    if (info.sessionId === sessionId) {
      const separatorIndex = channelKey.indexOf(':');
      if (separatorIndex === -1) continue;

      const channelId = channelKey.slice(0, separatorIndex);
      const conversationId = channelKey.slice(separatorIndex + 1);
      channels.push({ channelId, conversationId });
    }
  }
  return channels;
}

function findAttachedChannel(
  channels: Array<{ channelId: string; conversationId: string }>,
  target?: { channelId: string; channelUserId: string; conversationId?: string }
): { channelId: string; conversationId: string } | undefined {
  if (!target) return undefined;
  const targetConversationId = target.conversationId || target.channelUserId;
  return channels.find(channel => (
    channel.channelId === target.channelId &&
    channel.conversationId === targetConversationId
  ));
}

function parseSourceSystemPart(system?: string): { channelId: string; channelUserId: string; conversationId: string } | undefined {
  if (!system) return undefined;

  const foxwarmTag = parseFoxwarmTagLine(system);
  if (foxwarmTag?.tagName === 'foxwarm-message' && !foxwarmTag.closing && foxwarmTag.attrs.type === 'channel') {
    const channelId = foxwarmTag.attrs.channelInstanceId || foxwarmTag.attrs.channelId || foxwarmTag.attrs.channelType;
    const conversationId = foxwarmTag.attrs.conversationId || foxwarmTag.attrs.channelUserId;
    if (!channelId || !conversationId) return undefined;
    return { channelId, channelUserId: conversationId, conversationId };
  }

  if (system.startsWith('FROM: ')) {
    const raw = system.slice('FROM: '.length);
    const firstColon = raw.indexOf(':');
    if (firstColon === -1) return undefined;

    const channelId = raw.slice(0, firstColon);
    let channelUserId = raw.slice(firstColon + 1);

    const userInfoMatch = channelUserId.match(/^(.*)\s\([^)]*\)$/);
    if (userInfoMatch) {
      channelUserId = userInfoMatch[1];
    }

    if (!channelId || !channelUserId) return undefined;
    return { channelId, channelUserId, conversationId: channelUserId };
  }

  const directChannelIdMatch = system.match(/channel_(?:instance_)?id:\s*`([^`]+)`/);
  const conversationIdMatch = system.match(/conversation_id:\s*`([^`]+)`/);
  if (directChannelIdMatch && conversationIdMatch) {
    const channelId = directChannelIdMatch[1];
    const conversationId = conversationIdMatch[1];
    if (!channelId || !conversationId) return undefined;
    return { channelId, channelUserId: conversationId, conversationId };
  }

  if (!directChannelIdMatch) return undefined;

  const rawChannelId = directChannelIdMatch[1];
  const firstColon = rawChannelId.indexOf(':');
  if (firstColon === -1) return undefined;

  const channelId = rawChannelId.slice(0, firstColon);
  const channelUserId = rawChannelId.slice(firstColon + 1);
  if (!channelId || !channelUserId) return undefined;
  return { channelId, channelUserId, conversationId: channelUserId };
}

export function getChannelBySession(sessionId: string, session?: Session): { channelId: string; conversationId: string } | undefined {
  const channels = getChannelsBySession(sessionId);

  if (channels.length === 0) return undefined;
  if (channels.length === 1) return channels[0];

  if (session) {
    const lastChannel = findAttachedChannel(channels, session.meta?.lastChannel);
    if (lastChannel) {
      return lastChannel;
    }

    if (session.history.length > 0) {
      for (let i = session.history.length - 1; i >= 0; i--) {
        const msg = session.history[i];
        if (msg.role !== 'user') continue;

        const sourcePart = msg.parts.find(part => typeof part.system === 'string' && (part.system.startsWith('FROM: ') || part.system.includes('channel_id: `') || part.system.includes('channel_instance_id: `') || parseFoxwarmTagLine(part.system)?.attrs.type === 'channel'));
        const parsedChannel = parseSourceSystemPart(sourcePart?.system);
        const attachedChannel = findAttachedChannel(channels, parsedChannel);
        if (attachedChannel) {
          return attachedChannel;
        }
      }
    }
  }

  return channels[0];
}

export function createSessionBroadcast(sessionId: string): SessionBroadcast {
  return (text: string, options?: any) => {
    const channels = getChannelsBySession(sessionId);
    const excludePlatforms = options?.excludePlatforms || [];
    const targetChannel = options?.targetChannel;
    const isEmptyBroadcast = typeof text !== 'string' || text.trim().length === 0;
    logger.debug({ sessionId, channelCount: channels.length, excludePlatforms, textPreview: text.substring(0, 50) }, 'Broadcasting message');

    for (const channelInfo of channels) {
      if (targetChannel && (targetChannel.channelId !== channelInfo.channelId || targetChannel.conversationId !== channelInfo.conversationId)) {
        continue;
      }

      if (isEmptyBroadcast && !options?.allowEmptyBroadcast) {
        continue;
      }

      if (excludePlatforms.includes(channelInfo.channelId)) {
        logger.debug({ channelId: channelInfo.channelId, conversationId: channelInfo.conversationId }, 'Skipping excluded channel');
        continue;
      }

      const channelConfig = getChannelConfig(channelInfo.channelId, channelInfo.conversationId);
      if (channelConfig?.mode === 'send-only') {
        logger.debug({ channelId: channelInfo.channelId, conversationId: channelInfo.conversationId, sessionId }, 'Skipping send-only channel during broadcast');
        continue;
      }

      const channel = getChannelInstance(channelInfo.channelId);
      if (channel) {
        logger.debug({ channelId: channelInfo.channelId, conversationId: channelInfo.conversationId }, 'Calling channel.sendMessage');
        channel.sendMessage(channelInfo.conversationId, text, options)?.catch((e: any) => {
          logger.error({ err: e, channelId: channelInfo.channelId, conversationId: channelInfo.conversationId }, 'Failed to broadcast message');
        });
      } else {
        logger.debug({ channelId: channelInfo.channelId }, 'Channel instance not found');
      }
    }
  };
}

export function detachChannelsForSession(sessionId: string): void {
  let changed = false;
  for (const [key, info] of channelAttachments.entries()) {
    if (info.sessionId === sessionId) {
      channelAttachments.delete(key);
      changed = true;
    }
  }
  if (changed) {
    void persistChannels();
  }
}

export function getAllAttachments(): Map<string, ChannelConfig> {
  return channelAttachments;
}
