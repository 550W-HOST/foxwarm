/**
 * Channel abstraction layer
 * Defines the interface for different messaging platforms (Telegram, Matrix, etc.)
 */

import { MessagePart } from './types';

export interface ChannelMessage {
  parts: MessagePart[];
  channelUserId: string; // Platform-specific user ID
  username?: string;
}

export interface ChannelContext {
  channelUserId: string;
  username?: string;
  reply: (text: string, options?: any) => Promise<void>;
  sendTyping: () => Promise<void>;
  platform: string; // 'telegram' | 'matrix'
  senderId?: string; // 发送者用户ID（用于权限检查，在某些平台如 wecom 中与 channelUserId 不同）
  preferDirectReply?: boolean; // Prefer the source reply path instead of session broadcast for this turn
  // `sessionId` is set in handleMessage internal only for tools that need it.
  // If you want to specify the session, should use `attachChannel(platform, channelUserId, targetSession)`.
}

/**
 * Message source information (without channel methods)
 */
export interface MessageSource {
  platform: string;
  channelUserId: string;
  username: string;
}

export interface ChannelFile {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
}

export interface ChannelSendFileOptions {
  caption?: string;
  parse_mode?: string;
  [key: string]: any;
}

export interface Channel {
  readonly name: string;
  readonly platform: string;

  /**
   * Start the channel (connect, listen for messages)
   */
  start(): Promise<void>;

  /**
   * Stop the channel
   */
  stop(): Promise<void>;

  /**
   * Send a message to a user
   */
  sendMessage(channelUserId: string, text: string, options?: any): Promise<void>;

  /**
   * Send a local file to a user/channel. Optional because some channels only
   * support text responses.
   */
  sendFile?(channelUserId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<void>;

  /**
   * Send typing indicator
   */
  sendTyping(channelUserId: string): Promise<void>;

  /**
   * Set message handler
   */
  onMessage(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void;

  /**
   * Set command handler (optional)
   */
  onCommand?(handler: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>): void;
}

// Channel registry for broadcast
const channelInstances = new Map<string, Channel>();

/**
 * Register a channel instance for broadcast
 */
export function registerChannel(platform: string, channel: Channel): void {
  channelInstances.set(platform, channel);
}

export function unregisterChannel(platform: string): void {
  channelInstances.delete(platform);
}

/**
 * Get a registered channel instance
 */
export function getChannelInstance(platform: string): Channel | undefined {
  return channelInstances.get(platform);
}

export function listRegisteredChannels(): Array<{ platform: string; name: string }> {
  return Array.from(channelInstances.entries()).map(([platform, channel]) => ({
    platform,
    name: channel.name,
  }));
}
