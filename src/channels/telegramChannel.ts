/**
 * Telegram Channel Implementation
 */

import fs from 'fs';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import { Channel, ChannelContext, ChannelFile, ChannelMessage, ChannelSendFileOptions } from '../channel';
import { buildSavedFileText, saveInboundChannelFile } from '../channelFiles';
import { COMMANDS } from '../commands';
import { MessagePart } from '../types';
import { logger } from '../common';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function tgRetry<T>(fn: () => Promise<T>): Promise<T> {
  let retries = 0;
  const maxRetries = 3;
  while (retries <= maxRetries) {
    try {
      return await fn();
    } catch (e: any) {
      const isPayloadError = e.response?.error_code === 400 ||
        e.message?.includes('400: Bad Request') ||
        e.message?.includes('can\'t parse entities');
      if (isPayloadError) throw e;
      retries++;
      const waitTime = (retries === 1) ? 5000 : 10000;
      logger.error({ attempt: retries, error: e.message }, 'Telegram API Error, retrying...');
      if (retries > maxRetries) throw e;
      await sleep(waitTime);
    }
  }
  throw new Error('Unreachable');
}

export class TelegramChannel implements Channel {
  readonly name: string;
  readonly platform = 'telegram';
  private bot: Telegraf;
  private messageHandler?: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>;
  private commandHandler?: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>;

  constructor(token: string, name: string = 'telegram') {
    this.name = name;
    this.bot = new Telegraf(token);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle commands
    this.bot.on('text', async (ctx) => {
      if (ctx.message.from.is_bot) return;

      let text = ctx.message.text;

      if (text.startsWith('/')) {
        const commandToken = text.split(' ')[0];
        const mentionIndex = commandToken.indexOf('@');
        if (mentionIndex !== -1) {
          const mention = commandToken.slice(mentionIndex + 1).toLowerCase();
          const botUsername = (ctx.botInfo?.username || '').toLowerCase();
          if (botUsername && mention === botUsername) {
            text = commandToken.slice(0, mentionIndex) + text.slice(commandToken.length);
          }
        }
      }

      // Check if it's a command
      if (text.startsWith('/') && this.commandHandler) {
        const parts = text.split(' ');
        const command = parts[0];
        const args = parts.slice(1);

        const channelCtx = this.makeChannelContext(ctx);
        const handled = await this.commandHandler(channelCtx, command, args);

        if (handled) return; // Command was handled, don't process as message
      }

      // Process as regular message
      if (!this.messageHandler) return;

      const channelCtx = this.makeChannelContext(ctx);
      const message: ChannelMessage = {
        parts: [{ text }],
        channelUserId: ctx.chat.id.toString(),
        username: ctx.from.username
      };

      // Don't await, to prevent telegram handler timeout
      this.messageHandler(channelCtx, message);
    });

    this.bot.on('photo', async (ctx) => {
      if (ctx.message.from.is_bot) return;
      if (!this.messageHandler) return;

      const photo = ctx.message.photo.pop()!;
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      const text = ctx.message.caption || '';
      const saved = await saveInboundChannelFile({
        platform: this.platform,
        channelUserId: ctx.chat.id.toString(),
        buffer,
        fileName: `telegram-photo-${photo.file_unique_id || photo.file_id}.jpg`,
        mimeType: 'image/jpeg',
        isImage: true,
      });

      const parts: MessagePart[] = [
        { text: buildSavedFileText(saved, 'image', text) },
        { inlineData: { mimeType: saved.mimeType, data: buffer.toString('base64') } }
      ];

      const channelCtx = this.makeChannelContext(ctx);
      const message: ChannelMessage = {
        parts,
        channelUserId: ctx.chat.id.toString(),
        username: ctx.from.username
      };

      this.messageHandler(channelCtx, message);
    });

    this.bot.on('document', async (ctx) => {
      if (!this.messageHandler) return;

      const doc = ctx.message.document;
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      const saved = await saveInboundChannelFile({
        platform: this.platform,
        channelUserId: ctx.chat.id.toString(),
        buffer,
        fileName: doc.file_name || `telegram-document-${doc.file_unique_id || doc.file_id}`,
        mimeType: doc.mime_type || 'application/octet-stream',
        isImage: doc.mime_type?.startsWith('image/'),
      });
      const caption = ctx.message.caption || '';

      if (doc.mime_type?.startsWith('image/')) {
        const parts: MessagePart[] = [
          { text: buildSavedFileText(saved, 'image', caption) },
          { inlineData: { mimeType: saved.mimeType, data: buffer.toString('base64') } }
        ];

        const channelCtx = this.makeChannelContext(ctx);
        const message: ChannelMessage = {
          parts,
          channelUserId: ctx.chat.id.toString(),
          username: ctx.from.username
        };

        this.messageHandler(channelCtx, message);
      } else {
        const text = buildSavedFileText(saved, 'file', caption);
        const parts: MessagePart[] = [{ text }];

        const channelCtx = this.makeChannelContext(ctx);
        const message: ChannelMessage = {
          parts,
          channelUserId: ctx.chat.id.toString(),
          username: ctx.from.username
        };

        this.messageHandler(channelCtx, message);
      }
    });
  }

