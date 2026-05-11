import { Message } from '../types'
import { formatMessagePreviewText, formatPrefixedMultilineText } from './messageFormat'
import { formatModelVisibilitySuffix } from '../session/messageVisibility'

export function getMessagePreview(msg: Message, previewLength: number = 100): string {
  return formatMessagePreviewText(msg, previewLength, { skipEphemeralSystem: true, skipThinking: true })
}

export function formatMessagePreviewLine(msg: Message, idx: number, previewLength: number = 100): string {
  const roleEmoji = msg.role === 'user' ? '👤' : msg.role === 'model' ? '🤖' : '🔧'
  const preview = getMessagePreview(msg, previewLength)
  return `${formatPrefixedMultilineText(`[${idx}] ${roleEmoji} ${msg.role}${formatModelVisibilitySuffix(msg)}: `, preview)}\n`
}

export function formatSessionMessagesPreview(
  sessionId: string,
  messages: Message[],
  startIndex: number,
  totalMessages: number,
  previewLength: number = 100
): string {
  if (messages.length === 0) {
    return `No messages found in session \`${sessionId}\` (total: ${totalMessages} messages).`
  }

  let result = `Session \`${sessionId}\` - showing ${messages.length} of ${totalMessages} message(s):\n\n`
  for (let i = 0; i < messages.length; i++) {
    result += formatMessagePreviewLine(messages[i], startIndex + i, previewLength)
  }
  return result
}
