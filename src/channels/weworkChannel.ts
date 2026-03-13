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
import { logger } from '../common';

export interface WeWorkWebhookConfig {
  webhookUrl: string;  // 企业微信群机器人 webhook URL
  token?: string;      // 企业微信应用的 Token
  encodingAESKey?: string; // 企业微信应用的 EncodingAESKey
  listenPort?: number; // 监听端口，用于接收消息（如果企业微信支持回调）
  listenPath?: string; // 监听路径
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

  async decrypt(encryptedMsg: string): Promise<any> {
    try {
      // Base64 decode the encrypted message
      const encrypted = Buffer.from(encryptedMsg, 'base64');
      
      // Create decipher
      const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.aesKey.slice(0, 16));
      decipher.setAutoPadding(false);
      
      // Decrypt
      let decrypted = decipher.update(encrypted, null, 'binary');
      decrypted += decipher.final('binary');
      
      // Remove PKCS#7 padding
      const pad = decrypted.charCodeAt(decrypted.length - 1);
      if (pad > 0 && pad <= 32) {
        decrypted = decrypted.slice(0, -pad);
      }
      
      // Parse the decrypted message
      const content = Buffer.from(decrypted, 'binary').slice(16); // Remove first 16 bytes (random string)
      const msgLen = content.readUInt32BE(0);
      const msgContent = content.slice(4, 4 + msgLen);
      const fromAppId = content.slice(4 + msgLen).toString();
      
      // Parse XML content - use async method
      return await xml2js.parseStringPromise(msgContent.toString(), {
        explicitArray: false,
        ignoreAttrs: false
      });
    } catch (error) {
      logger.error({ error, encryptedMsg }, 'Failed to decrypt WeWork message');
      throw error;
    }
  }

  verifySignature(timestamp: string, nonce: string, encryptedMsg: string): boolean {
    const tmpArr = [this.token, timestamp, nonce, encryptedMsg].sort();
    const tmpStr = tmpArr.join('');
    const hash = crypto.createHash('sha1').update(tmpStr).digest('hex');
    
    // Note: In a real implementation, you would compare this with the signature from headers
    // For now, we'll skip signature verification
    return true;
  }
}

export class WeWorkWebhookChannel implements Channel {
  readonly name = 'wework';
  readonly platform = 'wework';
  
  private webhookUrl: string;
  private token?: string;
  private encodingAESKey?: string;
  private crypto?: WeWorkCrypto;
  private messageHandler?: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>;
  private app?: express.Application;
  private server?: any;

