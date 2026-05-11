import type { Message } from '../types';

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

export function formatModelVisibilitySuffix(message: Pick<Message, 'modelVisible'>): string {
  return isModelVisibleMessage(message) ? '' : ' [display-only]';
}
