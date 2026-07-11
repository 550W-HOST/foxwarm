/**
 * Command Handler - handles bot commands
 */

import { ChannelContext, getChannelId, getChannelType, getConversationId } from './channel';
import { COMMANDS } from './commands';
import * as sessionManager from './sessionManager';
import { MessageRouter } from './messageRouter';

export class CommandHandler {
  constructor(readonly router: MessageRouter) {
  }

  isAuthorized(ctx: ChannelContext): boolean {
    return this.router.isAuthorized(getChannelId(ctx), getChannelType(ctx), getConversationId(ctx), ctx.senderId);
  }

  async handleCommand(ctx: ChannelContext, command: string, args: string[], rawArgs?: string): Promise<boolean> {
    // Check authorization
    if (!this.isAuthorized(ctx)) {
      ctx.reply(this.router.buildUnauthorizedMessage(ctx));
      return true;
    }

    const def = COMMANDS[command];
    if (!def) return false;

    let sessionId: string | undefined;
    let session: any;

    if (def.requiresSession !== false) {
      sessionId = sessionManager.getSessionByChannel(getChannelId(ctx), getConversationId(ctx));
      if (!sessionId) {
        ctx.reply('No active session found.');
        return true;
      }
      session = await sessionManager.getSession(sessionId);
    }

    await def.handler(ctx, args, sessionId, session, rawArgs);
    return true;
  }
}