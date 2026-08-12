import fs from 'fs-extra';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import {
  type LlmJournalAttemptResultRecord,
  type LlmJournalAttemptStartRecord,
  type LlmJournalObjectRecord,
  type LlmJournalRecord,
  type LlmJournalRecordKind,
  type LlmJournalRequestRecord,
  type LlmJournalScanCursor,
  type LlmRequestJournalCursor,
  type LlmRequestJournalStore,
  type LlmRequestJournalSummary,
  type LlmRequestPurpose,
  canonicalJournalJson,
} from './llmRequestJournalStore';

function parseIds(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('Invalid LLM request journal message object ID list');
  return parsed;
}
function objectFromRow(row: any): LlmJournalObjectRecord { return { v: 1, kind: 'object', objectId: row.object_id, objectKind: row.object_kind, payload: row.payload, createdAt: row.created_at }; }
function requestFromRow(row: any): LlmJournalRequestRecord { return { v: 1, kind: 'request', requestId: row.request_id, sessionId: row.session_id || undefined, purpose: row.purpose, iteration: row.iteration, createdAt: row.created_at, promptObjectId: row.prompt_object_id, toolSchemaObjectId: row.tool_schema_object_id, requestedModelKey: row.requested_model_key, promptCacheKeyHash: row.prompt_cache_key_hash, messageCount: row.message_count, deltaDepth: row.delta_depth, ...(row.checkpoint_message_ids_json !== null ? { checkpointMessageObjectIds: parseIds(row.checkpoint_message_ids_json) } : {}), ...(row.base_request_id !== null ? { baseRequestId: row.base_request_id, commonPrefixLength: row.common_prefix_length, appendedMessageObjectIds: parseIds(row.appended_message_ids_json) } : {}) }; }
function startFromRow(row: any): LlmJournalAttemptStartRecord { return { v: 1, kind: 'attempt-start', eventId: row.event_id, requestId: row.request_id, attempt: row.attempt, startedAt: row.started_at, concreteModelId: row.concrete_model_id, virtualModelKey: row.virtual_model_key || undefined, providerType: row.provider_type, semanticPayloadSha256: row.semantic_payload_sha256 }; }
function resultFromRow(row: any): LlmJournalAttemptResultRecord { return { v: 1, kind: 'attempt-result', eventId: row.event_id, requestId: row.request_id, attempt: row.attempt, completedAt: row.completed_at, outcome: row.outcome, result: row.result_json ? JSON.parse(row.result_json) : undefined, error: row.error_json ? JSON.parse(row.error_json) : undefined }; }

