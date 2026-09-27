import type { ModelStreamToolCall } from './types';

export type ModelStreamDraftSnapshot = {
  streamId: string;
  iteration: number;
  sequence: number;
  startedAt: number;
  llmRequestId: string;
  reasoning: string;
  text: string;
  toolCalls: ModelStreamToolCall[];
};

const drafts = new Map<string, ModelStreamDraftSnapshot>();

const clone = (draft: ModelStreamDraftSnapshot): ModelStreamDraftSnapshot => structuredClone(draft);

export function resetModelStreamDraft(sessionId: string, streamId: string, iteration: number, sequence: number, startedAt: number, llmRequestId: string): void {
  drafts.set(sessionId, { streamId, iteration, sequence, startedAt, llmRequestId, reasoning: '', text: '', toolCalls: [] });
}

export function updateModelStreamDraft(sessionId: string, draft: ModelStreamDraftSnapshot): void {
  drafts.set(sessionId, clone(draft));
}

export function clearModelStreamDraft(sessionId: string, streamId?: string): void {
  const current = drafts.get(sessionId);
  if (!current || (streamId && current.streamId !== streamId)) return;
  drafts.delete(sessionId);
}

export function getModelStreamDraft(sessionId: string): ModelStreamDraftSnapshot | null {
  const draft = drafts.get(sessionId);
  return draft ? clone(draft) : null;
}
