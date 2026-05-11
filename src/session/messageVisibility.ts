import type { Message } from '../types';

export const DISPLAY_ONLY_HIDDEN_TEXT = '[display-only message hidden]';

export function isModelVisibleMessage(message?: Pick<Message, 'modelVisible'> | null): boolean {
  return message?.modelVisible !== false;
}

export function createDisplayOnlyModelMessage(text: string, meta: Record<string, any> = {}): Message {
  return {
    role: 'model',
    modelVisible: false,
    parts: [{ text }],
    __meta: {
      timestamp: Date.now(),
      ...meta,
    },
  };
}

export function redactDisplayOnlyMessageForModel(message: Message): Message {
  if (isModelVisibleMessage(message)) {
    return message;
  }

  return {
    ...message,
    parts: [{ text: DISPLAY_ONLY_HIDDEN_TEXT }],
  };
}

export function formatModelVisibilitySuffix(message: Pick<Message, 'modelVisible'>): string {
  return isModelVisibleMessage(message) ? '' : ' [display-only]';
}