export class SqliteLlmRequestJournalStore implements LlmRequestJournalStore {
  readonly backend = 'sqlite' as const;
  private db?: DatabaseSync;
  private snapshotDepth = 0;
  constructor(readonly databasePath: string, private readonly readOnly = false) {}
  get rawDatabase(): DatabaseSync { if (!this.db) throw new Error('LLM request journal is not initialized'); return this.db; }
  async initialize(): Promise<void> {
    if (this.db) return;
    if (!this.readOnly) fs.ensureDirSync(path.dirname(this.databasePath));
    this.db = this.readOnly
      ? new DatabaseSync(this.databasePath, { readOnly: true })
      : new DatabaseSync(this.databasePath);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; ${this.readOnly ? 'PRAGMA query_only=ON;' : 'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'}`);
    if (!this.readOnly) this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_journal_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS llm_journal_objects (object_id TEXT PRIMARY KEY,object_kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS llm_journal_requests (request_id TEXT PRIMARY KEY,session_id TEXT,purpose TEXT NOT NULL,iteration INTEGER NOT NULL,created_at INTEGER NOT NULL,prompt_object_id TEXT NOT NULL,tool_schema_object_id TEXT NOT NULL,requested_model_key TEXT NOT NULL,prompt_cache_key_hash TEXT NOT NULL,message_count INTEGER NOT NULL,checkpoint_message_ids_json TEXT,base_request_id TEXT,common_prefix_length INTEGER,appended_message_ids_json TEXT,delta_depth INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_llm_journal_requests_session_created ON llm_journal_requests(session_id,created_at,request_id);
      CREATE TABLE IF NOT EXISTS llm_journal_attempt_starts (event_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,attempt INTEGER NOT NULL,started_at INTEGER NOT NULL,concrete_model_id TEXT NOT NULL,virtual_model_key TEXT,provider_type TEXT NOT NULL,semantic_payload_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS llm_journal_attempt_results (event_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,attempt INTEGER NOT NULL,completed_at INTEGER NOT NULL,outcome TEXT NOT NULL,result_json TEXT,error_json TEXT);
      CREATE TABLE IF NOT EXISTS llm_journal_import_state (source_path TEXT PRIMARY KEY,imported_size INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    `);
  }
  async close(): Promise<void> { try { this.db?.close(); } finally { this.db = undefined; } }
  async appendRecords(records: LlmJournalRecord[]): Promise<void> {
    await this.initialize(); const db = this.rawDatabase; db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        if (record.kind === 'object') db.prepare('INSERT OR IGNORE INTO llm_journal_objects(object_id,object_kind,payload,created_at) VALUES(?,?,?,?)').run(record.objectId,record.objectKind,record.payload,record.createdAt);
        else if (record.kind === 'request') db.prepare('INSERT OR IGNORE INTO llm_journal_requests(request_id,session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,requested_model_key,prompt_cache_key_hash,message_count,checkpoint_message_ids_json,base_request_id,common_prefix_length,appended_message_ids_json,delta_depth) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(record.requestId,record.sessionId||null,record.purpose,record.iteration,record.createdAt,record.promptObjectId,record.toolSchemaObjectId,record.requestedModelKey,record.promptCacheKeyHash,record.messageCount,record.checkpointMessageObjectIds?JSON.stringify(record.checkpointMessageObjectIds):null,record.baseRequestId||null,record.commonPrefixLength??null,record.appendedMessageObjectIds?JSON.stringify(record.appendedMessageObjectIds):null,record.deltaDepth);
        else if (record.kind === 'attempt-start') db.prepare('INSERT OR IGNORE INTO llm_journal_attempt_starts(event_id,request_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256) VALUES(?,?,?,?,?,?,?,?)').run(record.eventId,record.requestId,record.attempt,record.startedAt,record.concreteModelId,record.virtualModelKey||null,record.providerType,record.semanticPayloadSha256);
        else db.prepare('INSERT OR IGNORE INTO llm_journal_attempt_results(event_id,request_id,attempt,completed_at,outcome,result_json,error_json) VALUES(?,?,?,?,?,?,?)').run(record.eventId,record.requestId,record.attempt,record.completedAt,record.outcome,record.result?canonicalJournalJson(record.result):null,record.error?canonicalJournalJson(record.error):null);
      }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  async hasObject(id:string):Promise<boolean>{await this.initialize();return !!this.rawDatabase.prepare('SELECT 1 FROM llm_journal_objects WHERE object_id=?').get(id);}
  async getObject(id:string){await this.initialize();const r:any=this.rawDatabase.prepare('SELECT * FROM llm_journal_objects WHERE object_id=?').get(id);return r?objectFromRow(r):null;}
  async getRequest(id:string){await this.initialize();const r:any=this.rawDatabase.prepare('SELECT * FROM llm_journal_requests WHERE request_id=?').get(id);return r?requestFromRow(r):null;}
  async getLatestRequestForSession(id:string){await this.initialize();const r:any=this.rawDatabase.prepare('SELECT request_id,delta_depth FROM llm_journal_requests WHERE session_id=? ORDER BY created_at DESC,request_id DESC LIMIT 1').get(id);return r?{requestId:r.request_id,deltaDepth:r.delta_depth}:null;}
  async getAttemptStarts(id:string){await this.initialize();return (this.rawDatabase.prepare('SELECT * FROM llm_journal_attempt_starts WHERE request_id=? ORDER BY attempt,started_at,event_id').all(id) as any[]).map(startFromRow);}
  async getAttemptResults(id:string){await this.initialize();return (this.rawDatabase.prepare('SELECT * FROM llm_journal_attempt_results WHERE request_id=? ORDER BY attempt,completed_at,event_id').all(id) as any[]).map(resultFromRow);}
  async listRequests(o:{sessionId?:string;purpose?:LlmRequestPurpose;limit:number;before?:LlmRequestJournalCursor}):Promise<LlmRequestJournalSummary[]>{await this.initialize();const c:string[]=[];const p:any[]=[];if(o.sessionId){c.push('session_id=?');p.push(o.sessionId);}if(o.purpose){c.push('purpose=?');p.push(o.purpose);}if(o.before){c.push('(created_at < ? OR (created_at = ? AND request_id < ?))');p.push(o.before.createdAt,o.before.createdAt,o.before.requestId);}return (this.rawDatabase.prepare(`SELECT request_id,session_id,purpose,iteration,created_at,requested_model_key,message_count FROM llm_journal_requests ${c.length?`WHERE ${c.join(' AND ')}`:''} ORDER BY created_at DESC,request_id DESC LIMIT ?`).all(...p,o.limit) as any[]).map(r=>({requestId:r.request_id,sessionId:r.session_id||undefined,purpose:r.purpose,iteration:r.iteration,createdAt:r.created_at,requestedModelKey:r.requested_model_key,messageCount:r.message_count}));}
  async scanRecords(kind:LlmJournalRecordKind,after:LlmJournalScanCursor|undefined,limit:number){await this.initialize();const map={object:{table:'llm_journal_objects',time:'created_at',id:'object_id',convert:objectFromRow},request:{table:'llm_journal_requests',time:'created_at',id:'request_id',convert:requestFromRow},'attempt-start':{table:'llm_journal_attempt_starts',time:'started_at',id:'event_id',convert:startFromRow},'attempt-result':{table:'llm_journal_attempt_results',time:'completed_at',id:'event_id',convert:resultFromRow}} as const;const e=map[kind];const rows=this.rawDatabase.prepare(`SELECT * FROM ${e.table} ${after?`WHERE (${e.time} > ? OR (${e.time} = ? AND ${e.id} > ?))`:''} ORDER BY ${e.time},${e.id} LIMIT ?`).all(...(after?[after.time,after.time,after.id,limit]:[limit])) as any[];const records=rows.map(e.convert as any) as LlmJournalRecord[];const last=rows[rows.length-1];return{records,...(last?{next:{time:last[e.time],id:last[e.id]}}:{})};}
  async getRecord(r:LlmJournalRecord){if(r.kind==='object')return this.getObject(r.objectId);if(r.kind==='request')return this.getRequest(r.requestId);await this.initialize();const row:any=this.rawDatabase.prepare(`SELECT * FROM ${r.kind==='attempt-start'?'llm_journal_attempt_starts':'llm_journal_attempt_results'} WHERE event_id=?`).get(r.eventId);return row?(r.kind==='attempt-start'?startFromRow(row):resultFromRow(row)):null;}
  async getCounts(){await this.initialize();const db=this.rawDatabase;const count=(table:string)=>Number((db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as any).count);return{objects:count('llm_journal_objects'),requests:count('llm_journal_requests'),attemptStarts:count('llm_journal_attempt_starts'),attemptResults:count('llm_journal_attempt_results')};}
  async getMetadata(k:string){await this.initialize();return (this.rawDatabase.prepare('SELECT value FROM llm_journal_metadata WHERE key=?').get(k) as any)?.value;}
  async setMetadata(k:string,v:string){await this.initialize();this.rawDatabase.prepare('INSERT INTO llm_journal_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,v);}
  async withConsistentSnapshot<T>(fn:()=>Promise<T>):Promise<T>{await this.initialize();if(this.snapshotDepth)return fn();this.rawDatabase.exec('BEGIN');this.snapshotDepth++;try{const v=await fn();this.rawDatabase.exec('COMMIT');return v;}catch(e){try{this.rawDatabase.exec('ROLLBACK');}catch{}throw e;}finally{this.snapshotDepth--;}}
  async checkIntegrity(){await this.initialize();const value:any=this.rawDatabase.prepare('PRAGMA integrity_check').get();if(!value||Object.values(value)[0]!=='ok')throw new Error(`llm-request-journal.sqlite integrity_check failed: ${JSON.stringify(value)}`);if((this.rawDatabase.prepare('PRAGMA foreign_key_check').all() as any[]).length)throw new Error('llm-request-journal.sqlite foreign_key_check failed');}
  async replaceObjectPayloadForTests(id:string,payload:string){const row:any=this.rawDatabase.prepare('SELECT o.object_id,o.payload FROM llm_journal_requests r JOIN llm_journal_objects o ON o.object_id=r.prompt_object_id WHERE r.request_id=?').get(id);if(!row)throw new Error(`Request ${id} not found`);this.rawDatabase.prepare('UPDATE llm_journal_objects SET payload=? WHERE object_id=?').run(payload,row.object_id);return row.payload;}
  async replaceRequestMessageCountForTests(id:string,count:number){const row:any=this.rawDatabase.prepare('SELECT message_count FROM llm_journal_requests WHERE request_id=?').get(id);if(!row)throw new Error(`Request ${id} not found`);this.rawDatabase.prepare('UPDATE llm_journal_requests SET message_count=? WHERE request_id=?').run(count,id);return row.message_count;}
  async replaceRequestCreatedAtForTests(ids:string[],time:number){const update=this.rawDatabase.prepare('UPDATE llm_journal_requests SET created_at=? WHERE request_id=?');this.rawDatabase.exec('BEGIN IMMEDIATE');try{for(const id of ids)update.run(time,id);this.rawDatabase.exec('COMMIT');}catch(e){this.rawDatabase.exec('ROLLBACK');throw e;}}
  async replaceRequestIdentityForTests(id:string,v:{purpose:string;promptCacheKeyHash:string;iteration:number}){const row:any=this.rawDatabase.prepare('SELECT purpose,prompt_cache_key_hash,iteration FROM llm_journal_requests WHERE request_id=?').get(id);this.rawDatabase.prepare('UPDATE llm_journal_requests SET purpose=?,prompt_cache_key_hash=?,iteration=? WHERE request_id=?').run(v.purpose,v.promptCacheKeyHash,v.iteration,id);return{purpose:row.purpose,promptCacheKeyHash:row.prompt_cache_key_hash,iteration:row.iteration};}
  async replaceAttemptStartHashForTests(id:string,hash:string){const row:any=this.rawDatabase.prepare('SELECT event_id,semantic_payload_sha256 FROM llm_journal_attempt_starts WHERE request_id=? ORDER BY attempt LIMIT 1').get(id);this.rawDatabase.prepare('UPDATE llm_journal_attempt_starts SET semantic_payload_sha256=? WHERE event_id=?').run(hash,row.event_id);return row.semantic_payload_sha256;}
  async replaceAttemptResultOutcomeForTests(id:string,outcome:string){const row:any=this.rawDatabase.prepare('SELECT event_id,outcome FROM llm_journal_attempt_results WHERE request_id=? ORDER BY attempt LIMIT 1').get(id);this.rawDatabase.prepare('UPDATE llm_journal_attempt_results SET outcome=? WHERE event_id=?').run(outcome,row.event_id);return row.outcome;}
}
