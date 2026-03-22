/**
 * WeChat Work (企业微信) Webhook Channel
 * Supports group bot webhooks
 */

import axios from 'axios';
import express from 'express';
import fs from 'fs-extra';
import xml2js from 'xml2js';
import crypto from 'crypto';
import { Channel, ChannelContext, ChannelFile, ChannelMessage, ChannelSendFileOptions } from '../channel';
import { buildSavedFileText, saveInboundChannelFile } from '../channelFiles';
import { logger } from '../common';
import { MessagePart } from '../types';

export interface WeWorkWebhookConfig {
  webhookUrl?: string;  // 企业微信群机器人 webhook URL
  token?: string;      // 企业微信应用的 Token
  encodingAESKey?: string; // 企业微信应用的 EncodingAESKey
  listenPort?: number; // 监听端口，用于接收消息（如果企业微信支持回调）
  listenPath?: string; // 监听路径
  name?: string;
}

class WeWorkCrypto {
  private token: string;
  private encodingAESKey: string;
  private aesKey: Buffer;

  constructor(token: string, encodingAESKey: string) {
    this.token = token;
    this.encodingAESKey = encodingAESKey;
    this.aesKey = Buffer.from(encodingAESKey + '=', 'base64');
  }

  private stripPkcs7Padding(buffer: Buffer): Buffer {
    const pad = buffer[buffer.length - 1];
    if (!pad || pad < 1 || pad > 32) {
      return buffer;
    }
    return buffer.subarray(0, buffer.length - pad);
  }

  private decryptAes(buffer: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.aesKey.slice(0, 16));
    decipher.setAutoPadding(false);
    return this.stripPkcs7Padding(Buffer.concat([decipher.update(buffer), decipher.final()]));
  }

  decryptCallbackMessage(encryptedMsg: string): string {
    const encrypted = Buffer.from(encryptedMsg, 'base64');
    const decrypted = this.decryptAes(encrypted);
    const content = decrypted.subarray(16);
    const msgLen = content.readUInt32BE(0);
    const msgContent = content.subarray(4, 4 + msgLen);
    return msgContent.toString('utf8');
  }

  decryptAttachment(buffer: Buffer): Buffer {
    return this.decryptAes(buffer);
  }

  verifySignature(signature: string | undefined, timestamp: string, nonce: string, encryptedMsg: string): boolean {
    if (!signature) {
      return false;
    }
    const tmpArr = [this.token, timestamp, nonce, encryptedMsg].sort();
    const tmpStr = tmpArr.join('');
    const hash = crypto.createHash('sha1').update(tmpStr).digest('hex');
    return hash === signature;
  }
}

export class WeWorkWebhookChannel implements Channel {
  readonly name: string;
  readonly platform = 'wework';
  private readonly channelId: string;
  
  private webhookUrl: string;
  private token?: string;
  private encodingAESKey?: string;
  private crypto?: WeWorkCrypto;
  private messageHandler?: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>;
  private app?: express.Application;
  private server?: any;

  constructor(config: WeWorkWebhookConfig) {
    this.name = config.name || 'wework';
    this.channelId = this.name;
    this.webhookUrl = config.webhookUrl || '';
    this.token = config.token;
    this.encodingAESKey = config.encodingAESKey;
    
    // Initialize crypto if we have the required keys
    if (this.token && this.encodingAESKey) {
      this.crypto = new WeWorkCrypto(this.token, this.encodingAESKey);
    }
    
    // 企业微信群机器人目前主要是单向发送，如果需要接收可以配置监听
    if (config.listenPort && config.listenPath) {
      this.setupWebhookListener(config.listenPort, config.listenPath);
    }
  }

