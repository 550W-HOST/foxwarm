import fs from 'fs-extra';
import path from 'node:path';
import { SESSIONS_DIR } from '../config';
import { externalizeMessages, externalizeQueueItems } from '../imageBlobs';
import type { QueueItem, Session } from '../types';
import { getManagedSessionState, setManagedSessionState } from './managedState';
import { serializeSessionHistoryPayload, writeSessionHistoryAtomically } from './metadataStore';

/** Materialize queue/inbox images only when the observed arrays are still unchanged; otherwise fail for retry. */
export async function externalizeAuthoritativeSessionQueueImages(session: Session): Promise<boolean> {
  const queue = session.queue || [];
  const queueSnapshot = queue.slice();
  const queueResult = await externalizeQueueItems(queueSnapshot);
  const managed = getManagedSessionState(session);
  const managedInboxResult = managed
    ? await externalizeQueueItems(managed.pendingInbox)
    : { items: [] as QueueItem[], changed: false };

  let changed = false;
  if (queueResult.changed) {
    if (session.queue !== queue || !queueSnapshot.every((item, index) => queue[index] === item)) {
      throw new Error(`Session ${session.id} queue changed while image references were being materialized.`);
    }
    queue.splice(0, queueSnapshot.length, ...queueResult.items);
    changed = true;
  }
  if (managed && managedInboxResult.changed) {
    const currentManaged = getManagedSessionState(session);
    if (!currentManaged || currentManaged.leaseId !== managed.leaseId || currentManaged.revision !== managed.revision) {
      throw new Error(`Session ${session.id} managed inbox changed while image references were being materialized.`);
    }
    currentManaged.pendingInbox = managedInboxResult.items;
    setManagedSessionState(session, currentManaged);
    changed = true;
  }

  return changed;
}

export async function externalizeAuthoritativeSessionImages(session: Session): Promise<boolean> {
  let changed = await externalizeAuthoritativeSessionQueueImages(session);
  const history = session.history || [];
  const historySnapshot = history.slice();
  const historyResult = await externalizeMessages(historySnapshot);
  if (historyResult.changed) {
    if (session.history !== history || !historySnapshot.every((message, index) => history[index] === message)) {
      throw new Error(`Session ${session.id} history changed while image references were being materialized.`);
    }
    history.splice(0, historySnapshot.length, ...historyResult.messages);
    changed = true;
  }
  return changed;
}

export async function prepareAuthoritativeSessionState(session: Session): Promise<Record<string, any>> {
  await externalizeAuthoritativeSessionImages(session);
  if (session.historyVersion === undefined) session.historyVersion = 0;
  if (!session.meta) session.meta = { lastMessageTime: Date.now() };
  session.meta.messageCount = session.history.length;
  if (!Number.isSafeInteger(session.lastAppliedMailboxId) || (session.lastAppliedMailboxId || 0) < 0) {
    session.lastAppliedMailboxId = 0;
  }
  return serializeSessionHistoryPayload(session);
}

/** Worker-safe writer: writes only the authoritative per-session JSON, never sessions.json. */
export async function writeAuthoritativeSessionState(session: Session): Promise<void> {
  const payload = await prepareAuthoritativeSessionState(session);
  const historyFile = path.join(SESSIONS_DIR, `${session.id}.json`);
  await fs.ensureDir(path.dirname(historyFile));
  await writeSessionHistoryAtomically(session.id, payload);
}