  private makeChannelContext(ctx: any): ChannelContext {
    return {
      channelUserId: ctx.chat.id.toString(),
      username: ctx.from.username,
      platform: this.platform,
      senderId: ctx.from.id.toString(),
      reply: (text: string, options?: any) => {
        const opts = options || {};
        if (!opts.parse_mode) {
          opts.parse_mode = 'Markdown';
        }

        // No need to await
        tgRetry(() => ctx.reply(text, opts)).catch((err) => {
          // If Markdown parsing failed, retry with plain text
          if (err.response?.error_code === 400 || err.message?.includes('can\'t parse entities')) {
            logger.warn({ error: err.message }, 'Markdown failed, retrying with plain text');
            const plainOpts = { ...opts };
            delete plainOpts.parse_mode;
            tgRetry(() => ctx.reply(text, plainOpts)).catch(err => {
              logger.warn({ err }, "Failed to reply");
            });
          } else {
            throw err;
          }
        });

        return Promise.resolve();
      },
      sendTyping: () => {
        ctx.sendChatAction('typing').catch(() => {});
        return Promise.resolve();
      }
    };
  }

  async start(): Promise<void> {
    const tgCommands = Object.entries(COMMANDS)
      .filter(([_, def]) => def.showInTelegram !== false)
      .map(([cmd, def]) => ({
        command: cmd.replace(/^\//, ''),
        description: def.description
      }));

    await this.bot.telegram.setMyCommands(tgCommands);
    logger.info('Telegram bot commands registered');

    const launchBot = (): Promise<void> => new Promise(async (resolve) => {
      try {
        this.bot.launch(resolve);
      } catch (e) {
        logger.error({ err: e }, 'Bot launch failed, retrying in 5s...');
        setTimeout(() => launchBot().then(resolve), 5000);
      }
    });

    await launchBot();
    logger.info({ name: this.name }, 'Telegram channel started');
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    logger.info({ name: this.name }, 'Telegram channel stopped');
  }

  async sendMessage(channelUserId: string, text: string, options?: any): Promise<void> {
    const opts = options || {};
    // Try Markdown first, fallback to plain text
    if (!opts.parse_mode) {
      opts.parse_mode = 'Markdown';
    }

    try {
      await tgRetry(() => this.bot.telegram.sendMessage(parseInt(channelUserId), text, opts));
    } catch (err: any) {
      // If Markdown parsing failed, retry with plain text
      if (err.response?.error_code === 400 || err.message?.includes('can\'t parse entities')) {
        logger.warn({ error: err.message }, 'Markdown failed, retrying with plain text');
        const plainOpts = { ...opts };
        delete plainOpts.parse_mode;
        await tgRetry(() => this.bot.telegram.sendMessage(parseInt(channelUserId), text, plainOpts));
      } else {
        throw err;
      }
    }
  }

  async sendFile(channelUserId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<void> {
    const chatId = parseInt(channelUserId);
    const caption = typeof options?.caption === 'string' && options.caption.trim().length > 0
      ? options.caption
      : undefined;
    const parseMode = options?.parse_mode || (caption ? 'Markdown' : undefined);

    const send = async (currentParseMode?: string) => {
      const sendOptions: any = {};
      if (caption) {
        sendOptions.caption = caption;
      }
      if (currentParseMode) {
        sendOptions.parse_mode = currentParseMode;
      }

      const source = { source: fs.createReadStream(file.path), filename: file.name };
      if (file.isImage) {
        await tgRetry(() => this.bot.telegram.sendPhoto(chatId, source as any, sendOptions));
      } else {
        await tgRetry(() => this.bot.telegram.sendDocument(chatId, source as any, sendOptions));
      }
    };

    try {
      await send(parseMode);
    } catch (err: any) {
      if (caption && (err.response?.error_code === 400 || err.message?.includes('can\'t parse entities'))) {
        logger.warn({ error: err.message }, 'Telegram file caption markdown failed, retrying with plain text');
        await send(undefined);
        return;
      }
      throw err;
    }
  }

  async sendTyping(channelUserId: string): Promise<void> {
    await this.bot.telegram.sendChatAction(parseInt(channelUserId), 'typing');
  }

  onMessage(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCommand(handler: (ctx: ChannelContext, command: string, args: string[]) => Promise<boolean>): void {
    this.commandHandler = handler;
  }

  getBot(): Telegraf {
    return this.bot;
  }
}