  private setupWebhookListener(port: number, path: string) {
    this.app = express();
    
    // Add XML parsing middleware for WeWork
    this.app.use(express.json());
    this.app.use(express.text({ type: ['application/xml', 'text/xml'] }));

    this.app.get(path, async (req, res) => {
      try {
        if (!this.crypto) {
          return res.status(400).send('Missing crypto config');
        }

        const timestamp = this.getRequestString(req.query.timestamp);
        const nonce = this.getRequestString(req.query.nonce);
        const echostr = this.safeUrlDecode(this.getRequestString(req.query.echostr));
        const signature = this.getRequestString(req.query.msg_signature);

        if (!timestamp || !nonce || !echostr || !signature) {
          return res.status(400).send('Missing verification query');
        }

        if (!this.crypto.verifySignature(signature, timestamp, nonce, echostr)) {
          logger.warn({ timestamp, nonce }, 'WeWork GET verification signature mismatch');
          return res.status(401).send('Invalid signature');
        }

        const plaintext = this.crypto.decryptCallbackMessage(echostr);
        res.type('text/plain').send(plaintext);
      } catch (error: any) {
        logger.error({ err: error, query: req.query }, 'WeWork GET verification failed');
        res.status(500).send(error?.message || 'verification failed');
      }
    });

    this.app.post(path, async (req, res) => {
      try {
        const normalized = await this.normalizeInboundBody(req);
        if (!normalized.body) {
          logger.warn({ headers: req.headers, rawBody: req.body }, 'Received WeWork webhook with empty or invalid body');
          return res.json({ code: 0, msg: 'success' });
        }

        const body = normalized.body;
        const isAIBot = normalized.isAIBot;

        // Handle different message formats from WeWork
        let content = '';
        let userId = 'unknown';
        let userName = 'unknown';
        let chatType = 'unknown'; // 'single' = 私聊, 'group' = 群聊
        let chatId = '';
        let replyWebhookUrl = this.webhookUrl;
        let responseUrl = '';
        let parts: MessagePart[] | null = null;

        // Check for standard webhook format (msgtype)
        if (typeof body.msgtype === 'string' && body.from?.userid) {
          userId = body.from?.userid || 'unknown';
          userName = body.from?.name || userId;
          chatType = body.chattype || 'unknown';
          chatId = body.chatid || '';
          responseUrl = body.response_url || '';

          parts = await this.buildInboundMessageParts(body, chatId || userId, responseUrl || replyWebhookUrl, {
            isAIBot: isAIBot || !!responseUrl,
          });
          content = parts?.map(part => part.text).filter(Boolean).join('\n') || '';
        }
        // Check for XML format (from decrypted messages) - handle both direct and wrapped formats
        else if (body.xml?.From?.UserId || body.From?.UserId) {
          const xmlData = body.xml || body;
          userId = xmlData.From.UserId;
          userName = xmlData.From.Name || userId;
          chatType = xmlData.ChatType || 'unknown';
          chatId = xmlData.ChatId || '';
          replyWebhookUrl = xmlData.WebhookUrl || this.webhookUrl;

          parts = await this.buildInboundMessageParts(xmlData, chatId || userId, replyWebhookUrl, { isAIBot: false });
          content = parts?.map(part => part.text).filter(Boolean).join('\n') || '';
        }

        // Only process if we have content and user info
        if ((parts?.length || content) && userId !== 'unknown') {
          logger.debug({ content, userId, userName, chatType, chatId }, 'Processing WeWork message');
          
          // Get WebhookUrl from message for reply (already set above)
          logger.debug({ replyWebhookUrl: replyWebhookUrl.substring(0, 60) + '...', chatType, chatId }, 'Using WebhookUrl for reply');
          
          // 使用 chatId 作为 channelUserId，这样每个会话（群聊/私聊）都有独立的 channel
          // 如果没有 chatId，fallback 到 userId
          const channelUserId = chatId || userId;
          
          if (this.messageHandler) {
            const ctx: ChannelContext = {
              channelId: this.channelId,
              channelType: this.platform,
              channelUserId: channelUserId,
              conversationId: channelUserId,
              username: userName,
              platform: 'wework',
              senderId: userId, // 发送者用户ID，用于权限检查
              preferDirectReply: !!responseUrl,
              reply: async (text: string) => {
                logger.debug({ channelUserId, text: text.substring(0, 100), chatType, chatId }, 'Sending reply via WeWork');
                if (responseUrl) {
                  await this.sendAIBotResponse(responseUrl, text);
                  return;
                }

                await this.sendMessage(channelUserId, text, {
                  webhookUrl: replyWebhookUrl,
                  chatId: chatId,
                  chatType: chatType
                });
              },
              sendTyping: async () => {
                // WeWork webhook doesn't support typing indicator
              }
            };

            const message: ChannelMessage = {
              parts: parts && parts.length ? parts : [{ text: content }],
              channelUserId: channelUserId,
              conversationId: channelUserId,
              username: userName
            };

            this.messageHandler(ctx, message);
          } else {
            logger.warn('No message handler configured for WeWork channel');
          }
        } else {
          const xmlData = body.xml || body;
          logger.debug({ 
            msgtype: body.msgtype,
            hasText: !!body.text,
            hasContent: !!body.text?.content,
            hasXml: !!body.xml,
            hasFrom: !!xmlData.From,
            hasXmlContent: !!(xmlData.Content || xmlData.Text?.Content),
            msgType: xmlData.MsgType,
            content,
            userId,
            bodyKeys: Object.keys(body),
            xmlKeys: Object.keys(xmlData),
            fullBody: body
          }, 'Received WeWork webhook without processable content');
        }

        if (isAIBot || responseUrl) {
          res.status(200).send('');
        } else {
          res.json({ code: 0, msg: 'success' });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logger.error({ 
          error: errorMessage, 
          stack: errorStack,
          body: req.body,
          headers: req.headers,
          contentType: req.headers['content-type']
        }, 'Error handling WeWork webhook');
        res.status(500).json({ code: -1, msg: 'error', error: errorMessage });
      }
    });
    
    this.server = this.app.listen(port, () => {
      logger.info(`WeWork webhook listener started on port ${port}${path}`);
    });
  }

  async start(): Promise<void> {
    logger.info('WeWork Webhook channel initialized');
    logger.info({ webhookUrl: this.webhookUrl }, 'WeWork webhook URL configured');
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
    }
  }

