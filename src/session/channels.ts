import fs from 'fs-extra';
import path from 'path';
import { getChannelInstance } from '../channel';
import { logger } from '../common';
import { CHANNELS_FILE } from '../config';
import { Session, SessionReply } from '../types';

export type ChannelMode = 'push-only' | undefined;

export interface ChannelConfig {
  sessionId: string;
  mode?: ChannelMode;
  dangerouslyAllowAllGroupMembers?: boolean;
}

const channelAttachments = new Map<string, ChannelConfig>();

function makeChannelKey(platform: string, channelUserId: string): string {
  return `${platform}:${channelUserId}`;
}

async function persistChannels(): Promise<void> {
  try {
    await fs.ensureDir(path.dirname(CHANNELS_FILE));
    const data: any = { channels: {} };
    for (const [channelKey, config] of channelAttachments.entries()) {
      data.channels[channelKey] = config;
    }
    await fs.writeJson(CHANNELS_FILE, data, { spaces: 2 });
  } catch (e) {
    logger.error(e, 'Failed to save channels');
  }
}

export async function loadChannels(): Promise<void> {
  channelAttachments.clear();

  if (await fs.pathExists(CHANNELS_FILE)) {
    try {
      const data = await fs.readJson(CHANNELS_FILE);
      if (data.channels) {
        for (const [channelKey, config] of Object.entries(data.channels)) {
          channelAttachments.set(channelKey, config as ChannelConfig);
        }
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
      channelAttachments.set(channelKey, value);
    }
  }

  await persistChannels();
}

export function attachChannel(platform: string, channelUserId: string, sessionId: string): string {
  const channelKey = makeChannelKey(platform, channelUserId);
  channelAttachments.set(channelKey, { sessionId });
  void persistChannels();
  logger.info({ platform, channelUserId, sessionId }, 'Channel attached to session');
  return sessionId;
}

export function getSessionByChannel(platform: string, channelUserId: string): string | undefined {
  return channelAttachments.get(makeChannelKey(platform, channelUserId))?.sessionId;
}

export function getChannelConfig(platform: string, channelUserId: string): ChannelConfig | undefined {
  return channelAttachments.get(makeChannelKey(platform, channelUserId));
}

export function setChannelMode(platform: string, channelUserId: string, mode: ChannelMode | undefined): void {
  const channelKey = makeChannelKey(platform, channelUserId);
  const existing = channelAttachments.get(channelKey);
  if (!existing) {
    throw new Error(`Channel ${channelKey} not attached`);
  }
  channelAttachments.set(channelKey, { ...existing, mode });
  void persistChannels();
}

export function getChannelDangerouslyAllowAllGroupMembers(platform: string, channelUserId: string): boolean {
  return channelAttachments.get(makeChannelKey(platform, channelUserId))?.dangerouslyAllowAllGroupMembers ?? false;
}

export function setChannelDangerouslyAllowAllGroupMembers(platform: string, channelUserId: string, value: boolean): void {
  const channelKey = makeChannelKey(platform, channelUserId);
  const existing = channelAttachments.get(channelKey);
  if (!existing) {
    throw new Error(`Channel ${channelKey} not attached`);
  }
  channelAttachments.set(channelKey, { ...existing, dangerouslyAllowAllGroupMembers: value });
  void persistChannels();
}

export function detachChannel(platform: string, channelUserId: string): void {
  channelAttachments.delete(makeChannelKey(platform, channelUserId));
  void persistChannels();
  logger.info({ platform, channelUserId }, 'Channel detached from session');
}

export async function sendToChannelById(channelId: string, message: string): Promise<void> {
  const [platform, ...rest] = channelId.split(':');
  const channelUserId = rest.join(':');
  if (!platform || !channelUserId) {
    throw new Error('Invalid channelId format. Use platform:userId');
  }
  const channel = getChannelInstance(platform);
  if (!channel) {
    throw new Error(`Channel platform "${platform}" not found`);
  }
  await channel.sendMessage(channelUserId, message);
}

export function getChannelsBySession(sessionId: string): Array<{ platform: string; channelUserId: string }> {
  const channels: { platform: string; channelUserId: string }[] = [];
  for (const [channelKey, info] of channelAttachments.entries()) {
    if (info.sessionId === sessionId) {
      const separatorIndex = channelKey.indexOf(':');
      if (separatorIndex === -1) continue;

      const platform = channelKey.slice(0, separatorIndex);
      const channelUserId = channelKey.slice(separatorIndex + 1);
      channels.push({ platform, channelUserId });
    }
  }
  return channels;
}

function findAttachedChannel(
  channels: Array<{ platform: string; channelUserId: string }>,
  target?: { platform: string; channelUserId: string }
): { platform: string; channelUserId: string } | undefined {
  if (!target) return undefined;
  return channels.find(channel => (
    channel.platform === target.platform &&
    channel.channelUserId === target.channelUserId
  ));
}

function parseSourceSystemPart(system?: string): { platform: string; channelUserId: string } | undefined {
  if (!system) return undefined;

  if (system.startsWith('FROM: ')) {
    const raw = system.slice('FROM: '.length);
    const firstColon = raw.indexOf(':');
    if (firstColon === -1) return undefined;

    const platform = raw.slice(0, firstColon);
    let channelUserId = raw.slice(firstColon + 1);

    const userInfoMatch = channelUserId.match(/^(.*)\s\([^)]*\)$/);
    if (userInfoMatch) {
      channelUserId = userInfoMatch[1];
    }

    if (!platform || !channelUserId) return undefined;
    return { platform, channelUserId };
  }

  const channelIdMatch = system.match(/channel_id:\s*`([^`]+)`/);
  if (!channelIdMatch) return undefined;

  const rawChannelId = channelIdMatch[1];
  const firstColon = rawChannelId.indexOf(':');
  if (firstColon === -1) return undefined;

  const platform = rawChannelId.slice(0, firstColon);
  const channelUserId = rawChannelId.slice(firstColon + 1);
  if (!platform || !channelUserId) return undefined;
  return { platform, channelUserId };
}

export function getChannelBySession(sessionId: string, session?: Session): { platform: string; channelUserId: string } | undefined {
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

        const sourcePart = msg.parts.find(part => typeof part.system === 'string' && (part.system.startsWith('FROM: ') || part.system.includes('channel_id: `')));
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

