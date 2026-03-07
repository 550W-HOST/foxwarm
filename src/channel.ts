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

/**
 * Get a registered channel instance
 */
export function getChannelInstance(platform: string): Channel | undefined {
  return channelInstances.get(platform);
}
