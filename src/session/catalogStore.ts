import { backup, DatabaseSync } from 'node:sqlite';
import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { CATALOG_DB_PATH, SESSIONS_DIR, SESSIONS_FILE, STATE_DIR } from '../config';
import { CURRENT_SESSION_STATE_VERSION, normalizeAndValidateSessionAuthorityPayload } from './stateValidation';
import { isQueueItem } from '../types';
import { getEffectiveSessionQueueLength } from '../sessionRuntimeState';
import { getLegacyBackupPath, getNumberedBackupPath } from '../utils/diskJsonData';

const SCHEMA_VERSION = 2;
const MIGRATION_EVIDENCE_PATH = `${SESSIONS_FILE}.pre-catalog-sqlite-v1.bak`;
const MAX_WAIT_ID_LENGTH = 128;
const MAX_WAIT_REASON_LENGTH = 500;
const MAX_WAIT_TARGETS = 64;
const MAX_WAIT_SESSION_ID_LENGTH = 512;
const MAX_WAIT_EXEC_ID_LENGTH = 256;
class FatalCatalogMigrationError extends Error {}

export interface SessionCatalogPageOptions {
  limit?: number;
  offset?: number;
  agent?: string;
  currentNode?: string;
  parentSessionId?: string | null;
  recoveryOnly?: boolean;
  after?: { lastMessageTime: number; sessionId: string };
}

export interface SessionAliasResolution {
  kind: 'missing' | 'exact' | 'alias' | 'ambiguous';
  sessionId?: string;
  sessionIds?: string[];
}

export interface SessionCatalogMigrationResult {
  migrated: boolean;
  source: string | null;
  rowCount: number;
  evidencePath: string | null;
}

export type SessionListOrderMode = 'default' | 'time' | 'flat-time';
export type SessionPresentationKey = Array<string | number>;
export interface SessionPresentationPage {
  rows: Record<string, any>[];
  hasMore: boolean;
  nextKey?: SessionPresentationKey;
}
export interface SessionChildrenPreview {
  parentSessionId: string;
  rows: Record<string, any>[];
  total: number;
  hasMore: boolean;
  nextKey?: SessionPresentationKey;
}

function sqliteString(value: unknown, field: string, sessionId: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Session "${sessionId}" has non-string ${field}.`);
  return value;
}

function sqliteBoolean(value: unknown, field: string, sessionId: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'boolean') throw new Error(`Session "${sessionId}" has non-boolean ${field}.`);
  return value ? 1 : 0;
}

function sqliteNumber(value: unknown, field: string, sessionId: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Session "${sessionId}" has invalid numeric ${field}.`);
  }
  return value;
}

function boundedStringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim().slice(0, maxLength);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
    if (result.length >= maxItems) break;
  }
  return result.length ? result : undefined;
}

function buildWaitPresentationProjection(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const wait = value as Record<string, any>;
  if (typeof wait.id !== 'string' || !wait.id.trim()) return undefined;
  const projection: Record<string, any> = { id: wait.id.trim().slice(0, MAX_WAIT_ID_LENGTH) };
  if (typeof wait.startedAt === 'number' && Number.isFinite(wait.startedAt)) projection.startedAt = wait.startedAt;
  if (typeof wait.reason === 'string' && wait.reason.trim()) projection.reason = wait.reason.trim().slice(0, MAX_WAIT_REASON_LENGTH);
  if (typeof wait.timeoutSeconds === 'number' && Number.isFinite(wait.timeoutSeconds) && wait.timeoutSeconds > 0) {
    projection.timeoutSeconds = wait.timeoutSeconds;
  }
  const waitExecIds = boundedStringArray(wait.waitExecIds, MAX_WAIT_TARGETS, MAX_WAIT_EXEC_ID_LENGTH);
  if (waitExecIds) projection.waitExecIds = waitExecIds;
  if (wait.waitAll && typeof wait.waitAll === 'object' && !Array.isArray(wait.waitAll)) {
    const sessions = boundedStringArray(wait.waitAll.sessions, MAX_WAIT_TARGETS, MAX_WAIT_SESSION_ID_LENGTH);
    const satisfiedSessions = boundedStringArray(wait.waitAll.satisfiedSessions, MAX_WAIT_TARGETS, MAX_WAIT_SESSION_ID_LENGTH);
    if (sessions) projection.waitAll = { sessions, ...(satisfiedSessions ? { satisfiedSessions } : {}) };
  }
  return projection;
}