export function createSessionBroadcast(sessionId: string): SessionReply {
  return (text: string, options?: any) => {
    const channels = getChannelsBySession(sessionId);
    const excludePlatforms = options?.excludePlatforms || [];
    logger.debug({ sessionId, channelCount: channels.length, excludePlatforms, textPreview: text.substring(0, 50) }, 'Broadcasting message');

    for (const channelInfo of channels) {
      if (excludePlatforms.includes(channelInfo.platform)) {
        logger.debug({ platform: channelInfo.platform, channelUserId: channelInfo.channelUserId }, 'Skipping excluded platform');
        continue;
      }

      const channelConfig = getChannelConfig(channelInfo.platform, channelInfo.channelUserId);
      if (channelConfig?.mode === 'push-only') {
        logger.debug({ platform: channelInfo.platform, channelUserId: channelInfo.channelUserId, sessionId }, 'Skipping push-only channel during broadcast');
        continue;
      }

      const channel = getChannelInstance(channelInfo.platform);
      if (channel) {
        logger.debug({ platform: channelInfo.platform, channelUserId: channelInfo.channelUserId }, 'Calling channel.sendMessage');
        channel.sendMessage(channelInfo.channelUserId, text, options)?.catch((e: any) => {
          logger.error({ err: e, platform: channelInfo.platform, channelUserId: channelInfo.channelUserId }, 'Failed to broadcast message');
        });
      } else {
        logger.debug({ platform: channelInfo.platform }, 'Channel instance not found');
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