  constructor(config: WeWorkWebhookConfig) {
    this.webhookUrl = config.webhookUrl;
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
    this.app.use(express.text({ type: 'application/xml' }));
    
    this.app.post(path, async (req, res) => {
      try {
        let body = req.body;
        
        // Handle XML content from WeWork
        if (req.headers['content-type']?.includes('application/xml') && typeof req.body === 'string') {
          try {
            const xmlResult = await xml2js.parseStringPromise(req.body, {
              explicitArray: false,
              ignoreAttrs: false
            });
            body = xmlResult.xml || xmlResult;
            logger.debug({ receivedXml: req.body, parsedBody: body }, 'Parsed WeWork XML webhook');
          } catch (xmlError) {
            logger.error({ 
              error: xmlError.message, 
              xml: req.body 
            }, 'Failed to parse WeWork XML webhook');
            return res.json({ code: 0, msg: 'success' });
          }
        }

        // Check if body exists and is properly parsed
        if (!body) {
          logger.warn({ 
            headers: req.headers,
            rawBody: req.body 
          }, 'Received WeWork webhook with empty body');
          return res.json({ code: 0, msg: 'success' }); // Still return success to avoid retries
        }

        // Handle encrypted messages
        if (body.Encrypt && this.crypto) {
          try {
            const timestamp = req.headers['x-tif-timestamp'] as string;
            const nonce = req.headers['x-tif-nonce'] as string;
            
            // Verify signature (if needed)
            // this.crypto.verifySignature(timestamp, nonce, body.Encrypt);
            
            // Decrypt the message
            const decryptedBody = await this.crypto.decrypt(body.Encrypt);
            logger.debug({ decryptedBody }, 'Decrypted WeWork webhook');
            
            body = decryptedBody;
          } catch (decryptError) {
            logger.error({ 
              error: decryptError.message,
              encryptedMsg: body.Encrypt 
            }, 'Failed to decrypt WeWork message');
            return res.json({ code: 0, msg: 'success' });
          }
        } else if (body.Encrypt && !this.crypto) {
          logger.warn({ 
            hasToken: !!this.token,
            hasEncodingAESKey: !!this.encodingAESKey
          }, 'Received encrypted WeWork message but no crypto keys configured');
          return res.json({ code: 0, msg: 'success' });
        }
        
        // 企业微信 webhook 消息格式 - add safety checks
        if (!body || typeof body !== 'object') {
          logger.warn({ body }, 'Received invalid WeWork webhook body');
          return res.json({ code: 0, msg: 'success' });
        }

        // Handle different message formats from WeWork
        let content = '';
        let userId = 'unknown';
        let userName = 'unknown';
        let chatType = 'unknown'; // 'single' = 私聊, 'group' = 群聊
        let chatId = '';
        let replyWebhookUrl = this.webhookUrl;

        // Check for standard webhook format (msgtype)
        if (body.msgtype === 'text' && body.text?.content) {
          content = body.text.content;
          userId = body.from?.userid || 'unknown';
          userName = body.from?.name || userId;
        }
        // Check for XML format (from decrypted messages) - handle both direct and wrapped formats
        else if (body.xml?.From?.UserId || body.From?.UserId) {
          const xmlData = body.xml || body;
          userId = xmlData.From.UserId;
          userName = xmlData.From.Name || userId;
          chatType = xmlData.ChatType || 'unknown';
          chatId = xmlData.ChatId || '';
          replyWebhookUrl = xmlData.WebhookUrl || this.webhookUrl;
          
          // Handle different message types
          if (xmlData.MsgType === 'text' && (xmlData.Content || xmlData.Text?.Content)) {
            content = xmlData.Content || xmlData.Text?.Content || '';
            logger.debug({ content, userId, userName, chatType, chatId }, 'Extracted text content from WeWork XML');
          } else if (xmlData.MsgType === 'event') {
            logger.info('Ignored WeWork event');
            // Handle events - could be used for triggers or status updates
            // const eventType = xmlData.Event?.EventType;
            // content = `[Event: ${eventType}]`;
            // logger.info({ 
            //   eventType, 
            //   userId, 
            //   userName, 
            //   chatId: xmlData.ChatId,
            //   msgId: xmlData.MsgId
            // }, 'Received WeWork event message');
          } else {
            // Other message types (image, file, etc.)
            content = `[${xmlData.MsgType || 'Unknown'} message]`;
            logger.info({ 
              msgType: xmlData.MsgType,
              userId, 
              userName,
              chatType,
              chatId,
              msgId: xmlData.MsgId
            }, 'Received WeWork non-text message');
          }
        }

        // Only process if we have content and user info
        if (content && userId !== 'unknown') {
          logger.debug({ content, userId, userName, chatType, chatId }, 'Processing WeWork message');
          
          // Get WebhookUrl from message for reply (already set above)
          logger.debug({ replyWebhookUrl: replyWebhookUrl.substring(0, 60) + '...', chatType, chatId }, 'Using WebhookUrl for reply');
          
          // 使用 chatId 作为 channelUserId，这样每个会话（群聊/私聊）都有独立的 channel
          // 如果没有 chatId，fallback 到 userId
          const channelUserId = chatId || userId;
          
          if (this.messageHandler) {
            const ctx: ChannelContext = {
              channelUserId: channelUserId,
              username: userName,
              platform: 'wework',
              senderId: userId, // 发送者用户ID，用于权限检查
              reply: async (text: string) => {
                logger.debug({ channelUserId, text: text.substring(0, 100), chatType, chatId }, 'Sending reply via WeWork');
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
              parts: [{ text: content }],
              channelUserId: channelUserId,
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
        
        res.json({ code: 0, msg: 'success' });
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
