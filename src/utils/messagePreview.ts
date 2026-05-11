import { Message } from '../types'
import { formatMessagePreviewText, formatPrefixedMultilineText } from './messageFormat'
import { formatModelVisibilitySuffix, redactDisplayOnlyMessageForModel } from '../session/messageVisibility'

export type MessagePreviewOptions = {
  hideDisplayOnlyContent?: boolean
}

export function getMessagePreview(msg: Message, previewLength: number = 100, options: MessagePreviewOptions = {}): string {
  const message = options.hideDisplayOnlyContent ? redactDisplayOnlyMessageForModel(msg) : msg
  return formatMessagePreviewText(message, previewLength, { skipEphemeralSystem: true, skipThinking: true })
}

export function formatMessagePreviewLine(msg: Message, idx: number, previewLength: number = 100, options: MessagePreviewOptions = {}): string {
  const roleEmoji = msg.role === 'user' ? '👤' : msg.role === 'model' ? '🤖' : '🔧'
  const preview = getMessagePreview(msg, previewLength, options)
  return `${formatPrefixedMultilineText(`[${idx}] ${roleEmoji} ${msg.role}${formatModelVisibilitySuffix(msg)}: `, preview)}\n`
}

export function formatSessionMessagesPreview(
  sessionId: string,
  messages: Message[],
  startIndex: number,
  totalMessages: number,
  previewLength: number = 100,
  options: MessagePreviewOptions = {},
): string {
  if (messages.length === 0) {
    return `No messages found in session \`${sessionId}\` (total: ${totalMessages} messages).`
  }

  let result = `Session \`${sessionId}\` - showing ${messages.length} of ${totalMessages} message(s):\n\n`
  for (let i = 0; i < messages.length; i++) {
    result += formatMessagePreviewLine(messages[i], startIndex + i, previewLength, options)
  }
  return result
}
