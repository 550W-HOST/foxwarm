/**
 * Matrix Channel Implementation
 */

import fs from 'fs-extra';
import { Channel, ChannelContext, ChannelFile, ChannelMessage, ChannelSendFileOptions } from '../channel';
import { buildSavedFileText, saveInboundChannelFile } from '../channelFiles';
import { MessagePart } from '../types';
import { logger } from '../common';

export class MatrixChannel implements Channel {
  readonly name: string;
  readonly platform = 'matrix';
  private readonly channelId: string;
  private client: any;
  private messageHandler?: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>;
  private homeserverUrl: string;
  private accessToken: string;
  private userId: string;
  private processedEvents = new Set<string>(); // Track processed event IDs
  private startTime = Date.now(); // Track when channel started

  constructor(homeserverUrl: string, accessToken: string, userId: string, name: string = 'matrix') {
    this.name = name;
    this.channelId = name;
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.userId = userId;
  }

  async start(): Promise<void> {
    // Dynamic import for ESM module
    const sdk = await import('matrix-js-sdk');
    this.client = sdk.createClient({
      baseUrl: this.homeserverUrl,
      accessToken: this.accessToken,
      userId: this.userId,
    });
    this.client.logger.disableAll();

    this.client.on('Room.timeline', async (event: any, room: any, toStartOfTimeline: boolean) => {
      if (toStartOfTimeline) return;
      if (event.getType() !== 'm.room.message') return;
      if (event.getSender() === this.userId) return; // Ignore own messages
      if (!this.messageHandler) return;

      // Skip events that occurred before channel started (avoid replay on restart)
      const eventTime = event.getTs();
      if (eventTime < this.startTime) return;

      // Skip already processed events
      const eventId = event.getId();
      if (this.processedEvents.has(eventId)) return;
      this.processedEvents.add(eventId);

      // Clean up old event IDs to prevent memory leak (keep last 1000)
      if (this.processedEvents.size > 1000) {
        const iter = this.processedEvents.values();
        this.processedEvents.delete(iter.next().value);
      }

      const content = event.getContent();
      const sender = event.getSender();
      if (!sender) return; // Skip if sender is undefined
      const roomId = room.roomId;

      // Handle text messages
      if (content.msgtype === 'm.text') {
        const channelCtx = this.makeChannelContext(roomId, sender);
        
        const message: ChannelMessage = {
          parts: [{ text: content.body }],
          channelUserId: roomId,
          conversationId: roomId,
          username: sender
        };

        await this.messageHandler(channelCtx, message);
      }
      // Handle image messages
      else if (content.msgtype === 'm.image') {
        try {
          const mxcUrl = content.url;
          const httpUrl = this.client.mxcUrlToHttp(mxcUrl);

          // Download image and convert to base64
          const response = await fetch(httpUrl);
          const buffer = await response.arrayBuffer();
          const binary = Buffer.from(buffer);
          const saved = await saveInboundChannelFile({
            platform: this.platform,
            channelUserId: roomId,
            buffer: binary,
            fileName: content.body || 'matrix-image',
            mimeType: content.info?.mimetype || 'image/jpeg',
            isImage: true,
          });
          const parts: MessagePart[] = [
            { text: buildSavedFileText(saved, 'image') },
            { inlineData: { mimeType: saved.mimeType, data: binary.toString('base64') } }
          ];

          const channelCtx = this.makeChannelContext(roomId, sender);
          const message: ChannelMessage = {
            parts,
            channelUserId: roomId,
            conversationId: roomId,
            username: sender
          };

          await this.messageHandler(channelCtx, message);
        } catch (e) {
          logger.error({ err: e }, 'Failed to process Matrix image');
        }
      }
      // Handle file messages
      else if (content.msgtype === 'm.file') {
        try {
          const mxcUrl = content.url;
          const httpUrl = this.client.mxcUrlToHttp(mxcUrl);
          const response = await fetch(httpUrl);
          const buffer = Buffer.from(await response.arrayBuffer());
          const saved = await saveInboundChannelFile({
            platform: this.platform,
            channelUserId: roomId,
            buffer,
            fileName: content.filename || content.body || 'matrix-file',
            mimeType: content.info?.mimetype || 'application/octet-stream',
            isImage: false,
          });

          const channelCtx = this.makeChannelContext(roomId, sender);
          const message: ChannelMessage = {
            parts: [{ text: buildSavedFileText(saved, 'file') }],
            channelUserId: roomId,
            conversationId: roomId,
            username: sender
          };

          await this.messageHandler(channelCtx, message);
        } catch (e) {
          logger.error({ err: e }, 'Failed to process Matrix file');
        }
      }
    });

    // Auto-accept invites
    this.client.on('RoomMember.membership', async (event: any, member: any) => {
      if (member.userId === this.userId && member.membership === 'invite') {
        try {
          await this.client.joinRoom(member.roomId);
          logger.info({ roomId: member.roomId }, 'Auto-joined room after invite');
        } catch (err) {
          logger.error({ err, roomId: member.roomId }, 'Failed to join room');
        }
      }
    });

    await this.client.startClient({ initialSyncLimit: 10 });
    logger.info({ name: this.name, userId: this.userId }, 'Matrix channel started');
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stopClient();
      logger.info({ name: this.name }, 'Matrix channel stopped');
    }
  }

  private makeChannelContext(roomId: string, sender: string): ChannelContext {
    return {
      channelId: this.channelId,
      channelType: this.platform,
      channelUserId: roomId,
      conversationId: roomId,
      username: sender,
      platform: this.platform,
      senderId: sender,
      reply: async (text: string, options?: any) => {
        const content: any = {
          msgtype: 'm.text',
          body: text
        };

        // Support markdown formatting
        if (options?.parse_mode === 'Markdown') {
          content.format = 'org.matrix.custom.html';
          content.formatted_body = this.markdownToHtml(text);
        }

        await this.client.sendEvent(roomId, 'm.room.message', content);
      },
      sendTyping: async () => {
        await this.client.sendTyping(roomId, true, 3000).catch(() => {});
      }
    };
  }

  private markdownToHtml(markdown: string): string {
    // Basic markdown to HTML conversion
    return markdown
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br/>');
  }

  async sendMessage(channelUserId: string, text: string, options?: any): Promise<void> {
    // channelUserId is the room ID for Matrix
    const content: any = {
      msgtype: 'm.text',
      body: text
    };

    if (options?.parse_mode === 'Markdown') {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = this.markdownToHtml(text);
    }

    await this.client.sendEvent(channelUserId, 'm.room.message', content);
  }

  async sendFile(channelUserId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<void> {
    if (options?.caption) {
      await this.sendMessage(channelUserId, options.caption, { parse_mode: options?.parse_mode });
    }

    const buffer = await fs.readFile(file.path);
    const uploadResult = await this.client.uploadContent(buffer, {
      type: file.mimeType,
      name: file.name,
    });

    const contentUri = typeof uploadResult === 'string'
      ? uploadResult
      : uploadResult?.content_uri || uploadResult?.contentUri;

    if (!contentUri) {
      throw new Error('Matrix upload did not return content_uri');
    }

    const content: any = {
      msgtype: file.isImage ? 'm.image' : 'm.file',
      body: file.name,
      filename: file.name,
      url: contentUri,
      info: {
        mimetype: file.mimeType,
        size: file.sizeBytes,
      }
    };

    await this.client.sendEvent(channelUserId, 'm.room.message', content);
  }

  async sendTyping(channelUserId: string): Promise<void> {
    await this.client.sendTyping(channelUserId, true, 3000).catch(() => {});
  }

  onMessage(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  getClient(): any {
    return this.client;
  }
}