export function buildSessionCatalogProjection(value: unknown): Record<string, any> {
  const rawSessionId = (value as any)?.id;
  if (typeof rawSessionId !== 'string' || !rawSessionId || rawSessionId.includes('\0') || rawSessionId.includes('\\')
    || path.isAbsolute(rawSessionId) || rawSessionId.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid session catalog ID "${String(rawSessionId)}".`);
  }
  const sessionId = rawSessionId;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Session "${sessionId}" metadata must be an object.`);
  }
  const metadata = value as Record<string, any>;
  if (metadata.aliases !== undefined
    && (!Array.isArray(metadata.aliases) || metadata.aliases.some((alias: unknown) => typeof alias !== 'string' || !alias))) {
    throw new Error(`Session "${sessionId}" has invalid aliases.`);
  }
  for (const [field, raw] of [['agent', metadata.agent], ['parentSessionId', metadata.parentSessionId], ['displayName', metadata.displayName], ['currentNode', metadata.currentNode], ['cwd', metadata.cwd], ['model', metadata.model], ['childModelDefault', metadata.childModelDefault]] as const) {
    sqliteString(raw, field, sessionId);
  }
  for (const [field, raw] of [['archived', metadata.archived], ['pinned', metadata.pinned], ['busy', metadata.busy], ['stopping', metadata.stopping], ['verbose', metadata.verbose]] as const) {
    sqliteBoolean(raw, field, sessionId);
  }
  for (const [field, raw] of [['sidebarOrder', metadata.sidebarOrder], ['vectorIndexPosition', metadata.vectorIndexPosition], ['compactThresholdTokens', metadata.compactThresholdTokens], ['busyStartedAt', metadata.busyStartedAt]] as const) {
    sqliteNumber(raw, field, sessionId);
  }
  if (metadata.meta !== undefined && (!metadata.meta || typeof metadata.meta !== 'object' || Array.isArray(metadata.meta))) {
    throw new Error(`Session "${sessionId}" has invalid meta.`);
  }
  if (metadata.stats !== undefined && (!metadata.stats || typeof metadata.stats !== 'object' || Array.isArray(metadata.stats))) {
    throw new Error(`Session "${sessionId}" has invalid stats.`);
  }
  if (metadata.queue !== undefined && !Array.isArray(metadata.queue)) throw new Error(`Session "${sessionId}" has invalid queue projection source.`);
  sqliteNumber(metadata.queueLength, 'queueLength', sessionId);
  sqliteNumber(metadata.managedPendingCount, 'managedPendingCount', sessionId);
  sqliteNumber(metadata.meta?.lastMessageTime, 'meta.lastMessageTime', sessionId);
  sqliteNumber(metadata.meta?.messageCount, 'meta.messageCount', sessionId);
  sqliteNumber(metadata.stats?.totalCachedTokens, 'stats.totalCachedTokens', sessionId);
  sqliteNumber(metadata.stats?.totalInputTokens, 'stats.totalInputTokens', sessionId);
  sqliteNumber(metadata.stats?.totalOutputTokens, 'stats.totalOutputTokens', sessionId);
  if (metadata.stats?.lastUsage !== undefined && metadata.stats.lastUsage !== null) {
    if (!metadata.stats.lastUsage || typeof metadata.stats.lastUsage !== 'object' || Array.isArray(metadata.stats.lastUsage)) {
      throw new Error(`Session "${sessionId}" has invalid stats.lastUsage.`);
    }
    for (const field of ['cachedTokens', 'inputTokens', 'reasoningTokens', 'outputTokens'] as const) {
      sqliteNumber(metadata.stats.lastUsage[field], `stats.lastUsage.${field}`, sessionId);
    }
  }
  const meta: Record<string, any> = {};
  for (const field of ['lastMessageTime', 'messageCount', 'lastChannel'] as const) {
    if (metadata.meta?.[field] !== undefined) meta[field] = structuredClone(metadata.meta[field]);
  }
  const waitPresentation = buildWaitPresentationProjection(metadata.meta?.wait);
  if (waitPresentation) meta.wait = waitPresentation;
  if (meta.lastChannel !== undefined) {
    if (!meta.lastChannel || typeof meta.lastChannel !== 'object' || Array.isArray(meta.lastChannel)) {
      throw new Error(`Session "${sessionId}" has invalid meta.lastChannel.`);
    }
    const channelId = typeof meta.lastChannel.channelId === 'string' ? meta.lastChannel.channelId
      : typeof meta.lastChannel.platform === 'string' ? meta.lastChannel.platform
        : typeof meta.lastChannel.channelType === 'string' ? meta.lastChannel.channelType : undefined;
    const channelUserId = typeof meta.lastChannel.channelUserId === 'string' ? meta.lastChannel.channelUserId
      : typeof meta.lastChannel.conversationId === 'string' ? meta.lastChannel.conversationId : undefined;
    if (!channelId || !channelUserId) throw new Error(`Session "${sessionId}" has invalid meta.lastChannel.`);
    meta.lastChannel = {
      channelId,
      channelUserId,
      ...(typeof meta.lastChannel.channelType === 'string' ? { channelType: meta.lastChannel.channelType }
        : typeof meta.lastChannel.platform === 'string' ? { channelType: meta.lastChannel.platform } : {}),
      ...(typeof meta.lastChannel.conversationId === 'string' ? { conversationId: meta.lastChannel.conversationId } : {}),
    };
  }
  const projection: Record<string, any> = {
    id: sessionId,
    agent: metadata.agent || 'main',
    aliases: structuredClone(metadata.aliases || []),
    busy: metadata.busy === true,
    queueLength: sqliteNumber(metadata.queueLength, 'queueLength', sessionId)
      ?? (Array.isArray(metadata.queue) ? getEffectiveSessionQueueLength(metadata as any) : 0),
    managedPendingCount: sqliteNumber(metadata.managedPendingCount, 'managedPendingCount', sessionId)
      ?? (Array.isArray(metadata.meta?.managedSession?.pendingInbox) ? metadata.meta.managedSession.pendingInbox.length : 0),
    currentNode: metadata.currentNode || 'master',
    ...(Object.keys(meta).length ? { meta } : {}),
  };
  for (const field of ['parentSessionId', 'displayName', 'cwd', 'model', 'childModelDefault', 'vectorIndexPosition'] as const) {
    if (metadata[field] !== undefined) projection[field] = structuredClone(metadata[field]);
  }
  if (metadata.stats !== undefined) {
    projection.stats = {
      ...Object.fromEntries(['totalCachedTokens', 'totalInputTokens', 'totalOutputTokens']
        .filter(field => metadata.stats[field] !== undefined).map(field => [field, metadata.stats[field]])),
      ...(metadata.stats.lastUsage === null ? { lastUsage: null } : metadata.stats.lastUsage ? {
        lastUsage: Object.fromEntries(['cachedTokens', 'inputTokens', 'reasoningTokens', 'outputTokens']
          .filter(field => metadata.stats.lastUsage[field] !== undefined).map(field => [field, metadata.stats.lastUsage[field]])),
      } : {}),
    };
  }
  for (const field of ['archived', 'pinned', 'stopping', 'verbose'] as const) {
    if (metadata[field] !== undefined) projection[field] = metadata[field];
  }
  for (const field of ['sidebarOrder', 'busyStartedAt', 'compactThresholdTokens'] as const) {
    if (metadata[field] !== undefined) projection[field] = metadata[field];
  }
  return projection;
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE catalog_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE session_catalog (
      session_id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      parent_reference TEXT,
      parent_session_id TEXT,
      display_name TEXT,
      archived INTEGER NOT NULL CHECK(archived IN (0,1)),
      pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
      sidebar_order REAL,
      last_message_time REAL NOT NULL,
      message_count INTEGER NOT NULL,
      busy INTEGER NOT NULL CHECK(busy IN (0,1)),
      queue_length INTEGER NOT NULL,
      managed_pending_count INTEGER NOT NULL,
      current_node TEXT NOT NULL,
      cwd TEXT,
      vector_index_position INTEGER,
      cached_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      recent_rank REAL GENERATED ALWAYS AS(-last_message_time) STORED,
      pinned_rank INTEGER GENERATED ALWAYS AS(CASE WHEN pinned=1 THEN 0 ELSE 1 END) VIRTUAL,
      sidebar_order_missing INTEGER GENERATED ALWAYS AS(CASE WHEN sidebar_order IS NULL THEN 1 ELSE 0 END) VIRTUAL,
      sidebar_order_value REAL GENERATED ALWAYS AS(COALESCE(sidebar_order,0)) VIRTUAL,
      presentation_root INTEGER GENERATED ALWAYS AS(CASE WHEN pinned=1 OR parent_session_id IS NULL THEN 1 ELSE 0 END) VIRTUAL
    ) STRICT;
    CREATE TABLE session_alias (
      alias TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES session_catalog(session_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(alias, session_id)
    ) STRICT;
    CREATE TABLE catalog_count (singleton INTEGER PRIMARY KEY CHECK(singleton=1), session_count INTEGER NOT NULL,
      busy_count INTEGER NOT NULL,queued_count INTEGER NOT NULL,managed_count INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL) STRICT;
    INSERT INTO catalog_count(singleton,session_count,busy_count,queued_count,managed_count,cached_tokens,input_tokens,output_tokens)
      VALUES(1,0,0,0,0,0,0,0);
    CREATE TABLE catalog_agent_count (agent TEXT PRIMARY KEY, session_count INTEGER NOT NULL) STRICT;
    CREATE TABLE catalog_parent_count (parent_key TEXT PRIMARY KEY, session_count INTEGER NOT NULL, unpinned_session_count INTEGER NOT NULL) STRICT;
    CREATE TABLE catalog_parent_agent_count (parent_key TEXT NOT NULL,agent TEXT NOT NULL,session_count INTEGER NOT NULL,
      PRIMARY KEY(parent_key,agent)) STRICT;
    CREATE TRIGGER session_catalog_count_insert AFTER INSERT ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count+1,busy_count=busy_count+new.busy,
        queued_count=queued_count+CASE WHEN new.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count+CASE WHEN new.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens+new.cached_tokens,input_tokens=input_tokens+new.input_tokens,
        output_tokens=output_tokens+new.output_tokens WHERE singleton=1;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      INSERT INTO catalog_parent_count(parent_key,session_count,unpinned_session_count)
        VALUES(COALESCE(new.parent_session_id,''),1,CASE WHEN new.pinned=0 THEN 1 ELSE 0 END)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1,
          unpinned_session_count=unpinned_session_count+CASE WHEN new.pinned=0 THEN 1 ELSE 0 END;
      INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count) VALUES(COALESCE(new.parent_session_id,''),new.agent,1)
        ON CONFLICT(parent_key,agent) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_count_delete AFTER DELETE ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count-1,busy_count=busy_count-old.busy,
        queued_count=queued_count-CASE WHEN old.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count-CASE WHEN old.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens-old.cached_tokens,input_tokens=input_tokens-old.input_tokens,
        output_tokens=output_tokens-old.output_tokens WHERE singleton=1;
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      UPDATE catalog_parent_count SET session_count=session_count-1 WHERE parent_key=COALESCE(old.parent_session_id,'');
      UPDATE catalog_parent_count SET unpinned_session_count=unpinned_session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND old.pinned=0;
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      UPDATE catalog_parent_agent_count SET session_count=session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent;
      DELETE FROM catalog_parent_agent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent AND session_count=0;
    END;
    CREATE TRIGGER session_catalog_count_update AFTER UPDATE OF agent,parent_session_id,pinned ON session_catalog
    WHEN old.agent<>new.agent OR old.parent_session_id IS NOT new.parent_session_id OR old.pinned<>new.pinned BEGIN
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      UPDATE catalog_parent_count SET session_count=session_count-1 WHERE parent_key=COALESCE(old.parent_session_id,'');
      UPDATE catalog_parent_count SET unpinned_session_count=unpinned_session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND old.pinned=0;
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      INSERT INTO catalog_parent_count(parent_key,session_count,unpinned_session_count)
        VALUES(COALESCE(new.parent_session_id,''),1,CASE WHEN new.pinned=0 THEN 1 ELSE 0 END)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1,
          unpinned_session_count=unpinned_session_count+CASE WHEN new.pinned=0 THEN 1 ELSE 0 END;
      UPDATE catalog_parent_agent_count SET session_count=session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent;
      DELETE FROM catalog_parent_agent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent AND session_count=0;
      INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count) VALUES(COALESCE(new.parent_session_id,''),new.agent,1)
        ON CONFLICT(parent_key,agent) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_summary_update AFTER UPDATE OF busy,queue_length,managed_pending_count,cached_tokens,input_tokens,output_tokens ON session_catalog BEGIN
      UPDATE catalog_count SET busy_count=busy_count+new.busy-old.busy,
        queued_count=queued_count+CASE WHEN new.queue_length>0 THEN 1 ELSE 0 END-CASE WHEN old.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count+CASE WHEN new.managed_pending_count>0 THEN 1 ELSE 0 END-CASE WHEN old.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens+new.cached_tokens-old.cached_tokens,
        input_tokens=input_tokens+new.input_tokens-old.input_tokens,
        output_tokens=output_tokens+new.output_tokens-old.output_tokens WHERE singleton=1;
    END;
    CREATE INDEX idx_session_catalog_recent ON session_catalog(recent_rank, session_id);
    CREATE INDEX idx_session_catalog_agent_recent ON session_catalog(agent, recent_rank, session_id);
    CREATE INDEX idx_session_catalog_parent_recent ON session_catalog(parent_session_id, recent_rank, session_id);
    CREATE INDEX idx_session_catalog_parent_reference ON session_catalog(parent_reference, session_id);
    CREATE INDEX idx_session_catalog_current_node_recent ON session_catalog(current_node, recent_rank, session_id);
    CREATE INDEX idx_session_catalog_recovery_busy ON session_catalog(recent_rank, session_id) WHERE busy=1;
    CREATE INDEX idx_session_catalog_recovery_queued ON session_catalog(recent_rank, session_id) WHERE queue_length>0;
    CREATE INDEX idx_session_catalog_recovery_managed ON session_catalog(recent_rank, session_id) WHERE managed_pending_count>0;
    CREATE INDEX idx_session_alias_session ON session_alias(session_id, ordinal);
    CREATE INDEX idx_session_catalog_root_default ON session_catalog(presentation_root,pinned_rank,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_root_time ON session_catalog(presentation_root,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_default ON session_catalog(parent_session_id,pinned,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_time ON session_catalog(parent_session_id,pinned,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_agent_root_time ON session_catalog(agent,presentation_root,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_agent_time ON session_catalog(agent,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_default ON session_catalog(parent_session_id,agent,pinned,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_time ON session_catalog(parent_session_id,agent,pinned,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_architecture ON session_catalog(parent_session_id,agent,archived,recent_rank,session_id);
  `);
  db.prepare('INSERT INTO catalog_metadata(key,value) VALUES(?,?)').run('schema_version', String(SCHEMA_VERSION));
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
}

function typedRow(metadata: Record<string, any>) {
  metadata = buildSessionCatalogProjection(metadata);
  const id = metadata.id as string;
  return {
    id,
    agent: sqliteString(metadata.agent, 'agent', id) || 'main',
    parent: sqliteString(metadata.parentSessionId, 'parentSessionId', id),
    display: sqliteString(metadata.displayName, 'displayName', id),
    archived: sqliteBoolean(metadata.archived, 'archived', id),
    pinned: sqliteBoolean(metadata.pinned, 'pinned', id),
    sidebarOrder: sqliteNumber(metadata.sidebarOrder, 'sidebarOrder', id),
    lastTime: sqliteNumber(metadata.meta?.lastMessageTime, 'meta.lastMessageTime', id) || 0,
    messageCount: sqliteNumber(metadata.meta?.messageCount, 'meta.messageCount', id) || 0,
    busy: sqliteBoolean(metadata.busy, 'busy', id),
    queueLength: sqliteNumber(metadata.queueLength, 'queueLength', id) ?? (Array.isArray(metadata.queue) ? metadata.queue.length : 0),
    managedPendingCount: sqliteNumber(metadata.managedPendingCount, 'managedPendingCount', id) ?? (Array.isArray(metadata.meta?.managedSession?.pendingInbox) ? metadata.meta.managedSession.pendingInbox.length : 0),
    currentNode: sqliteString(metadata.currentNode, 'currentNode', id) || 'master',
    cwd: sqliteString(metadata.cwd, 'cwd', id),
    vectorIndexPosition: sqliteNumber(metadata.vectorIndexPosition, 'vectorIndexPosition', id),
    cachedTokens: sqliteNumber(metadata.stats?.totalCachedTokens, 'stats.totalCachedTokens', id) || 0,
    inputTokens: sqliteNumber(metadata.stats?.totalInputTokens, 'stats.totalInputTokens', id) || 0,
    outputTokens: sqliteNumber(metadata.stats?.totalOutputTokens, 'stats.totalOutputTokens', id) || 0,
    json: JSON.stringify(metadata),
    aliases: (metadata.aliases || []) as string[],
  };
}

function insertMetadata(db: DatabaseSync, metadataValue: Record<string, any>): void {
  const row = typedRow(metadataValue);
  db.prepare(`INSERT INTO session_catalog(
    session_id,agent,parent_reference,parent_session_id,display_name,archived,pinned,sidebar_order,last_message_time,
    message_count,busy,queue_length,managed_pending_count,current_node,cwd,vector_index_position,cached_tokens,input_tokens,output_tokens,metadata_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(session_id) DO UPDATE SET
    agent=excluded.agent,parent_reference=excluded.parent_reference,parent_session_id=excluded.parent_session_id,display_name=excluded.display_name,
    archived=excluded.archived,pinned=excluded.pinned,sidebar_order=excluded.sidebar_order,
    last_message_time=excluded.last_message_time,message_count=excluded.message_count,busy=excluded.busy,
    queue_length=excluded.queue_length,managed_pending_count=excluded.managed_pending_count,current_node=excluded.current_node,cwd=excluded.cwd,
    vector_index_position=excluded.vector_index_position,cached_tokens=excluded.cached_tokens,input_tokens=excluded.input_tokens,
    output_tokens=excluded.output_tokens,metadata_json=excluded.metadata_json`).run(
    row.id,row.agent,row.parent,row.parent,row.display,row.archived,row.pinned,row.sidebarOrder,row.lastTime,
    row.messageCount,row.busy,row.queueLength,row.managedPendingCount,row.currentNode,row.cwd,row.vectorIndexPosition,
    row.cachedTokens,row.inputTokens,row.outputTokens,row.json,
  );
  db.prepare('DELETE FROM session_alias WHERE session_id=?').run(row.id);
  const aliasInsert = db.prepare('INSERT INTO session_alias(alias,session_id,ordinal) VALUES(?,?,?)');
  row.aliases.forEach((alias, ordinal) => aliasInsert.run(alias, row.id, ordinal));
}

function normalizeParentReferences(db: DatabaseSync, references?: Set<string>): void {
  if (references && references.size === 0) return;
  const referenceValues = references ? [...references] : [];
  const rows = (references
    ? db.prepare(`SELECT session_id,parent_reference,parent_session_id FROM session_catalog
        WHERE parent_reference IN (${referenceValues.map(() => '?').join(',')})`).all(...referenceValues)
    : db.prepare('SELECT session_id,parent_reference,parent_session_id FROM session_catalog').all()) as Array<{
      session_id: string; parent_reference: string | null; parent_session_id: string | null;
    }>;
  const exact = db.prepare('SELECT session_id FROM session_catalog WHERE session_id=?');
  const aliases = db.prepare('SELECT session_id FROM session_alias WHERE alias=? ORDER BY session_id LIMIT 2');
  const update = db.prepare('UPDATE session_catalog SET parent_session_id=? WHERE session_id=?');
  for (const row of rows) {
    let canonical: string | null = null;
    if (row.parent_reference) {
      const exactRow = exact.get(row.parent_reference) as { session_id: string } | undefined;
      if (exactRow) canonical = exactRow.session_id;
      else {
        const matches = aliases.all(row.parent_reference) as Array<{ session_id: string }>;
        if (matches.length === 1) canonical = matches[0].session_id;
      }
    }
    if (canonical === row.session_id) canonical = null;
    if (canonical !== row.parent_session_id) update.run(canonical, row.session_id);
  }
}

type CatalogProjectionSqlRow = {
  metadata_json: string; busy: number; queue_length: number; managed_pending_count: number;
};
function projectionFromSqlRow(row: CatalogProjectionSqlRow): Record<string, any> {
  return {
    ...JSON.parse(row.metadata_json), busy: row.busy === 1,
    queueLength: row.queue_length, managedPendingCount: row.managed_pending_count,
  };
}

function presentationColumns(mode: SessionListOrderMode, child = false): string[] {
  if (child) return mode === 'default'
    ? ['archived','sidebar_order_missing','sidebar_order_value','recent_rank','session_id']
    : ['archived','recent_rank','session_id'];
  return mode === 'default'
    ? ['pinned_rank','archived','sidebar_order_missing','sidebar_order_value','recent_rank','session_id']
    : ['pinned_rank','archived','recent_rank','session_id'];
}
function presentationKey(row: any, mode: SessionListOrderMode, child = false): SessionPresentationKey {
  if (child) return mode === 'default'
    ? [row.archived,row.sidebar_order_missing,row.sidebar_order_value,row.recent_rank,row.session_id]
    : [row.archived,row.recent_rank,row.session_id];
  return mode === 'default'
    ? [row.pinned_rank,row.archived,row.sidebar_order_missing,row.sidebar_order_value,row.recent_rank,row.session_id]
    : [row.pinned_rank,row.archived,row.recent_rank,row.session_id];
}

function fsyncPath(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function candidatePaths(): string[] {
  return [
    SESSIONS_FILE,
    ...Array.from({ length: 5 }, (_, index) => getNumberedBackupPath(SESSIONS_FILE, index + 1)),
    getLegacyBackupPath(SESSIONS_FILE),
  ];
}

async function hasAuthorityFiles(dir: string): Promise<boolean> {
  if (!await fs.pathExists(dir)) return false;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory() && await hasAuthorityFiles(entryPath)) return true;
    if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.frontier.json')) return true;
  }
  return false;
}

function buildLegacyAuthorityUpgrade(
  raw: Record<string, any>,
  catalogRow: Record<string, any>,
  sessionId: string,
  normalized?: Record<string, any>,
): Record<string, any> {
  const upgrade = normalized || normalizeAndValidateSessionAuthorityPayload(raw, `Authority file for "${sessionId}"`);
  if (upgrade.sessionStateVersion !== undefined) return upgrade;
  const transferFields = [
    'history', 'persistentMemorySnapshot', 'queue', 'parentSessionId', 'promptCacheKey', 'systemPromptFiles',
    'indexingState', 'busy', 'busyStartedAt', 'stopping', 'currentNode', 'cwd', 'model', 'childModelDefault',
    'agent', 'verbose', 'aliases', 'historyVersion', 'nextMessageSeq', 'nextBlockId', 'contextFrontier',
    'goalState', 'compactThresholdTokens', 'lastAppliedMailboxId',
  ] as const;
  for (const field of transferFields) {
    if (!Object.prototype.hasOwnProperty.call(raw, field) && catalogRow[field] !== undefined) upgrade[field] = structuredClone(catalogRow[field]);
  }
  upgrade.history = upgrade.history || [];
  if (!Object.prototype.hasOwnProperty.call(raw, 'queue') && Array.isArray(upgrade.queue) && upgrade.queue.some(item => !isQueueItem(item))) {
    throw new Error(`Legacy catalog queue for "${sessionId}" cannot be transferred because it contains an invalid QueueItem.`);
  }
  upgrade.queue = Array.isArray(upgrade.queue) ? upgrade.queue.filter(isQueueItem) : [];
  for (const field of ['stats', 'meta'] as const) {
    const catalogValue = catalogRow[field];
    if (upgrade[field] === undefined && catalogValue !== undefined) upgrade[field] = structuredClone(catalogValue);
    else if (upgrade[field] && catalogValue && typeof upgrade[field] === 'object' && typeof catalogValue === 'object') {
      upgrade[field] = { ...structuredClone(catalogValue), ...upgrade[field] };
    }
  }
  if (upgrade.vectorIndexPosition === undefined && catalogRow.vectorIndexPosition !== undefined) {
    upgrade.vectorIndexPosition = catalogRow.vectorIndexPosition;
  }
  if (upgrade.meta && typeof upgrade.meta === 'object') delete upgrade.meta.lastChannel;
  upgrade.sessionStateVersion = CURRENT_SESSION_STATE_VERSION;
  return normalizeAndValidateSessionAuthorityPayload(upgrade, `Upgraded authority file for "${sessionId}"`);
}

interface ReconciledMigrationRow {
  sessionId: string;
  catalogProjection: Record<string, any>;
  authorityStage?: { targetPath: string; stagedPath: string };
}

function buildReconciledMigrationProjection(
  sessionId: string,
  authority: Record<string, any>,
  legacyCatalogRow: Record<string, any>,
): Record<string, any> {
  const catalogOwned = buildSessionCatalogProjection(legacyCatalogRow);
  const source: Record<string, any> = { ...authority };
  source.id = sessionId;
  for (const field of ['agent', 'aliases', 'parentSessionId', 'displayName', 'archived', 'pinned', 'sidebarOrder'] as const) {
    delete source[field];
    if (Object.prototype.hasOwnProperty.call(catalogOwned, field)) source[field] = structuredClone(catalogOwned[field]);
  }
  const authorityMeta = source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta)
    ? structuredClone(source.meta) : {};
  delete authorityMeta.lastChannel;
  if (catalogOwned.meta?.lastChannel !== undefined) authorityMeta.lastChannel = structuredClone(catalogOwned.meta.lastChannel);
  source.meta = authorityMeta;
  return buildSessionCatalogProjection(source);
}

function stageJsonDurably(filePath: string, value: unknown): { targetPath: string; stagedPath: string } {
  const tempPath = `${filePath}.catalog-upgrade-v1.tmp`;
  fs.removeSync(tempPath);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fsyncPath(tempPath);
    return { targetPath: filePath, stagedPath: tempPath };
  } catch (error) {
    fs.removeSync(tempPath);
    throw error;
  }
}

async function readMigrationCandidate(): Promise<{
  source: string | null; rows: ReconciledMigrationRow[]; channelAttachments?: unknown;
}> {
  const failures: string[] = [];
  let candidateSeen = false;
  for (const source of candidatePaths()) {
    if (!await fs.pathExists(source)) continue;
    candidateSeen = true;
    const rows: ReconciledMigrationRow[] = [];
    try {
      const raw = await fs.readJson(source);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('root is not an object');
      const sessions = raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)
        ? raw.sessions
        : Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'channelAttachments'));
      if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) throw new Error('missing sessions object');
      if (raw.channelAttachments !== undefined
        && (!raw.channelAttachments || typeof raw.channelAttachments !== 'object' || Array.isArray(raw.channelAttachments))) {
        throw new Error('invalid legacy channelAttachments');
      }
      for (const [id, metadata] of Object.entries(sessions)) {
        const projection = buildSessionCatalogProjection(metadata);
        if (projection.id !== id) throw new Error(`Session catalog key "${id}" does not match row id.`);
        const authorityPath = path.join(SESSIONS_DIR, `${id}.json`);
        fs.removeSync(`${authorityPath}.catalog-upgrade-v1.tmp`);
        if (!await fs.pathExists(authorityPath)) throw new FatalCatalogMigrationError(`Live catalog row "${id}" is missing its authority file.`);
        let authority: any;
        try { authority = await fs.readJson(authorityPath); }
        catch (error) { throw new FatalCatalogMigrationError(`Authority file for "${id}" is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
        if (!authority || typeof authority !== 'object' || Array.isArray(authority) || (authority.id !== undefined && authority.id !== id)) {
          throw new FatalCatalogMigrationError(`Authority file for "${id}" has an invalid identity payload.`);
        }
        try {
          const normalized = normalizeAndValidateSessionAuthorityPayload(authority, `Authority file for "${id}"`);
          const legacyAuthority = normalized.sessionStateVersion === undefined;
          const currentAuthority = legacyAuthority
            ? buildLegacyAuthorityUpgrade(authority, metadata, id, normalized)
            : normalized;
          const catalogProjection = buildReconciledMigrationProjection(id, currentAuthority, metadata);
          const authorityStage = legacyAuthority
            ? stageJsonDurably(authorityPath, currentAuthority)
            : undefined;
          rows.push({ sessionId: id, catalogProjection, authorityStage });
        } catch (error) {
          throw new FatalCatalogMigrationError(error instanceof Error ? error.message : String(error));
        }
      }
      return { source, rows, channelAttachments: raw.channelAttachments };
    } catch (error) {
      for (const row of rows) if (row.authorityStage) fs.removeSync(row.authorityStage.stagedPath);
      if (error instanceof FatalCatalogMigrationError) throw error;
      failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!candidateSeen && !await hasAuthorityFiles(SESSIONS_DIR)) return { source: null, rows: [] };
  throw new Error(`No valid sessions.json migration candidate. ${failures.join('; ') || 'No candidates exist.'}`);
}

async function preserveMigrationEvidence(source: string): Promise<void> {
  const sourceBytes = await fs.readFile(source);
  if (await fs.pathExists(MIGRATION_EVIDENCE_PATH)) {
    const evidenceBytes = await fs.readFile(MIGRATION_EVIDENCE_PATH);
    if (!sourceBytes.equals(evidenceBytes)) throw new Error(`Existing migration evidence differs: ${MIGRATION_EVIDENCE_PATH}`);
    return;
  }
  await fs.writeFile(MIGRATION_EVIDENCE_PATH, sourceBytes, { flag: 'wx' });
  fsyncPath(MIGRATION_EVIDENCE_PATH);
  fsyncPath(path.dirname(MIGRATION_EVIDENCE_PATH));
}

function migrateSchemaV1ToV2(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE session_catalog ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_catalog ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_catalog ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE session_catalog ADD COLUMN pinned_rank INTEGER GENERATED ALWAYS AS(CASE WHEN pinned=1 THEN 0 ELSE 1 END) VIRTUAL;
    ALTER TABLE session_catalog ADD COLUMN sidebar_order_missing INTEGER GENERATED ALWAYS AS(CASE WHEN sidebar_order IS NULL THEN 1 ELSE 0 END) VIRTUAL;
    ALTER TABLE session_catalog ADD COLUMN sidebar_order_value REAL GENERATED ALWAYS AS(COALESCE(sidebar_order,0)) VIRTUAL;
    ALTER TABLE session_catalog ADD COLUMN presentation_root INTEGER GENERATED ALWAYS AS(CASE WHEN pinned=1 OR parent_session_id IS NULL THEN 1 ELSE 0 END) VIRTUAL;
    ALTER TABLE catalog_parent_count ADD COLUMN unpinned_session_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN busy_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN queued_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN managed_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE catalog_count ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE catalog_parent_agent_count (parent_key TEXT NOT NULL,agent TEXT NOT NULL,session_count INTEGER NOT NULL,
      PRIMARY KEY(parent_key,agent)) STRICT;
    UPDATE session_catalog SET
      cached_tokens=CAST(COALESCE(json_extract(metadata_json,'$.stats.totalCachedTokens'),0) AS INTEGER),
      input_tokens=CAST(COALESCE(json_extract(metadata_json,'$.stats.totalInputTokens'),0) AS INTEGER),
      output_tokens=CAST(COALESCE(json_extract(metadata_json,'$.stats.totalOutputTokens'),0) AS INTEGER);
    UPDATE catalog_parent_count SET unpinned_session_count=(SELECT count(*) FROM session_catalog
      WHERE COALESCE(parent_session_id,'')=catalog_parent_count.parent_key AND pinned=0);
    INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count)
      SELECT COALESCE(parent_session_id,''),agent,count(*) FROM session_catalog GROUP BY COALESCE(parent_session_id,''),agent;
    UPDATE catalog_count SET
      busy_count=(SELECT COALESCE(sum(busy),0) FROM session_catalog),
      queued_count=(SELECT count(*) FROM session_catalog WHERE queue_length>0),
      managed_count=(SELECT count(*) FROM session_catalog WHERE managed_pending_count>0),
      cached_tokens=(SELECT COALESCE(sum(cached_tokens),0) FROM session_catalog),
      input_tokens=(SELECT COALESCE(sum(input_tokens),0) FROM session_catalog),
      output_tokens=(SELECT COALESCE(sum(output_tokens),0) FROM session_catalog) WHERE singleton=1;
    DROP TRIGGER session_catalog_count_insert;
    DROP TRIGGER session_catalog_count_delete;
    DROP TRIGGER session_catalog_count_update;
    CREATE TRIGGER session_catalog_count_insert AFTER INSERT ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count+1,busy_count=busy_count+new.busy,
        queued_count=queued_count+CASE WHEN new.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count+CASE WHEN new.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens+new.cached_tokens,input_tokens=input_tokens+new.input_tokens,
        output_tokens=output_tokens+new.output_tokens WHERE singleton=1;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      INSERT INTO catalog_parent_count(parent_key,session_count,unpinned_session_count)
        VALUES(COALESCE(new.parent_session_id,''),1,CASE WHEN new.pinned=0 THEN 1 ELSE 0 END)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1,
          unpinned_session_count=unpinned_session_count+CASE WHEN new.pinned=0 THEN 1 ELSE 0 END;
      INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count) VALUES(COALESCE(new.parent_session_id,''),new.agent,1)
        ON CONFLICT(parent_key,agent) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_count_delete AFTER DELETE ON session_catalog BEGIN
      UPDATE catalog_count SET session_count=session_count-1,busy_count=busy_count-old.busy,
        queued_count=queued_count-CASE WHEN old.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count-CASE WHEN old.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens-old.cached_tokens,input_tokens=input_tokens-old.input_tokens,
        output_tokens=output_tokens-old.output_tokens WHERE singleton=1;
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      UPDATE catalog_parent_count SET session_count=session_count-1,
        unpinned_session_count=unpinned_session_count-CASE WHEN old.pinned=0 THEN 1 ELSE 0 END
        WHERE parent_key=COALESCE(old.parent_session_id,'');
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      UPDATE catalog_parent_agent_count SET session_count=session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent;
      DELETE FROM catalog_parent_agent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent AND session_count=0;
    END;
    CREATE TRIGGER session_catalog_count_update AFTER UPDATE OF agent,parent_session_id,pinned ON session_catalog
    WHEN old.agent<>new.agent OR old.parent_session_id IS NOT new.parent_session_id OR old.pinned<>new.pinned BEGIN
      UPDATE catalog_agent_count SET session_count=session_count-1 WHERE agent=old.agent;
      DELETE FROM catalog_agent_count WHERE agent=old.agent AND session_count=0;
      INSERT INTO catalog_agent_count(agent,session_count) VALUES(new.agent,1)
        ON CONFLICT(agent) DO UPDATE SET session_count=session_count+1;
      UPDATE catalog_parent_count SET session_count=session_count-1,
        unpinned_session_count=unpinned_session_count-CASE WHEN old.pinned=0 THEN 1 ELSE 0 END
        WHERE parent_key=COALESCE(old.parent_session_id,'');
      DELETE FROM catalog_parent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND session_count=0;
      INSERT INTO catalog_parent_count(parent_key,session_count,unpinned_session_count)
        VALUES(COALESCE(new.parent_session_id,''),1,CASE WHEN new.pinned=0 THEN 1 ELSE 0 END)
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1,
          unpinned_session_count=unpinned_session_count+CASE WHEN new.pinned=0 THEN 1 ELSE 0 END;
      UPDATE catalog_parent_agent_count SET session_count=session_count-1
        WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent;
      DELETE FROM catalog_parent_agent_count WHERE parent_key=COALESCE(old.parent_session_id,'') AND agent=old.agent AND session_count=0;
      INSERT INTO catalog_parent_agent_count(parent_key,agent,session_count) VALUES(COALESCE(new.parent_session_id,''),new.agent,1)
        ON CONFLICT(parent_key,agent) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER session_catalog_summary_update AFTER UPDATE OF busy,queue_length,managed_pending_count,cached_tokens,input_tokens,output_tokens ON session_catalog BEGIN
      UPDATE catalog_count SET busy_count=busy_count+new.busy-old.busy,
        queued_count=queued_count+CASE WHEN new.queue_length>0 THEN 1 ELSE 0 END-CASE WHEN old.queue_length>0 THEN 1 ELSE 0 END,
        managed_count=managed_count+CASE WHEN new.managed_pending_count>0 THEN 1 ELSE 0 END-CASE WHEN old.managed_pending_count>0 THEN 1 ELSE 0 END,
        cached_tokens=cached_tokens+new.cached_tokens-old.cached_tokens,
        input_tokens=input_tokens+new.input_tokens-old.input_tokens,
        output_tokens=output_tokens+new.output_tokens-old.output_tokens WHERE singleton=1;
    END;
    CREATE INDEX idx_session_catalog_root_default ON session_catalog(presentation_root,pinned_rank,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_root_time ON session_catalog(presentation_root,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_default ON session_catalog(parent_session_id,pinned,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_time ON session_catalog(parent_session_id,pinned,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_agent_root_time ON session_catalog(agent,presentation_root,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_agent_time ON session_catalog(agent,pinned_rank,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_default ON session_catalog(parent_session_id,agent,pinned,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_time ON session_catalog(parent_session_id,agent,pinned,archived,recent_rank,session_id);
    CREATE INDEX idx_session_catalog_parent_agent_architecture ON session_catalog(parent_session_id,agent,archived,recent_rank,session_id);
    UPDATE catalog_metadata SET value='2' WHERE key='schema_version';
    PRAGMA user_version=2;
    COMMIT;`);
}

export class SessionCatalogStore {
  private db: DatabaseSync | null = null;
  private presentationRevision = 1;
  private readonly presentationInstance = randomUUID();
  constructor(readonly filePath = CATALOG_DB_PATH) {}

  exists(): boolean { return fs.existsSync(this.filePath); }

  initializeEmpty(): void {
    if (this.exists()) throw new Error(`Session catalog already exists: ${this.filePath}`);
    fs.ensureDirSync(path.dirname(this.filePath));
    const db = new DatabaseSync(this.filePath);
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      createSchema(db);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); fs.removeSync(this.filePath); throw error; }
    db.close();
    fsyncPath(this.filePath);
    fsyncPath(path.dirname(this.filePath));
    this.open();
  }

  async initialize(): Promise<SessionCatalogMigrationResult> {
    await fs.ensureDir(path.dirname(this.filePath));
    if (!this.exists()) {
      if (this.filePath !== CATALOG_DB_PATH) throw new Error('Test catalog stores must be created explicitly with replaceAll().');
      const candidate = await readMigrationCandidate();
      const tempPath = `${this.filePath}.migrating-${process.pid}-${Date.now()}`;
      let tempDb: DatabaseSync | null = null;
      try {
        tempDb = new DatabaseSync(tempPath);
        tempDb.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
        createSchema(tempDb);
        for (const row of candidate.rows) insertMetadata(tempDb, row.catalogProjection);
        normalizeParentReferences(tempDb);
        tempDb.exec('COMMIT');
        const integrity = tempDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        if (integrity.integrity_check !== 'ok') throw new Error(`Catalog integrity check failed: ${integrity.integrity_check}`);
        tempDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        tempDb.close();
        tempDb = null;
        fsyncPath(tempPath);
        if (candidate.source) await preserveMigrationEvidence(candidate.source);
        for (const row of candidate.rows) {
          if (!row.authorityStage) continue;
          fs.renameSync(row.authorityStage.stagedPath, row.authorityStage.targetPath);
          fsyncPath(path.dirname(row.authorityStage.targetPath));
        }
        await fs.rename(tempPath, this.filePath);
        fsyncPath(path.dirname(this.filePath));
        for (const legacyPath of candidatePaths()) await fs.remove(legacyPath);
        fsyncPath(STATE_DIR);
        this.open();
        return { migrated: true, source: candidate.source, rowCount: candidate.rows.length, evidencePath: candidate.source ? MIGRATION_EVIDENCE_PATH : null };
      } catch (error) {
        try { tempDb?.close(); } catch {}
        for (const row of candidate.rows) if (row.authorityStage) await fs.remove(row.authorityStage.stagedPath);
        await fs.remove(tempPath);
        throw error;
      }
    }
    this.open();
    return { migrated: false, source: null, rowCount: this.count(), evidencePath: null };
  }

  open(): void {
    if (this.db) return;
    const db = new DatabaseSync(this.filePath);
    try {
      let version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version === 1) { migrateSchemaV1ToV2(db); version = 2; }
      if (version !== SCHEMA_VERSION) throw new Error(`Unsupported session catalog schema version ${version}.`);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
      this.db = db;
    } catch (error) { db.close(); throw error; }
  }

  close(): void { this.db?.close(); this.db = null; }
  private database(): DatabaseSync {
    if (!this.db && this.exists()) this.open();
    if (!this.db) throw new Error('Session catalog is not initialized.');
    return this.db;
  }
  getPresentationRevision(): string { return `${this.presentationInstance}:${this.presentationRevision}`; }

  getMany(sessionIds: readonly string[]): Record<string, any>[] {
    const ids = [...new Set(sessionIds)].slice(0, 200);
    if (!ids.length) return [];
    const rows = this.database().prepare(`SELECT metadata_json,busy,queue_length,managed_pending_count
      FROM session_catalog WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as CatalogProjectionSqlRow[];
    const byId = new Map(rows.map(row => { const value = projectionFromSqlRow(row); return [value.id, value]; }));
    return ids.flatMap(id => { const value = byId.get(id); return value ? [value] : []; });
  }

  getPresentationScopes(sessionIds: readonly string[]): Record<string, { parentSessionId: string | null; parentAgent: string | null; pinned: boolean; agent: string }> {
    const ids = [...new Set(sessionIds)].slice(0, 200); if (!ids.length) return {};
    const rows = this.database().prepare(`SELECT c.session_id,c.parent_session_id,parent.agent parent_agent,c.pinned,c.agent
      FROM session_catalog c LEFT JOIN session_catalog parent ON parent.session_id=c.parent_session_id
      WHERE c.session_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ session_id: string; parent_session_id: string | null; parent_agent: string | null; pinned: number; agent: string }>;
    return Object.fromEntries(rows.map(row => [row.session_id, { parentSessionId: row.parent_session_id,
      parentAgent: row.parent_agent, pinned: row.pinned === 1, agent: row.agent }]));
  }

  listPresentationPage(options: {
    mode: SessionListOrderMode; limit: number; after?: SessionPresentationKey; roots?: boolean;
    parentSessionId?: string; agent?: string;
  }): SessionPresentationPage {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
    const columns = presentationColumns(options.mode);
    const terms: string[] = []; const args: any[] = [];
    if (options.parentSessionId !== undefined) {
      terms.push('parent_session_id=?', 'pinned=0'); args.push(options.parentSessionId);
    } else if (options.roots) terms.push('presentation_root=1');
    if (options.agent !== undefined) { terms.push('agent=?'); args.push(options.agent); }
    if (options.after) {
      if (options.after.length !== columns.length) throw new Error('Invalid presentation key.');
      terms.push(`(${columns.join(',')})>(${columns.map(() => '?').join(',')})`); args.push(...options.after);
    }
    const rows = this.database().prepare(`SELECT metadata_json,busy,queue_length,managed_pending_count,
      ${columns.join(',')} FROM session_catalog${terms.length ? ` WHERE ${terms.join(' AND ')}` : ''}
      ORDER BY ${columns.join(',')} LIMIT ?`).all(...args, limit + 1) as Array<CatalogProjectionSqlRow & Record<string, any>>;
    const selected = rows.slice(0, limit);
    return { rows: selected.map(projectionFromSqlRow), hasMore: rows.length > limit,
      ...(rows.length > limit && selected.length ? { nextKey: presentationKey(selected[selected.length - 1], options.mode) } : {}) };
  }

  listAgentForestPage(options: { agent: string; limit: number; after?: SessionPresentationKey }): SessionPresentationPage {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit))); const columns = presentationColumns('time');
    const args: any[] = [options.agent]; const after = options.after
      ? ` AND (${columns.map(column => `c.${column}`).join(',')})>(${columns.map(() => '?').join(',')})` : '';
    if (options.after) { if (options.after.length !== columns.length) throw new Error('Invalid agent forest key.'); args.push(...options.after); }
    const rows = this.database().prepare(`SELECT c.metadata_json,c.busy,c.queue_length,c.managed_pending_count,${columns.map(column => `c.${column}`).join(',')}
      FROM session_catalog c LEFT JOIN session_catalog parent ON parent.session_id=c.parent_session_id
      WHERE c.agent=? AND (c.parent_session_id IS NULL OR parent.session_id IS NULL OR parent.agent<>c.agent)${after}
      ORDER BY ${columns.map(column => `c.${column}`).join(',')} LIMIT ?`).all(...args, limit + 1) as Array<CatalogProjectionSqlRow & Record<string, any>>;
    const selected = rows.slice(0, limit);
    return { rows: selected.map(projectionFromSqlRow), hasMore: rows.length > limit,
      ...(rows.length > limit && selected.length ? { nextKey: presentationKey(selected[selected.length - 1], 'time') } : {}) };
  }

  listChildrenPreviews(parentSessionIds: readonly string[], mode: SessionListOrderMode, limit: number, agent?: string): SessionChildrenPreview[] {
    const parents = [...new Set(parentSessionIds)].slice(0, 100);
    limit = Math.max(1, Math.min(20, Math.floor(limit)));
    if (!parents.length) return [];
    const columns = presentationColumns(mode, true);
    const counts = this.getUnpinnedParentCounts(parents, agent);
    if (agent !== undefined && mode !== 'time') throw new Error('Agent forest children require time mode.');
    const indexName = agent === undefined
      ? (mode === 'default' ? 'idx_session_catalog_parent_default' : 'idx_session_catalog_parent_time')
      : 'idx_session_catalog_parent_agent_architecture';
    const branches: string[] = []; const args: any[] = [];
    for (const parent of parents) {
      branches.push(`SELECT * FROM (SELECT metadata_json,busy,queue_length,managed_pending_count,parent_session_id,${columns.join(',')}
        FROM session_catalog INDEXED BY ${indexName} WHERE parent_session_id=?${agent === undefined ? ' AND pinned=0' : ' AND agent=?'}
        ORDER BY ${columns.join(',')} LIMIT ?)`);
      args.push(parent, ...(agent === undefined ? [] : [agent]), limit + 1);
    }
    const rows = this.database().prepare(branches.join(' UNION ALL ')).all(...args) as Array<CatalogProjectionSqlRow & Record<string, any>>;
    const grouped = new Map<string, Array<CatalogProjectionSqlRow & Record<string, any>>>();
    for (const row of rows) { const group = grouped.get(row.parent_session_id) || []; group.push(row); grouped.set(row.parent_session_id, group); }
    return parents.map(parentSessionId => {
      const all = grouped.get(parentSessionId) || []; const group = all.slice(0, limit); const total = counts[parentSessionId] || 0;
      return { parentSessionId, rows: group.map(projectionFromSqlRow), total, hasMore: all.length > limit,
        ...(all.length > limit && group.length ? { nextKey: presentationKey(group[group.length - 1], mode, true) } : {}) };
    });
  }

  listChildrenContinuations(requests: ReadonlyArray<{ parentSessionId: string; after?: SessionPresentationKey }>, mode: SessionListOrderMode, limit: number, agent?: string): SessionChildrenPreview[] {
    requests = [...new Map(requests.slice(0, 20).map(request => [request.parentSessionId, request])).values()];
    limit = Math.max(1, Math.min(20, Math.floor(limit)));
    if (!requests.length) return [];
    const columns = presentationColumns(mode, true); const args: any[] = []; const branches: string[] = [];
    if (agent !== undefined && mode !== 'time') throw new Error('Agent forest children require time mode.');
    const indexName = agent === undefined
      ? (mode === 'default' ? 'idx_session_catalog_parent_default' : 'idx_session_catalog_parent_time')
      : 'idx_session_catalog_parent_agent_architecture';
    for (const request of requests) {
      if (request.after && request.after.length !== columns.length) throw new Error('Invalid child presentation key.');
      const after = request.after ? ` AND (${columns.join(',')})>(${columns.map(() => '?').join(',')})` : '';
      branches.push(`SELECT * FROM (SELECT metadata_json,busy,queue_length,managed_pending_count,parent_session_id,${columns.join(',')}
        FROM session_catalog INDEXED BY ${indexName} WHERE parent_session_id=?${agent === undefined ? ' AND pinned=0' : ' AND agent=?'}${after}
        ORDER BY ${columns.join(',')} LIMIT ?)`);
      args.push(request.parentSessionId, ...(agent === undefined ? [] : [agent]), ...(request.after || []), limit + 1);
    }
    const counts = this.getUnpinnedParentCounts(requests.map(request => request.parentSessionId), agent);
    const rows = this.database().prepare(branches.join(' UNION ALL ')).all(...args) as Array<CatalogProjectionSqlRow & Record<string, any>>;
    const grouped = new Map<string, Array<CatalogProjectionSqlRow & Record<string, any>>>();
    for (const row of rows) { const group = grouped.get(row.parent_session_id) || []; group.push(row); grouped.set(row.parent_session_id, group); }
    return requests.map(request => {
      const all = grouped.get(request.parentSessionId) || []; const group = all.slice(0, limit); const total = counts[request.parentSessionId] || 0;
      return { parentSessionId: request.parentSessionId, rows: group.map(projectionFromSqlRow), total,
        hasMore: all.length > limit, ...(all.length > limit && group.length ? { nextKey: presentationKey(group[group.length - 1], mode, true) } : {}) };
    });
  }

  private getUnpinnedParentCounts(parentSessionIds: readonly string[], agent?: string): Record<string, number> {
    const parents = [...new Set(parentSessionIds)].slice(0, 100); if (!parents.length) return {};
    if (agent === undefined) {
      const rows = this.database().prepare(`SELECT parent_key,unpinned_session_count FROM catalog_parent_count
        WHERE parent_key IN (${parents.map(() => '?').join(',')})`).all(...parents) as Array<{ parent_key: string; unpinned_session_count: number }>;
      return Object.fromEntries(rows.map(row => [row.parent_key, Number(row.unpinned_session_count)]));
    }
    const rows = this.database().prepare(`SELECT parent_key,session_count FROM catalog_parent_agent_count
      WHERE agent=? AND parent_key IN (${parents.map(() => '?').join(',')})`)
      .all(agent, ...parents) as Array<{ parent_key: string; session_count: number }>;
    return Object.fromEntries(rows.map(row => [row.parent_key, Number(row.session_count)]));
  }

  getPresentationPaths(sessionIds: readonly string[]): Record<string, string[]> {
    const ids = [...new Set(sessionIds)].slice(0, 100);
    if (!ids.length) return {};
    const rows = this.database().prepare(`WITH RECURSIVE paths(focus_id,session_id,parent_session_id,depth,trail) AS (
      SELECT session_id,session_id,parent_session_id,0,'|'||hex(session_id)||'|' FROM session_catalog
        WHERE session_id IN (${ids.map(() => '?').join(',')})
      UNION ALL
      SELECT paths.focus_id,parent.session_id,parent.parent_session_id,paths.depth+1,
        paths.trail||hex(parent.session_id)||'|'
      FROM paths JOIN session_catalog parent ON parent.session_id=paths.parent_session_id
      WHERE paths.depth<127 AND instr(paths.trail,'|'||hex(parent.session_id)||'|')=0
    ) SELECT focus_id,session_id,depth FROM paths ORDER BY focus_id,depth DESC`).all(...ids) as Array<{ focus_id: string; session_id: string; depth: number }>;
    const result: Record<string, string[]> = {};
    for (const row of rows) (result[row.focus_id] ||= []).push(row.session_id);
    return result;
  }

  getArchitectureSummary(): { total: number; busy: number; queued: number; managed: number; cachedTokens: number; inputTokens: number; outputTokens: number } {
    const row = this.database().prepare(`SELECT session_count total,busy_count busy,queued_count queued,
      managed_count managed,cached_tokens cachedTokens,input_tokens inputTokens,output_tokens outputTokens
      FROM catalog_count WHERE singleton=1`).get() as any;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)])) as any;
  }

  getAgentCounts(): Array<{ agent: string; count: number }> {
    return (this.database().prepare('SELECT agent,session_count count FROM catalog_agent_count ORDER BY agent').all() as any[])
      .map(row => ({ agent: row.agent, count: Number(row.count) }));
  }

  getDescendantSummary(sessionId: string, previewLimit: number): { total: number; busy: number; queued: number; cachedTokens: number; inputTokens: number; outputTokens: number; rows: Record<string, any>[] } {
    previewLimit = Math.max(0, Math.min(100, Math.floor(previewLimit)));
    const rows = this.database().prepare(`WITH RECURSIVE subtree(session_id) AS (
      VALUES(?) UNION SELECT child.session_id FROM session_catalog child JOIN subtree ON child.parent_session_id=subtree.session_id
    ), descendants AS (
      SELECT c.*,count(*) OVER() total,sum(c.busy) OVER() busyTotal,
        sum(CASE WHEN c.queue_length>0 THEN 1 ELSE 0 END) OVER() queuedTotal,
        sum(c.cached_tokens) OVER() cachedTokens,sum(c.input_tokens) OVER() inputTokens,sum(c.output_tokens) OVER() outputTokens
      FROM session_catalog c JOIN subtree s ON s.session_id=c.session_id WHERE c.session_id<>?
    ) SELECT metadata_json,busy,queue_length,managed_pending_count,total,busyTotal,queuedTotal,cachedTokens,inputTokens,outputTokens
      FROM descendants ORDER BY recent_rank,session_id LIMIT ?`).all(sessionId, sessionId, previewLimit) as Array<CatalogProjectionSqlRow & Record<string, any>>;
    const first = rows[0];
    return { total: Number(first?.total || 0), busy: Number(first?.busyTotal || 0), queued: Number(first?.queuedTotal || 0),
      cachedTokens: Number(first?.cachedTokens || 0), inputTokens: Number(first?.inputTokens || 0), outputTokens: Number(first?.outputTokens || 0),
      rows: rows.map(projectionFromSqlRow) };
  }

  listBusySessionIds(): string[] {
    return (this.database().prepare('SELECT session_id FROM session_catalog WHERE busy=1 ORDER BY session_id').all() as Array<{ session_id: string }>).map(row => row.session_id);
  }

  getBusyDescendantCounts(rootIds: readonly string[], busyIds: readonly string[]): Map<string, number> {
    const roots = [...new Set(rootIds)].slice(0, 100);
    const activeIds = [...new Set(busyIds)];
    if (!roots.length) return new Map();
    if (!activeIds.length) return new Map(roots.map(id => [id, 0]));
    const activeUnion = activeIds.map(() => 'SELECT ?').join(' UNION ');
    const rows = this.database().prepare(`WITH RECURSIVE active(session_id) AS (${activeUnion}), ancestors(active_id,ancestor_id,trail) AS (
      SELECT active.session_id,c.parent_session_id,'|'||hex(active.session_id)||'|' FROM active
      JOIN session_catalog c ON c.session_id=active.session_id WHERE c.parent_session_id IS NOT NULL AND c.parent_session_id<>active.session_id
      UNION ALL
      SELECT ancestors.active_id,parent.parent_session_id,ancestors.trail||hex(parent.session_id)||'|'
      FROM ancestors JOIN session_catalog parent ON parent.session_id=ancestors.ancestor_id
      WHERE parent.parent_session_id IS NOT NULL AND parent.parent_session_id<>ancestors.active_id
        AND instr(ancestors.trail,'|'||hex(parent.session_id)||'|')=0
    ) SELECT ancestor_id,count(DISTINCT active_id) busy FROM ancestors
      WHERE ancestor_id IN (${roots.map(() => '?').join(',')}) GROUP BY ancestor_id`).all(...activeIds, ...roots) as Array<{ ancestor_id: string; busy: number }>;
    const result = new Map(roots.map(id => [id, 0]));
    for (const row of rows) result.set(row.ancestor_id, Number(row.busy || 0));
    return result;
  }

  filterDescendantIds(sessionId: string, candidateIds: readonly string[]): string[] {
    const ids = [...new Set(candidateIds)].slice(0, 200); if (!ids.length) return [];
    return (this.database().prepare(`WITH RECURSIVE subtree(session_id) AS (
      VALUES(?) UNION SELECT child.session_id FROM session_catalog child JOIN subtree ON child.parent_session_id=subtree.session_id
    ) SELECT session_id FROM subtree WHERE session_id<>? AND session_id IN (${ids.map(() => '?').join(',')})`)
      .all(sessionId, sessionId, ...ids) as Array<{ session_id: string }>).map(row => row.session_id);
  }
  count(options: Pick<SessionCatalogPageOptions, 'agent'|'parentSessionId'|'recoveryOnly'> = {}): number {
    if (!options.recoveryOnly && options.agent === undefined && !Object.prototype.hasOwnProperty.call(options, 'parentSessionId')) {
      return Number((this.database().prepare('SELECT session_count FROM catalog_count WHERE singleton=1').get() as { session_count: number }).session_count);
    }
    if (!options.recoveryOnly && options.agent !== undefined && !Object.prototype.hasOwnProperty.call(options, 'parentSessionId')) {
      return Number((this.database().prepare('SELECT session_count FROM catalog_agent_count WHERE agent=?').get(options.agent) as { session_count: number } | undefined)?.session_count || 0);
    }
    if (!options.recoveryOnly && options.agent === undefined && Object.prototype.hasOwnProperty.call(options, 'parentSessionId')) {
      return Number((this.database().prepare('SELECT session_count FROM catalog_parent_count WHERE parent_key=?').get(options.parentSessionId || '') as { session_count: number } | undefined)?.session_count || 0);
    }
    const { where, args } = this.where(options);
    return Number((this.database().prepare(`SELECT count(*) AS count FROM session_catalog${where}`).get(...args) as { count: number }).count);
  }

  private where(options: Pick<SessionCatalogPageOptions, 'agent'|'currentNode'|'parentSessionId'|'recoveryOnly'>): { where: string; args: any[] } {
    const terms: string[] = []; const args: any[] = [];
    if (options.agent !== undefined) { terms.push('agent=?'); args.push(options.agent); }
    if (options.currentNode !== undefined) { terms.push('current_node=?'); args.push(options.currentNode); }
    if (Object.prototype.hasOwnProperty.call(options, 'parentSessionId')) {
      terms.push(options.parentSessionId === null ? 'parent_session_id IS NULL' : 'parent_session_id=?');
      if (options.parentSessionId !== null) args.push(options.parentSessionId);
    }
    if (options.recoveryOnly) terms.push('(busy=1 OR queue_length>0 OR managed_pending_count>0)');
    return { where: terms.length ? ` WHERE ${terms.join(' AND ')}` : '', args };
  }

  list(options: SessionCatalogPageOptions = {}): Record<string, any>[] {
    const base = this.where(options);
    const terms = base.where ? [base.where.slice(' WHERE '.length)] : [];
    const args = [...base.args];
    if (options.after) {
      terms.push('(recent_rank,session_id)>(?,?)');
      args.push(-options.after.lastMessageTime, options.after.sessionId);
    }
    if (terms.length === 0) {
      terms.push('recent_rank>=?');
      args.push(-Number.MAX_VALUE);
    }
    const where = terms.length ? ` WHERE ${terms.join(' AND ')}` : '';
    const limit = options.limit === undefined ? -1 : Math.max(0, Math.floor(options.limit));
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const rows = this.database().prepare(`SELECT metadata_json,busy,queue_length,managed_pending_count FROM session_catalog${where}
      ORDER BY recent_rank, session_id LIMIT ? OFFSET ?`).all(...args, limit, offset) as Array<{
        metadata_json: string; busy: number; queue_length: number; managed_pending_count: number;
      }>;
    return rows.map(row => ({
      ...JSON.parse(row.metadata_json), busy: row.busy === 1,
      queueLength: row.queue_length, managedPendingCount: row.managed_pending_count,
    }));
  }

  listByAgent(agent: string, options: Omit<SessionCatalogPageOptions, 'agent'> = {}): Record<string, any>[] {
    return this.list({ ...options, agent });
  }

  listByCurrentNode(currentNode: string, options: Omit<SessionCatalogPageOptions, 'currentNode'> = {}): Record<string, any>[] {
    return this.list({ ...options, currentNode });
  }

  listRoots(options: Omit<SessionCatalogPageOptions, 'parentSessionId'> = {}): Record<string, any>[] {
    return this.list({ ...options, parentSessionId: null });
  }

  listChildren(parentSessionId: string | null, options: Omit<SessionCatalogPageOptions, 'parentSessionId'> = {}): Record<string, any>[] {
    return this.list({ ...options, parentSessionId });
  }

  listRecoveryCandidates(options: Omit<SessionCatalogPageOptions, 'recoveryOnly'> = {}): Record<string, any>[] {
    const limit = options.limit === undefined ? -1 : Math.max(0, Math.floor(options.limit));
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const rows = this.database().prepare(`WITH recovery AS (
      SELECT metadata_json,recent_rank,session_id,busy,queue_length,managed_pending_count FROM session_catalog WHERE busy=1
      UNION
      SELECT metadata_json,recent_rank,session_id,busy,queue_length,managed_pending_count FROM session_catalog WHERE queue_length>0
      UNION
      SELECT metadata_json,recent_rank,session_id,busy,queue_length,managed_pending_count FROM session_catalog WHERE managed_pending_count>0
    ) SELECT metadata_json,busy,queue_length,managed_pending_count FROM recovery
      ORDER BY recent_rank,session_id LIMIT ? OFFSET ?`).all(limit, offset) as Array<{
        metadata_json: string; busy: number; queue_length: number; managed_pending_count: number;
      }>;
    return rows.map(row => ({
      ...JSON.parse(row.metadata_json),
      busy: row.busy === 1,
      queueLength: row.queue_length,
      managedPendingCount: row.managed_pending_count,
    }));
  }

  get(sessionId: string): Record<string, any> | null {
    const row = this.database().prepare('SELECT metadata_json,busy,queue_length,managed_pending_count FROM session_catalog WHERE session_id=?').get(sessionId) as {
      metadata_json: string; busy: number; queue_length: number; managed_pending_count: number;
    } | undefined;
    return row ? {
      ...JSON.parse(row.metadata_json), busy: row.busy === 1,
      queueLength: row.queue_length, managedPendingCount: row.managed_pending_count,
    } : null;
  }

  resolveId(requestedId: string): SessionAliasResolution {
    if (this.database().prepare('SELECT 1 FROM session_catalog WHERE session_id=?').get(requestedId)) {
      return { kind: 'exact', sessionId: requestedId };
    }
    const rows = this.database().prepare('SELECT session_id FROM session_alias WHERE alias=? ORDER BY session_id LIMIT 2').all(requestedId) as Array<{ session_id: string }>;
    if (rows.length === 0) return { kind: 'missing' };
    if (rows.length === 1) return { kind: 'alias', sessionId: rows[0].session_id };
    return { kind: 'ambiguous', sessionIds: rows.map(row => row.session_id) };
  }

  resolveMany(requestedIds: readonly string[]): Record<string, SessionAliasResolution> {
    const ids = [...new Set(requestedIds)].slice(0, 200); if (!ids.length) return {};
    const placeholders = ids.map(() => '?').join(',');
    const exact = new Set((this.database().prepare(`SELECT session_id FROM session_catalog WHERE session_id IN (${placeholders})`).all(...ids) as Array<{ session_id: string }>).map(row => row.session_id));
    const aliases = this.database().prepare(`SELECT alias,session_id FROM session_alias WHERE alias IN (${placeholders}) ORDER BY alias,session_id`).all(...ids) as Array<{ alias: string; session_id: string }>;
    const owners = new Map<string, string[]>();
    for (const row of aliases) { const list = owners.get(row.alias) || []; if (list.length < 2) list.push(row.session_id); owners.set(row.alias, list); }
    return Object.fromEntries(ids.map(id => {
      if (exact.has(id)) return [id, { kind: 'exact', sessionId: id }];
      const matches = owners.get(id) || [];
      return [id, matches.length === 0 ? { kind: 'missing' } : matches.length === 1
        ? { kind: 'alias', sessionId: matches[0] } : { kind: 'ambiguous', sessionIds: matches }];
    }));
  }

  upsertMany(records: Iterable<Record<string, any>>, deletedSessionIds: Iterable<string> = []): void {
    const db = this.database();
    db.exec('BEGIN IMMEDIATE');
    try {
      const affectedReferences = new Set<string>();
      const oldAliases = db.prepare('SELECT alias FROM session_alias WHERE session_id=?');
      const remove = db.prepare('DELETE FROM session_catalog WHERE session_id=?');
      for (const id of deletedSessionIds) {
        affectedReferences.add(id);
        for (const row of oldAliases.all(id) as Array<{ alias: string }>) affectedReferences.add(row.alias);
        remove.run(id);
      }
      for (const metadata of records) {
        affectedReferences.add(metadata.id);
        if (typeof metadata.parentSessionId === 'string') affectedReferences.add(metadata.parentSessionId);
        for (const row of oldAliases.all(metadata.id) as Array<{ alias: string }>) affectedReferences.add(row.alias);
        for (const alias of metadata.aliases || []) affectedReferences.add(alias);
        insertMetadata(db, metadata);
      }
      normalizeParentReferences(db, affectedReferences);
      db.exec('COMMIT');
      this.presentationRevision += 1;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  replaceAll(records: Iterable<Record<string, any>>): void {
    const db = this.database();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM session_catalog');
      for (const metadata of records) insertMetadata(db, metadata);
      normalizeParentReferences(db);
      db.exec('COMMIT');
      this.presentationRevision += 1;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  deleteMany(sessionIds: Iterable<string>): void {
    this.upsertMany([], sessionIds);
  }

  checkpoint(): void { this.database().exec('PRAGMA wal_checkpoint(TRUNCATE)'); }

  getConnectionPragmas(): { journalMode: string; synchronous: number; busyTimeout: number; foreignKeys: number } {
    const db = this.database();
    return {
      journalMode: String((db.prepare('PRAGMA journal_mode').get() as any).journal_mode),
      synchronous: Number((db.prepare('PRAGMA synchronous').get() as any).synchronous),
      busyTimeout: Number((db.prepare('PRAGMA busy_timeout').get() as any).timeout),
      foreignKeys: Number((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys),
    };
  }

  async backupTo(destinationPath: string): Promise<void> {
    if (fs.existsSync(destinationPath)) throw new Error(`Backup destination already exists: ${destinationPath}`);
    fs.ensureDirSync(path.dirname(destinationPath));
    const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await backup(this.database(), tempPath);
      const destination = new DatabaseSync(tempPath, { readOnly: true });
      try {
        const integrity = destination.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        if (integrity.integrity_check !== 'ok') throw new Error(`Session catalog backup integrity failed: ${integrity.integrity_check}`);
      } finally { destination.close(); }
      fsyncPath(tempPath);
      fs.renameSync(tempPath, destinationPath);
      fsyncPath(path.dirname(destinationPath));
    } catch (error) {
      fs.removeSync(tempPath);
      throw error;
    }
  }
}

export const sessionCatalogStore = new SessionCatalogStore();

export function isSessionCatalogInitialized(): boolean {
  try { sessionCatalogStore.count(); return true; } catch { return false; }
}

export async function readLegacyChannelAttachmentsFromCatalogMigrationEvidence(): Promise<unknown> {
  if (!await fs.pathExists(MIGRATION_EVIDENCE_PATH)) return undefined;
  const raw = await fs.readJson(MIGRATION_EVIDENCE_PATH);
  return raw?.channelAttachments;
}