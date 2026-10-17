import { MODEL_EFFORTS } from '../config';
import type { EffectiveRequestSelection, Message } from '../types';
import { formatFoxwarmSystemTag } from '../utils/promptWrappers';
import { buildTimestampedSystemMessageParts } from '../utils/systemMessageParts';

export function readEffectiveRequestSelection(value: unknown): EffectiveRequestSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as EffectiveRequestSelection;
  if (typeof candidate.modelId !== 'string' || !candidate.modelId
    || typeof candidate.nodeId !== 'string' || !candidate.nodeId
    || !MODEL_EFFORTS.includes(candidate.effort)
    || (candidate.missingModelKey !== undefined && typeof candidate.missingModelKey !== 'string')) return undefined;
  return candidate;
}

/** Compare adopted request configurations, never raw aliases or snapshot markers. */
export function buildEffectiveSelectionNotice(
  previous: EffectiveRequestSelection | undefined,
  current: EffectiveRequestSelection,
  reason: 'effective-selection' | 'failover',
): Message | undefined {
  const modelChanged = !!previous && previous.modelId !== current.modelId;
  const nodeChanged = !!previous && previous.nodeId !== current.nodeId;
  const missingModelChanged = !!current.missingModelKey
    && (modelChanged || previous?.missingModelKey !== current.missingModelKey);
  if (!modelChanged && !nodeChanged && !missingModelChanged) return undefined;
  return {
    role: 'user',
    parts: buildTimestampedSystemMessageParts(formatFoxwarmSystemTag({
      kind: 'session-settings-changed',
      reason: missingModelChanged ? 'missing-model' : modelChanged ? reason : 'effective-selection',
      modelId: current.modelId,
      effectiveEffort: current.effort,
      ...(modelChanged ? {
        oldModel: previous!.modelId, newModel: current.modelId,
        oldEffort: previous!.effort, newEffort: current.effort,
      } : {}),
      ...(nodeChanged ? { oldNode: previous!.nodeId, newNode: current.nodeId } : {}),
      ...(missingModelChanged ? { requestedModel: current.missingModelKey, fallback: 'global-default' } : {}),
    })),
  };
}
