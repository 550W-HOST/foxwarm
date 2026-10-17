import type { ChannelContext } from '../channel';
import type { SessionControlAction, SessionControlFeedback } from '../../packages/shared/dist/sessionControlFeedback';

/** WebUI consumes structured feedback in its status area; text channels retain their acknowledgements. */
export function replySessionControl(ctx: ChannelContext, action: SessionControlAction, feedback: Omit<SessionControlFeedback, 'action'>, textFallback: string): void {
  if (ctx.channelType === 'webui') {
    void ctx.reply(feedback.message, { sessionControlFeedback: { ...feedback, action, message: feedback.message.slice(0, 512), ...(feedback.details ? { details: feedback.details.slice(0, 4096) } : {}) } });
  } else void ctx.reply(textFallback);
}
