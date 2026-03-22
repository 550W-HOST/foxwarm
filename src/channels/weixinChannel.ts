// Adapted in part from @tencent-weixin/openclaw-weixin v1.0.2
// foxwarm-native Weixin channel MVP: single-account, text in/out.

import crypto from 'crypto';
import { Channel, ChannelContext, ChannelMessage } from '../channel';
import { logger } from '../common';
import { getWeixinUpdates, sendWeixinMessage, sendWeixinTyping, SESSION_EXPIRED_ERRCODE } from '../weixin/api';
import { buildWeixinMessageParts, getWeixinContextToken, setWeixinContextToken } from '../weixin/inbound';
import { WeixinMessageState, WeixinMessageType } from '../weixin/types';

export interface WeixinChannelOptions {
  baseUrl: string;
  token: string;
  routeTag?: string;
  longPollTimeoutMs?: number;
}

function generateClientId(): string {
  return `foxwarm-weixin-${crypto.randomBytes(8).toString('hex')}`;
}

export class WeixinChannel implements Channel {
  readonly name: string;
  readonly platform = 'weixin';

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly routeTag?: string;
  private readonly longPollTimeoutMs?: number;

  private messageHandler?: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>;
  private pollAbortController?: AbortController;
  private pollLoopPromise?: Promise<void>;
  private getUpdatesBuf = '';
  private typingTickets = new Map<string, string>();

  constructor(options: WeixinChannelOptions, name = 'weixin') {
    this.name = name;
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.routeTag = options.routeTag;
    this.longPollTimeoutMs = options.longPollTimeoutMs;
  }

  async start(): Promise<void> {
    if (!this.token.trim()) {
      throw new Error('Weixin token is required');
    }
    if (this.pollLoopPromise) {
      return;
    }
    this.pollAbortController = new AbortController();
    this.pollLoopPromise = this.pollLoop(this.pollAbortController.signal);
    logger.info({ baseUrl: this.baseUrl }, 'Weixin channel started');
  }

  async stop(): Promise<void> {
    if (!this.pollAbortController) {
      return;
    }
    this.pollAbortController.abort();
    try {
      await this.pollLoopPromise;
    } catch {
      // ignore abort path
    }
    this.pollAbortController = undefined;
    this.pollLoopPromise = undefined;
    logger.info('Weixin channel stopped');
  }

  async sendMessage(channelUserId: string, text: string): Promise<void> {
    const contextToken = getWeixinContextToken(channelUserId);
    if (!contextToken) {
      throw new Error(`No Weixin context token cached for ${channelUserId}; cannot reply yet.`);
    }

    await sendWeixinMessage({
      baseUrl: this.baseUrl,
      token: this.token,
      routeTag: this.routeTag,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: channelUserId,
          client_id: generateClientId(),
          message_type: WeixinMessageType.BOT,
          message_state: WeixinMessageState.FINISH,
          context_token: contextToken,
          item_list: text ? [{ type: 1, text_item: { text } }] : undefined,
        },
      },
    });
  }

  async sendTyping(channelUserId: string): Promise<void> {
    const typingTicket = this.typingTickets.get(channelUserId);
    const contextToken = getWeixinContextToken(channelUserId);
    if (!typingTicket || !contextToken) {
      return;
    }

    try {
      await sendWeixinTyping({
        baseUrl: this.baseUrl,
        token: this.token,
        routeTag: this.routeTag,
        body: {
          ilink_user_id: channelUserId,
          typing_ticket: typingTicket,
          status: 1,
        },
      });
    } catch (err) {
      logger.warn({ err, channelUserId }, 'Failed to send Weixin typing indicator');
    }
  }

  onMessage(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  private async handleInboundMessage(message: any): Promise<void> {
    const channelUserId = String(message.from_user_id || '').trim();
    if (!channelUserId) {
      return;
    }

    if (message.context_token) {
      setWeixinContextToken(channelUserId, message.context_token);
    }

    const parts = buildWeixinMessageParts(message);
    const ctx: ChannelContext = {
      channelUserId,
      username: channelUserId,
      senderId: channelUserId,
      platform: this.platform,
      reply: async (text: string) => {
        await this.sendMessage(channelUserId, text);
      },
      sendTyping: async () => {
        await this.sendTyping(channelUserId);
      },
    };

    const channelMessage: ChannelMessage = {
      parts,
      channelUserId,
      username: channelUserId,
    };

    await this.messageHandler?.(ctx, channelMessage);
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        const response = await getWeixinUpdates({
          baseUrl: this.baseUrl,
          token: this.token,
          routeTag: this.routeTag,
          getUpdatesBuf: this.getUpdatesBuf,
          timeoutMs: this.longPollTimeoutMs,
        });

        if ((response.ret && response.ret !== 0) || (response.errcode && response.errcode !== 0)) {
          if (response.errcode === SESSION_EXPIRED_ERRCODE || response.ret === SESSION_EXPIRED_ERRCODE) {
            logger.error({ errcode: response.errcode, ret: response.ret }, 'Weixin session expired');
            throw new Error('Weixin session expired; re-run /weixin login and restart foxwarm.');
          }
          throw new Error(`Weixin getUpdates failed: ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg || ''}`);
        }

        consecutiveFailures = 0;
        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf.length > 0) {
          this.getUpdatesBuf = response.get_updates_buf;
        }

        for (const message of response.msgs || []) {
          await this.handleInboundMessage(message);
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        consecutiveFailures += 1;
        logger.error({ err, consecutiveFailures }, 'Weixin poll loop error');
        const delayMs = consecutiveFailures >= 3 ? 30_000 : 2_000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