  onMessage(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  private getRequestString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return '';
  }

  private safeUrlDecode(value: string): string {
    if (!value) return value;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private async parseXmlBody(xml: string): Promise<any> {
    const xmlResult = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: false
    });
    return xmlResult.xml || xmlResult;
  }

  private async parseDecryptedPayload(plaintext: string): Promise<any> {
    const trimmed = plaintext.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return JSON.parse(trimmed);
    }

    return this.parseXmlBody(trimmed);
  }

  private async normalizeInboundBody(req: express.Request): Promise<{ body: any; isAIBot: boolean }> {
    let body = req.body;
    const contentType = String(req.headers['content-type'] || '');

    if (typeof body === 'string' && (contentType.includes('xml') || body.trim().startsWith('<'))) {
      body = await this.parseXmlBody(body);
      logger.debug({ parsedBody: body }, 'Parsed WeWork XML webhook');
    }

    if (!body) {
      return { body: null, isAIBot: false };
    }

    const encrypted = typeof body?.encrypt === 'string'
      ? body.encrypt
      : (typeof body?.Encrypt === 'string' ? body.Encrypt : undefined);
    if (!encrypted) {
      return { body, isAIBot: false };
    }

    if (!this.crypto) {
      logger.warn({ hasToken: !!this.token, hasEncodingAESKey: !!this.encodingAESKey }, 'Received encrypted WeWork message but no crypto keys configured');
      return { body: null, isAIBot: false };
    }

    const timestamp = this.getRequestString(req.query.timestamp || req.headers['x-tif-timestamp']);
    const nonce = this.getRequestString(req.query.nonce || req.headers['x-tif-nonce']);
    const signature = this.getRequestString(req.query.msg_signature || req.headers['x-tif-signature']);

    if (timestamp && nonce && signature && !this.crypto.verifySignature(signature, timestamp, nonce, encrypted)) {
      logger.warn({ timestamp, nonce }, 'WeWork encrypted callback signature mismatch');
      throw new Error('Invalid WeWork callback signature');
    }

    const plaintext = this.crypto.decryptCallbackMessage(encrypted);
    const parsed = await this.parseDecryptedPayload(plaintext);
    logger.debug({ decryptedType: typeof parsed, keys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : undefined }, 'Decrypted WeWork webhook');

    return {
      body: parsed,
      isAIBot: typeof body?.encrypt === 'string' || typeof parsed?.response_url === 'string' || typeof parsed?.aibotid === 'string',
    };
  }

  private extractWebhookKey(webhookUrl: string): string | undefined {
    try {
      return new URL(webhookUrl).searchParams.get('key') || undefined;
    } catch {
      return undefined;
    }
  }

  private async downloadInboundMedia(options: {
    webhookUrl: string;
    directUrl?: string;
    mediaId?: string;
    encrypted?: boolean;
  }): Promise<Buffer> {
    if (options.directUrl) {
      const response = await axios.get(options.directUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      const buffer = Buffer.from(response.data);
      return options.encrypted && this.crypto ? this.crypto.decryptAttachment(buffer) : buffer;
    }

    if (options.mediaId) {
      const key = this.extractWebhookKey(options.webhookUrl);
      if (!key) {
        throw new Error('WeWork webhook URL is missing key, cannot download media by media_id');
      }

      const url = new URL(options.webhookUrl);
      const downloadUrl = `${url.origin}/cgi-bin/webhook/get_media?key=${encodeURIComponent(key)}&media_id=${encodeURIComponent(options.mediaId)}`;
      const response = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
      });

      const contentType = String(response.headers['content-type'] || '');
      if (contentType.includes('application/json')) {
        const payload = JSON.parse(Buffer.from(response.data).toString('utf8'));
        if (payload.errcode !== 0) {
          throw new Error(`WeWork media download failed: ${payload.errmsg || 'unknown'} (code: ${payload.errcode ?? 'unknown'})`);
        }
      }

      const buffer = Buffer.from(response.data);
      return options.encrypted && this.crypto ? this.crypto.decryptAttachment(buffer) : buffer;
    }

    logger.warn({ options }, 'No WeWork media download source available');
    throw new Error('No WeWork media download source available');
  }

  private buildQuoteText(payload: any): string | undefined {
    if (!payload?.quote?.msgtype) return undefined;
    const quoteType = payload.quote.msgtype;
    if (quoteType === 'text' && payload.quote.text?.content) {
      return `[Quoted text]\n${payload.quote.text.content}`;
    }
    return `[Quoted ${quoteType} message]`;
  }

  private appendQuote(parts: MessagePart[], payload: any): MessagePart[] {
    const quoteText = this.buildQuoteText(payload);
    if (quoteText) {
      parts.push({ text: quoteText });
    }
    return parts;
  }

  private async buildAIBotFileParts(payload: any, channelUserId: string, kind: 'image' | 'file'): Promise<MessagePart[]> {
    const media = payload[kind] || {};
    const url = media.url;
    const msgId = payload.msgid || payload.msgId || 'upload';
    const fallbackName = kind === 'image'
      ? `wework-image-${msgId}.jpg`
      : `wework-file-${msgId}`;

    const buffer = await this.downloadInboundMedia({
      webhookUrl: payload.response_url || this.webhookUrl,
      directUrl: url,
      encrypted: true,
    });
    const saved = await saveInboundChannelFile({
      platform: this.platform,
      channelUserId,
      buffer,
      fileName: media.filename || media.file_name || payload.file_name || fallbackName,
      mimeType: media.mime_type || media.mimetype || (kind === 'image' ? 'image/jpeg' : 'application/octet-stream'),
      isImage: kind === 'image',
    });

    const parts: MessagePart[] = [{ text: buildSavedFileText(saved, kind) }];
    if (kind === 'image') {
      parts.push({ inlineData: { mimeType: saved.mimeType, data: buffer.toString('base64') } });
    }
    return parts;
  }

  private async buildMixedMessageParts(payload: any, channelUserId: string): Promise<MessagePart[]> {
    const parts: MessagePart[] = [];
    const items = Array.isArray(payload?.mixed?.msg_item) ? payload.mixed.msg_item : [];
    for (const item of items) {
      if (item?.msgtype === 'text' && item.text?.content) {
        parts.push({ text: item.text.content });
      } else if (item?.msgtype === 'image') {
        const nestedPayload = { ...payload, msgtype: 'image', image: item.image, quote: undefined };
        parts.push(...await this.buildAIBotFileParts(nestedPayload, channelUserId, 'image'));
      } else {
        parts.push({ text: `[Mixed item: ${item?.msgtype || 'unknown'}]` });
      }
    }
    return parts;
  }

  private async buildInboundMessageParts(payload: any, channelUserId: string, replyWebhookUrl: string, options: { isAIBot: boolean }): Promise<MessagePart[] | null> {
    const msgType = payload.msgtype || payload.MsgType;

    if (msgType === 'text' && (payload.text?.content || payload.Content || payload.Text?.Content)) {
      const content = payload.text?.content || payload.Content || payload.Text?.Content || '';
      logger.debug({ content, userId: payload.from?.userid || payload.From?.UserId, chatId: payload.chatid || payload.ChatId }, 'Extracted WeWork text content');
      return this.appendQuote([{ text: content }], payload);
    }

    if (options.isAIBot && msgType === 'image') {
      return this.appendQuote(await this.buildAIBotFileParts(payload, channelUserId, 'image'), payload);
    }

    if (options.isAIBot && msgType === 'file') {
      return this.appendQuote(await this.buildAIBotFileParts(payload, channelUserId, 'file'), payload);
    }

    if (options.isAIBot && msgType === 'mixed') {
      return this.appendQuote(await this.buildMixedMessageParts(payload, channelUserId), payload);
    }

    if (options.isAIBot && msgType === 'voice' && payload.voice?.content) {
      return this.appendQuote([{ text: payload.voice.content }], payload);
    }

    if (msgType === 'image') {
      const directUrl = payload.ImageUrl || payload.PicUrl || payload.Url || payload.image?.url;
      const mediaId = payload.MediaId || payload.media_id;
      const buffer = await this.downloadInboundMedia({
        webhookUrl: replyWebhookUrl,
        directUrl,
        mediaId,
        encrypted: !!payload.image?.url,
      });
      const saved = await saveInboundChannelFile({
        platform: this.platform,
        channelUserId,
        buffer,
        fileName: payload.FileName || payload.file_name || `wework-image-${payload.MsgId || payload.msgid || payload.MediaId || mediaId || 'upload'}.jpg`,
        mimeType: payload.MimeType || payload.mime_type || 'image/jpeg',
        isImage: true,
      });
      return [
        { text: buildSavedFileText(saved, 'image') },
        { inlineData: { mimeType: saved.mimeType, data: buffer.toString('base64') } }
      ];
    }

    if (msgType === 'file') {
      const directUrl = payload.Url || payload.file?.url;
      const mediaId = payload.MediaId || payload.media_id;
      const buffer = await this.downloadInboundMedia({
        webhookUrl: replyWebhookUrl,
        directUrl,
        mediaId,
        encrypted: !!payload.file?.url,
      });
      const saved = await saveInboundChannelFile({
        platform: this.platform,
        channelUserId,
        buffer,
        fileName: payload.FileName || payload.file_name || `wework-file-${payload.MsgId || payload.msgid || payload.MediaId || mediaId || 'upload'}`,
        mimeType: payload.MimeType || payload.mime_type || 'application/octet-stream',
        isImage: false,
      });
      return [{ text: buildSavedFileText(saved, 'file') }];
    }

    if (msgType === 'event') {
      logger.info('Ignored WeWork event');
      return null;
    }

    logger.info({
      msgType,
      userId: payload.from?.userid || payload.From?.UserId,
      chatType: payload.chattype || payload.ChatType,
      chatId: payload.chatid || payload.ChatId,
      msgId: payload.msgid || payload.MsgId,
      imageKeys: payload.image ? Object.keys(payload.image) : undefined,
      fileKeys: payload.file ? Object.keys(payload.file) : undefined,
    }, 'Received unsupported or partially supported WeWork message type');
    return [{ text: `[${msgType || 'Unknown'} message]` }];
  }

  private getEffectiveChatId(userId: string, options?: any): string | undefined {
    return options?.chatId || (userId.startsWith('wok') || userId.startsWith('wrk') ? userId : undefined);
  }

  private async postWebhookPayload(webhookUrl: string, payload: any, userId: string, context: Record<string, any> = {}): Promise<void> {
    const maxRetries = 3;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(webhookUrl, payload, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });

        if (response.data.errcode !== 0) {
          const errorMsg = `WeWork API error: ${response.data.errmsg} (code: ${response.data.errcode})`;
          logger.error({ response: response.data, payload, userId, ...context }, errorMsg);
          throw new Error(errorMsg);
        }

        logger.debug({ response: response.data, userId, attempt, ...context }, 'WeWork payload sent successfully');
        return;
      } catch (error: any) {
        const statusCode = error.response?.status;
        if (attempt < maxRetries && (statusCode >= 500 || !statusCode)) {
          logger.warn({ attempt, maxRetries, statusCode, error: error.message, userId, ...context }, 'WeWork send failed, retrying...');
          await new Promise(r => setTimeout(r, retryDelay * attempt));
          continue;
        }
        throw error;
      }
    }
  }

  private async sendAIBotResponse(responseUrl: string, text: string): Promise<void> {
    if (!responseUrl) {
      throw new Error('Missing WeWork response_url for active reply');
    }

    const payload = {
      msgtype: 'markdown',
      markdown: {
        content: text,
      }
    };

    const response = await axios.post(responseUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000,
    });

    if (response.data?.errcode !== undefined && response.data.errcode !== 0) {
      throw new Error(`WeWork aibot response failed: ${response.data.errmsg || 'unknown'} (code: ${response.data.errcode})`);
    }
  }

  private buildMultipartBody(file: ChannelFile, buffer: Buffer, boundary: string): Buffer {
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.mimeType}\r\n\r\n`,
      'utf8'
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    return Buffer.concat([header, buffer, footer]);
  }

  private async uploadMedia(webhookUrl: string, file: ChannelFile): Promise<string> {
    const url = new URL(webhookUrl);
    const key = url.searchParams.get('key');
    if (!key) {
      throw new Error('WeWork webhook URL is missing key, cannot upload media');
    }

    const uploadUrl = `${url.origin}/cgi-bin/webhook/upload_media?key=${encodeURIComponent(key)}&type=file`;
    const buffer = await fs.readFile(file.path);
    const boundary = `foxwarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const body = this.buildMultipartBody(file, buffer, boundary);

    const response = await axios.post(uploadUrl, body, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 20000,
    });

    if (response.data.errcode !== 0 || !response.data.media_id) {
      throw new Error(`WeWork media upload failed: ${response.data.errmsg || 'missing media_id'} (code: ${response.data.errcode ?? 'unknown'})`);
    }

    return response.data.media_id;
  }

  async sendMessage(userId: string, text: string, options?: any): Promise<void> {
    try {
      // 企业微信群机器人支持多种消息类型，默认使用 markdown
      const messageType = options?.messageType || 'markdown';
      
      // Use provided webhookUrl or fall back to configured one
      const webhookUrl = options?.webhookUrl || this.webhookUrl;
      if (!webhookUrl) {
        throw new Error('WeWork webhookUrl is not configured for proactive sendMessage');
      }
      logger.debug({ webhookUrl: webhookUrl.substring(0, 50) + '...', hasCustomUrl: !!options?.webhookUrl }, 'Sending WeWork message');
      
      let payload: any;
      
      switch (messageType) {
        case 'markdown':
          payload = {
            msgtype: 'markdown',
            markdown: {
              content: text
            }
          };
          break;
          
        case 'text':
        default:
          payload = {
            msgtype: 'text',
            text: {
              content: text,
              mentioned_list: options?.mentionedList || [],
              mentioned_mobile_list: options?.mentionedMobileList || []
            }
          };
          break;
      }

      // 如果有 chatId，添加到 payload 中以支持私聊回复
      // userId 在 wecom 场景下实际是 chatId（群聊 wrk 开头，私聊 wok 开头）
      const effectiveChatId = this.getEffectiveChatId(userId, options);
      if (effectiveChatId) {
        payload = { ...payload, chatid: effectiveChatId };
      }

      logger.debug({ 
        payload, 
        chatId: effectiveChatId,
        chatType: options?.chatType,
        originalUserId: userId
      }, 'Sending WeWork message');

      await this.postWebhookPayload(webhookUrl, payload, userId, {
        chatId: effectiveChatId,
        chatType: options?.chatType,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      logger.error({ 
        error: errorMessage,
        stack: errorStack,
        userId,
        text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        webhookUrl: this.webhookUrl
      }, 'Error sending WeWork message');
      
      // Re-throw with more context
      throw new Error(`Failed to send WeWork message: ${errorMessage}`);
    }
  }

  async sendFile(userId: string, file: ChannelFile, options?: ChannelSendFileOptions): Promise<void> {
    const webhookUrl = options?.webhookUrl || this.webhookUrl;
    if (!webhookUrl) {
      throw new Error('WeWork webhookUrl is not configured for proactive sendFile');
    }
    const effectiveChatId = this.getEffectiveChatId(userId, options);

    if (options?.caption) {
      await this.sendMessage(userId, options.caption, {
        ...options,
        messageType: 'text',
        webhookUrl,
        chatId: effectiveChatId,
      });
    }

    if (file.isImage) {
      const buffer = await fs.readFile(file.path);
      const payload: any = {
        msgtype: 'image',
        image: {
          base64: buffer.toString('base64'),
          md5: crypto.createHash('md5').update(buffer).digest('hex')
        }
      };

      if (effectiveChatId) {
        payload.chatid = effectiveChatId;
      }

      await this.postWebhookPayload(webhookUrl, payload, userId, {
        chatId: effectiveChatId,
        fileName: file.name,
        kind: 'image',
      });
      return;
    }

    const mediaId = await this.uploadMedia(webhookUrl, file);
    const payload: any = {
      msgtype: 'file',
      file: {
        media_id: mediaId
      }
    };

    if (effectiveChatId) {
      payload.chatid = effectiveChatId;
    }

    await this.postWebhookPayload(webhookUrl, payload, userId, {
      chatId: effectiveChatId,
      fileName: file.name,
      kind: 'file',
    });
  }

  async sendTyping(userId: string): Promise<void> {
    // WeWork webhook doesn't support typing indicator
  }

  /**
   * Send markdown message
   */
  async sendMarkdown(text: string): Promise<void> {
    await this.sendMessage('', text, { messageType: 'markdown' });
  }

  /**
   * Send text message with mentions
   */
  async sendTextWithMentions(text: string, userIds: string[], mobiles: string[] = []): Promise<void> {
    await this.sendMessage('', text, {
      messageType: 'text',
      mentionedList: userIds,
      mentionedMobileList: mobiles
    });
  }

  /**
   * Send image message
   */
  async sendImage(base64: string, md5: string): Promise<void> {
    try {
      const payload = {
        msgtype: 'image',
        image: {
          base64: base64,
          md5: md5
        }
      };

      const response = await axios.post(this.webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.data.errcode !== 0) {
        logger.error({ response: response.data }, 'Failed to send WeWork image');
        throw new Error(`WeWork API error: ${response.data.errmsg}`);
      }
    } catch (error) {
      logger.error({ error }, 'Error sending WeWork image');
      throw error;
    }
  }

  /**
   * Send news (article) message
   */
  async sendNews(articles: Array<{
    title: string;
    description?: string;
    url: string;
    picurl?: string;
  }>): Promise<void> {
    try {
      const payload = {
        msgtype: 'news',
        news: {
          articles: articles
        }
      };

      const response = await axios.post(this.webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.data.errcode !== 0) {
        logger.error({ response: response.data }, 'Failed to send WeWork news');
        throw new Error(`WeWork API error: ${response.data.errmsg}`);
      }
    } catch (error) {
      logger.error({ error }, 'Error sending WeWork news');
      throw error;
    }
  }
}
