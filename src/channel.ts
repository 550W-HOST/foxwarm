/**
 * Channel abstraction layer
 * Defines the interface for different messaging platforms (Telegram, Matrix, etc.)
 */

import { MessagePart } from './types';

export interface ChannelMessage {
  parts: MessagePart[];
  channelUserId: string; // Legacy field: channel-side conversation/chat/room target id
  conversationId?: string; // Preferred name for channel-side conversation/chat/room target id
  username?: string;
  /** Browser-generated identity used to reconcile one optimistic WebUI row. */
  clientMessageId?: string;
}

export interface ChannelContext {
  channelUserId: string; // Legacy field: channel-side conversation/chat/room target id
  conversationId?: string; // Preferred name for channel-side conversation/chat/room target id
  channelId?: string; // Configured channel instance id, e.g. mainbot / secondbot / weixin
  channelType?: string; // Adapter/platform type, e.g. telegram / weixin / webui
  username?: string;
  reply: (text: string, options?: any) => Promise<void>;
  sendTyping: () => Promise<void>;
  platform: string; // Legacy alias of channelType
  senderId?: string; // Actual sender/user identity, used for allowlist checks when available
  preferDirectReply?: boolean; // Prefer the source reply path instead of session broadcast for this turn
  weworkStreamId?: string; // WeWork intelligent-bot stream id for this inbound turn, when applicable
  selfName?: string; // Optional channel-configured bot/self display name for stripping leading @mentions before command parsing
  // `sessionId` is set in handleMessage internal only for tools that need it.
  // If you want to specify the session, should use `attachChannel(channelId, conversationId, targetSession)`.
}

/**
 * Message source information (without channel methods)
 */
export interface MessageSource {
  platform: string; // Legacy alias of channelType
  channelId?: string; // Configured channel instance id
  channelType?: string; // Adapter/platform type
  channelUserId: string;
  conversationId?: string;
  username: string;
  senderId?: string;
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
  readonly platform: string; // Legacy alias of channelType / adapter-platform type

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
  onCommand?(handler: (ctx: ChannelContext, command: string, args: string[], rawArgs?: string) => Promise<boolean>): void;
}

// Channel registry for broadcast
const channelInstances = new Map<string, Channel>();

/**
 * Register a channel instance for broadcast
 */
export function registerChannel(channelInstanceId: string, channel: Channel): void {
  channelInstances.set(channelInstanceId, channel);
}

export function unregisterChannel(channelInstanceId: string): void {
  channelInstances.delete(channelInstanceId);
}

/**
 * Get a registered channel instance
 */
export function getChannelInstance(channelInstanceId: string): Channel | undefined {
  return channelInstances.get(channelInstanceId);
}

export function listRegisteredChannels(): Array<{ channelInstanceId: string; type: string; name: string }> {
  return Array.from(channelInstances.entries()).map(([channelInstanceId, channel]) => ({
    channelInstanceId,
    type: channel.platform,
    name: channel.name,
  }));
}

export function getChannelId(ctx: Pick<ChannelContext, 'channelId' | 'platform'>): string {
  return ctx.channelId || ctx.platform;
}

export function getChannelType(ctx: Pick<ChannelContext, 'channelType' | 'platform'>): string {
  return ctx.channelType || ctx.platform;
}

export function getConversationId(ctx: Pick<ChannelContext, 'conversationId' | 'channelUserId'>): string {
  return ctx.conversationId || ctx.channelUserId;
}
