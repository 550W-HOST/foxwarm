import type { ModelEffort } from '../config';
import type { QueueItem } from '../types';
import { formatFoxwarmSystemTag } from '../utils/promptWrappers';
import { buildTimestampedSystemMessageParts } from '../utils/systemMessageParts';

/** Internal provenance supplied by authenticated entry points, never by a settings patch. */
export type SessionSettingsActor =
  | { kind: 'webui'; role: 'admin' | 'webui'; identityId?: string }
  | { kind: 'channel'; channelType: string; channelId?: string; senderId?: string; username?: string }
  | { kind: 'session'; sessionId: string };

export type SessionSelectionSettings = {
  model?: string | null;
  effort?: ModelEffort | null;
  currentNode?: string | null;
};

export function buildSessionSelectionNotice(
  previous: SessionSelectionSettings,
  current: SessionSelectionSettings,
  actor?: SessionSettingsActor,
): QueueItem | undefined {
  const modelChanged = (previous.model || null) !== (current.model || null);
  const nodeChanged = (previous.currentNode || 'master') !== (current.currentNode || 'master');
  if (!modelChanged && !nodeChanged) return undefined;
  return {
    type: 'background',
    trigger: false,
    parts: buildTimestampedSystemMessageParts(formatFoxwarmSystemTag({
      kind: 'session-settings-changed',
      ...(modelChanged ? {
        oldModel: previous.model || 'default', newModel: current.model || 'default',
        oldEffort: previous.effort || 'default', newEffort: current.effort || 'default',
      } : {}),
      ...(nodeChanged ? { oldNode: previous.currentNode || 'master', newNode: current.currentNode || 'master' } : {}),
      ...(actor ? { actorKind: actor.kind } : {}),
      ...(actor?.kind === 'webui' ? { actorRole: actor.role, actorIdentityId: actor.identityId } : {}),
      ...(actor?.kind === 'channel' ? {
        actorChannelType: actor.channelType, actorChannelId: actor.channelId,
        actorSenderId: actor.senderId, actorUsername: actor.username,
      } : {}),
      ...(actor?.kind === 'session' ? { actorSessionId: actor.sessionId } : {}),
    })),
  };
}

/** Validate provenance at the internal RPC boundary, separately from mutable settings. */
export function normalizeSessionSettingsActor(value: unknown): SessionSettingsActor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Session settings actor.');
  const actor = value as Record<string, unknown>;
  const fields = actor.kind === 'webui' ? ['kind', 'role', 'identityId']
    : actor.kind === 'channel' ? ['kind', 'channelType', 'channelId', 'senderId', 'username']
    : actor.kind === 'session' ? ['kind', 'sessionId'] : [];
  if (!fields.length || Object.keys(actor).some(key => !fields.includes(key))
    || Object.values(actor).some(field => typeof field !== 'string' || !field || Buffer.byteLength(field, 'utf8') > 4096)
    || (actor.kind === 'webui' && actor.role !== 'admin' && actor.role !== 'webui')
    || (actor.kind === 'channel' && !actor.channelType)
    || (actor.kind === 'session' && !actor.sessionId)) {
    throw new Error('Invalid Session settings actor.');
  }
  return { ...actor } as SessionSettingsActor;
}

export function sessionSettingsActorFromChannel(source: {
  channelType?: string; platform: string; channelId?: string; senderId?: string; username?: string;
}): SessionSettingsActor | undefined {
  if (!source.channelType && !source.platform) return undefined;
  return {
    kind: 'channel', channelType: source.channelType || source.platform,
    ...(source.channelId ? { channelId: source.channelId } : {}),
    ...(source.senderId ? { senderId: source.senderId } : {}),
    ...(source.username ? { username: source.username } : {}),
  };
}
