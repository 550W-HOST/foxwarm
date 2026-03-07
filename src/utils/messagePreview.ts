import { Message } from '../types'

export function getMessagePreview(msg: Message, previewLength: number = 100): string {
  let preview = ''
  for (const part of msg.parts || []) {
    if (part.text) {
      preview += part.text
    } else if (part.thinking) {
      preview += `[Thinking]`
    } else if (part.functionCall) {
      preview += `[Tool: ${part.functionCall.name}]`
    } else if (part.functionResponse) {
      preview += `[Tool Response]`
    }
  }

  if (preview.length > previewLength) {
    preview = preview.substring(0, previewLength) + '...'
  }

  return preview
}

export function formatMessagePreviewLine(msg: Message, idx: number, previewLength: number = 100): string {
  const roleEmoji = msg.role === 'user' ? '👤' : msg.role === 'model' ? '🤖' : '🔧'
  const preview = getMessagePreview(msg, previewLength)
  return `[${idx}] ${roleEmoji} ${msg.role}: ${preview}\n`
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
