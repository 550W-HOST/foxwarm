import crypto, { randomUUID } from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promises as nodeFs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { LLM_REQUEST_JOURNAL_STORAGE_CONFIG, STATE_DIR } from './config';
import type { Message, ToolDefinition } from './types';
import {
  MAX_LLM_REQUEST_DELTA_DEPTH,
  LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY,
  LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_MIGRATION_ID,
  type LlmJournalAttemptResultRecord as AttemptResultRecord,
  type LlmJournalAttemptStartRecord as AttemptStartRecord,
  type LlmJournalObjectKind as ObjectKind,
  type LlmJournalObjectRecord as ObjectRecord,
  type LlmJournalRecord as JournalRecord,
  type LlmJournalRecordKind,
  type LlmJournalRequestRecord as RequestRecord,
  type LlmRequestJournalCursor,
  type LlmRequestJournalStore,
  type LlmRequestJournalSummary,
  type LlmRequestPurpose,
  type ReconstructedLlmRequest,
  canonicalJournalJson,
} from './llmRequestJournalStore';
import { getLlmRequestJournalStore, closeLlmRequestJournalStore, resetLlmRequestJournalStoreForTests } from './llmRequestJournalStoreFactory';
import { SqliteLlmRequestJournalStore } from './llmRequestJournalSqliteStore';
import { LLM_REQUEST_JOURNAL_DB_PATH, LLM_REQUEST_JOURNAL_JSONL_PATH } from './llmRequestJournalPaths';

export { LLM_REQUEST_JOURNAL_DB_PATH, LLM_REQUEST_JOURNAL_JSONL_PATH } from './llmRequestJournalPaths';
export { canonicalJournalJson } from './llmRequestJournalStore';
export type { LlmRequestPurpose, LlmRequestJournalCursor, LlmRequestJournalSummary, ReconstructedLlmRequest } from './llmRequestJournalStore';

const JOURNAL_PATH = LLM_REQUEST_JOURNAL_JSONL_PATH;
const JOURNAL_LOCK_PATH = `${JOURNAL_PATH}.lock`;
const requestedImportBatchSize = Number(process.env.FOXWARM_LLM_JOURNAL_IMPORT_BATCH_SIZE || 200);
const IMPORT_BATCH_SIZE = Number.isFinite(requestedImportBatchSize) ? Math.max(1, Math.min(10_000, Math.floor(requestedImportBatchSize))) : 200;
let writeFaultInjector: ((phase: string, record: JournalRecord) => void) | null = null;

function sha256(value: string): string { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }
export function hashJournalValue(value: unknown): string { return sha256(canonicalJournalJson(value)); }

function parseIds(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('Invalid LLM request journal message object ID list');
  return parsed;
}

function assertObjectRecord(record: ObjectRecord): void {
  if (typeof record.objectId !== 'string' || !Number.isSafeInteger(record.createdAt)) throw new Error('Invalid LLM journal object record');
  if (!['prompt', 'tool-schema', 'message'].includes(record.objectKind)) throw new Error(`Invalid LLM journal object kind ${record.objectKind}`);
  if (typeof record.payload !== 'string') throw new Error(`Invalid LLM journal object payload ${record.objectId}`);
  if (record.objectId !== sha256(`${record.objectKind}\0${record.payload}`)) throw new Error(`LLM journal object hash mismatch for ${record.objectId}`);
}
function assertRequestRecord(record: RequestRecord): void {
  if (typeof record.requestId !== 'string' || typeof record.promptObjectId !== 'string' || typeof record.toolSchemaObjectId !== 'string'
    || !Number.isSafeInteger(record.createdAt) || !Number.isInteger(record.iteration) || record.iteration < 0 || typeof record.requestedModelKey !== 'string'
    || (record.sessionId !== undefined && typeof record.sessionId !== 'string')
    || !['normal-turn','compact-plan','btw','toolscript-one-shot','cli','setup-test','low-level'].includes(record.purpose)
    || !/^sha256:[a-f0-9]{64}$/.test(record.promptCacheKeyHash)) throw new Error('Invalid LLM journal request identity');
  if (!Number.isInteger(record.messageCount) || record.messageCount < 0) throw new Error(`Invalid LLM journal message count for ${record.requestId}`);
  if (!Number.isInteger(record.deltaDepth) || record.deltaDepth < 0 || record.deltaDepth > MAX_LLM_REQUEST_DELTA_DEPTH) throw new Error(`Invalid LLM journal delta depth for ${record.requestId}`);
  const checkpoint = Array.isArray(record.checkpointMessageObjectIds);
  const delta = typeof record.baseRequestId === 'string' && Array.isArray(record.appendedMessageObjectIds) && Number.isInteger(record.commonPrefixLength) && record.commonPrefixLength! >= 0;
  if (checkpoint === delta) throw new Error(`LLM journal request ${record.requestId} must contain exactly one checkpoint or delta`);
  if (checkpoint && record.deltaDepth !== 0) throw new Error(`LLM journal checkpoint ${record.requestId} has nonzero depth`);
}
function assertAttemptStartRecord(record: AttemptStartRecord): void {
  if (typeof record.eventId !== 'string' || typeof record.requestId !== 'string' || !Number.isInteger(record.attempt) || record.attempt < 1
    || !Number.isSafeInteger(record.startedAt) || typeof record.concreteModelId !== 'string' || typeof record.providerType !== 'string'
    || (record.virtualModelKey !== undefined && typeof record.virtualModelKey !== 'string')
    || !/^sha256:[a-f0-9]{64}$/.test(record.semanticPayloadSha256)) throw new Error('Invalid LLM journal attempt-start record');
}
function assertAttemptResultRecord(record: AttemptResultRecord): void {
  if (typeof record.eventId !== 'string' || typeof record.requestId !== 'string' || !Number.isInteger(record.attempt) || record.attempt < 1
    || !Number.isSafeInteger(record.completedAt) || !['success','failure','abort'].includes(record.outcome)
    || (record.outcome === 'success' && (!record.result || typeof record.result !== 'object'))
    || (record.outcome !== 'success' && (!record.error || typeof record.error !== 'object'))) throw new Error('Invalid LLM journal attempt-result record');
}
function assertRecord(record: JournalRecord): void {
  if (record.kind === 'object') assertObjectRecord(record);
  else if (record.kind === 'request') assertRequestRecord(record);
  else if (record.kind === 'attempt-start') assertAttemptStartRecord(record);
  else assertAttemptResultRecord(record);
}

async function reconstructMessageIds(store: LlmRequestJournalStore, requestId: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(requestId)) throw new Error(`LLM request journal delta cycle at ${requestId}`);
  if (seen.size > MAX_LLM_REQUEST_DELTA_DEPTH) throw new Error(`LLM request journal delta chain exceeds ${MAX_LLM_REQUEST_DELTA_DEPTH} for ${requestId}`);
  seen.add(requestId);
  const record = await store.getRequest(requestId);
  if (!record) throw new Error(`LLM request journal request ${requestId} not found`);
  assertRequestRecord(record);
  if (record.checkpointMessageObjectIds) return parseIds(record.checkpointMessageObjectIds);
  if (!record.baseRequestId || record.deltaDepth === 0) throw new Error(`Invalid LLM request journal delta for ${requestId}`);
  const baseRecord = await store.getRequest(record.baseRequestId);
  if (!baseRecord || baseRecord.deltaDepth !== record.deltaDepth - 1) throw new Error(`Invalid LLM request journal delta ancestry for ${requestId}`);
  const base = await reconstructMessageIds(store, record.baseRequestId, seen);
  const commonPrefix = Number(record.commonPrefixLength);
  if (!Number.isInteger(commonPrefix) || commonPrefix < 0 || commonPrefix > base.length) throw new Error(`Invalid LLM request journal common prefix for ${requestId}`);
  return [...base.slice(0, commonPrefix), ...parseIds(record.appendedMessageObjectIds)];
}

async function objectValue<T>(store: LlmRequestJournalStore, objectId: string, expectedKind?: ObjectKind): Promise<T> {
  const record = await store.getObject(objectId);
  if (!record) throw new Error(`LLM request journal object ${objectId} not found`);
  assertObjectRecord(record);
  if (expectedKind && record.objectKind !== expectedKind) throw new Error(`LLM request journal object ${objectId} has kind ${record.objectKind}, expected ${expectedKind}`);
  return JSON.parse(record.payload) as T;
}

async function validateRequestManifest(store: LlmRequestJournalStore, requestId: string): Promise<void> {
  const record = await store.getRequest(requestId);
  if (!record) throw new Error(`LLM request journal request ${requestId} not found`);
  assertRequestRecord(record);
  const ids = await reconstructMessageIds(store, requestId);
  if (ids.length !== record.messageCount) throw new Error(`LLM journal reconstructed message count mismatch for ${requestId}`);
  const prompt = await objectValue<unknown>(store, record.promptObjectId, 'prompt');
  const schema = await objectValue<unknown>(store, record.toolSchemaObjectId, 'tool-schema');
  if (typeof prompt !== 'string') throw new Error(`LLM journal prompt object has invalid payload for ${requestId}`);
  if (!Array.isArray(schema)) throw new Error(`LLM journal tool-schema object has invalid payload for ${requestId}`);
  for (const id of ids) {
    const message = await objectValue<any>(store, id, 'message');
    if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) throw new Error(`LLM journal message object has invalid payload for ${requestId}`);
  }
}

export async function reconstructLlmRequestFromStore(store: LlmRequestJournalStore, requestId: string): Promise<ReconstructedLlmRequest> {
  const request = await store.getRequest(requestId);
  if (!request) throw new Error(`LLM request journal request ${requestId} not found`);
  assertRequestRecord(request);
  await validateRequestManifest(store, requestId);
  const ids = await reconstructMessageIds(store, requestId);
  const starts = await store.getAttemptStarts(requestId);
  const results = await store.getAttemptResults(requestId);
  const startsByAttempt = new Map<number, AttemptStartRecord>();
  const resultsByAttempt = new Map<number, AttemptResultRecord>();
  for (const start of starts) {
    assertAttemptStartRecord(start);
    if (start.requestId !== requestId || startsByAttempt.has(start.attempt)) throw new Error(`Invalid or duplicate LLM journal attempt start for ${requestId}`);
    startsByAttempt.set(start.attempt, start);
  }
  for (const result of results) {
    assertAttemptResultRecord(result);
    if (result.requestId !== requestId || !startsByAttempt.has(result.attempt) || resultsByAttempt.has(result.attempt)) {
      throw new Error(`Invalid, orphaned, or duplicate LLM journal attempt result for ${requestId}`);
    }
    resultsByAttempt.set(result.attempt, result);
  }
  return {
    requestId,
    sessionId: request.sessionId,
    purpose: request.purpose,
    iteration: request.iteration,
    createdAt: request.createdAt,
    systemPrompt: await objectValue<string>(store, request.promptObjectId, 'prompt'),
    toolDefinitions: await objectValue<ToolDefinition[]>(store, request.toolSchemaObjectId, 'tool-schema'),
    messages: await Promise.all(ids.map(id => objectValue<Message>(store, id, 'message'))),
    requestedModelKey: request.requestedModelKey,
    promptCacheKeyHash: request.promptCacheKeyHash,
    attempts: starts.map(start => ({ start, result: resultsByAttempt.get(start.attempt) })),
    completeness: 'complete',
  };
}

export async function validateLlmRequestJournalStore(store: LlmRequestJournalStore): Promise<{
  objects: number; requests: number; attemptStarts: number; attemptResults: number; reconstructedRequests: number;
}> {
  return store.withConsistentSnapshot(async () => {
    const counts = { objects: 0, requests: 0, attemptStarts: 0, attemptResults: 0, reconstructedRequests: 0 };
    for (const kind of ['object', 'request', 'attempt-start', 'attempt-result'] as const) {
      let cursor;
      do {
        const page = await store.scanRecords(kind, cursor, 500);
        for (const record of page.records) {
          assertRecord(record);
          if (record.kind === 'request') {
            await reconstructLlmRequestFromStore(store, record.requestId);
            counts.requests += 1;
            counts.reconstructedRequests += 1;
          } else if (record.kind === 'object') {
            counts.objects += 1;
          } else {
            if (!await store.getRequest(record.requestId)) throw new Error(`LLM journal ${record.kind} references missing request ${record.requestId}`);
            if (record.kind === 'attempt-start') counts.attemptStarts += 1;
            else counts.attemptResults += 1;
          }
        }
        cursor = page.records.length === 500 ? page.next : undefined;
      } while (cursor);
    }
    return counts;
  });
}

export async function initLlmRequestJournal(): Promise<void> { await getLlmRequestJournalStore(); }
export async function shutdownLlmRequestJournal(): Promise<void> { await closeLlmRequestJournalStore(); }

async function appendRecord(record: JournalRecord): Promise<void> {
  assertRecord(record);
  const store = await getLlmRequestJournalStore();
  writeFaultInjector?.(store.backend === 'sqlite' ? 'before-sqlite-write' : 'before-postgres-write', record);
  await store.appendRecords([record]);
}
async function ensureObject(objectKind: ObjectKind, value: unknown): Promise<string> {
  const payload = canonicalJournalJson(value);
  const objectId = sha256(`${objectKind}\0${payload}`);
  const store = await getLlmRequestJournalStore();
  if (!await store.hasObject(objectId)) await appendRecord({ v: 1, kind: 'object', objectId, objectKind, payload, createdAt: Date.now() });
  return objectId;
}

export async function beginLlmRequestJournal(args: { sessionId?: string; purpose?: LlmRequestPurpose; iteration?: number; systemPrompt: string; toolDefinitions: ToolDefinition[]; messages: Message[]; requestedModelKey: string; promptCacheKey: string }): Promise<{ requestId: string }> {
  const store = await getLlmRequestJournalStore();
  const promptObjectId = await ensureObject('prompt', args.systemPrompt);
  const toolSchemaObjectId = await ensureObject('tool-schema', args.toolDefinitions);
  const messageObjectIds: string[] = [];
  for (const message of args.messages) messageObjectIds.push(await ensureObject('message', message));
  const requestId = randomUUID();
  let baseRequestId: string | undefined; let commonPrefixLength = 0; let deltaDepth = 0;
  if (args.sessionId) {
    const prior = await store.getLatestRequestForSession(args.sessionId);
    if (prior && prior.deltaDepth < MAX_LLM_REQUEST_DELTA_DEPTH) {
      const priorIds = await reconstructMessageIds(store, prior.requestId);
      while (commonPrefixLength < priorIds.length && commonPrefixLength < messageObjectIds.length && priorIds[commonPrefixLength] === messageObjectIds[commonPrefixLength]) commonPrefixLength++;
      baseRequestId = prior.requestId; deltaDepth = prior.deltaDepth + 1;
    }
  }
  const record: RequestRecord = { v: 1, kind: 'request', requestId, sessionId: args.sessionId, purpose: args.purpose || 'low-level', iteration: args.iteration || 0, createdAt: Date.now(), promptObjectId, toolSchemaObjectId, requestedModelKey: args.requestedModelKey, promptCacheKeyHash: sha256(args.promptCacheKey), messageCount: messageObjectIds.length, deltaDepth, ...(baseRequestId ? { baseRequestId, commonPrefixLength, appendedMessageObjectIds: messageObjectIds.slice(commonPrefixLength) } : { checkpointMessageObjectIds: messageObjectIds }) };
  await appendRecord(record);
  return { requestId };
}
export async function appendLlmAttemptStart(args: Omit<AttemptStartRecord,'v'|'kind'|'eventId'|'startedAt'|'semanticPayloadSha256'> & { startedAt?: number; semanticPayload: unknown }): Promise<void> { const { semanticPayload, ...rest } = args; await appendRecord({ v:1,kind:'attempt-start',eventId:randomUUID(),startedAt:args.startedAt||Date.now(),...rest,semanticPayloadSha256:hashJournalValue(semanticPayload) }); }
export async function appendLlmAttemptResult(args: Omit<AttemptResultRecord,'v'|'kind'|'eventId'|'completedAt'> & { completedAt?: number }): Promise<void> { await appendRecord({ v:1,kind:'attempt-result',eventId:randomUUID(),completedAt:args.completedAt||Date.now(),...args }); }

export async function reconstructLlmRequest(requestId: string): Promise<ReconstructedLlmRequest | { requestId: string; completeness:'legacy-partial'; missing:string[] } | { requestId:string; completeness:'corrupt'; errors:string[] }> {
  const store = await getLlmRequestJournalStore();
  const request = await store.getRequest(requestId);
  if (!request) return { requestId, completeness:'legacy-partial', missing:['request-manifest','system-prompt','tool-schema','canonical-messages'] };
  try {
    return await reconstructLlmRequestFromStore(store, requestId);
  } catch (error:any) { return { requestId,completeness:'corrupt',errors:[error?.message||String(error)] }; }
}
export async function listLlmRequestJournal(options:{sessionId?:string;purpose?:LlmRequestPurpose;limit?:number;before?:LlmRequestJournalCursor}={}):Promise<LlmRequestJournalSummary[]>{const limit=Math.max(1,Math.min(1000,Math.floor(options.limit||100)));return (await getLlmRequestJournalStore()).listRequests({...options,limit});}

async function streamRecords(store:LlmRequestJournalStore,kind:LlmJournalRecordKind,onRecord:(record:JournalRecord)=>Promise<void>|void):Promise<number>{let cursor;let count=0;do{const page=await store.scanRecords(kind,cursor,500);for(const record of page.records){await onRecord(record);count++;}cursor=page.records.length===500?page.next:undefined;}while(cursor);return count;}

export async function exportLlmRequestJournalJsonl(outputPath:string):Promise<{records:number}>{const store=await getLlmRequestJournalStore();await fs.ensureDir(path.dirname(outputPath));const temporaryPath=`${outputPath}.${process.pid}.${Date.now()}.tmp`;const handle=await nodeFs.open(temporaryPath,'w',0o600);let records=0;try{await store.withConsistentSnapshot(async()=>{for(const kind of ['object','request','attempt-start','attempt-result'] as const)await streamRecords(store,kind,async record=>{await handle.write(`${JSON.stringify(record)}\n`);records++;});});await handle.sync();await handle.close();await fs.move(temporaryPath,outputPath,{overwrite:true});const dir=await nodeFs.open(path.dirname(outputPath),'r');try{await dir.sync();}finally{await dir.close();}return{records};}catch(error){await handle.close().catch(()=>{});await fs.remove(temporaryPath).catch(()=>{});throw error;}}

async function withJournalFileLock<T>(fn:()=>Promise<T>):Promise<T>{await fs.ensureDir(path.dirname(JOURNAL_PATH));let handle:Awaited<ReturnType<typeof nodeFs.open>>|null=null;while(!handle){try{handle=await nodeFs.open(JOURNAL_LOCK_PATH,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:Date.now()}));}catch(error:any){if(handle){await handle.close().catch((): void => {});handle=null;}if(error?.code!=='EEXIST')throw error;const owner=await nodeFs.readFile(JOURNAL_LOCK_PATH,'utf8').then(JSON.parse).catch((): null => null);let alive=false;if(Number.isInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);alive=true;}catch(e:any){if(e?.code==='EPERM')alive=true;}}if(!alive){const stat=await nodeFs.stat(JOURNAL_LOCK_PATH).catch((): null => null);if(stat&&Date.now()-stat.mtimeMs>30_000)await nodeFs.unlink(JOURNAL_LOCK_PATH).catch((): void => {});}await sleep(25);}}try{return await fn();}finally{await handle.close().catch((): void => {});await nodeFs.unlink(JOURNAL_LOCK_PATH).catch((): void => {});}}
function parseRecordStrict(line:string):JournalRecord{const value=JSON.parse(line);if(value?.v!==1||!['object','request','attempt-start','attempt-result'].includes(value.kind))throw new Error('Invalid legacy LLM request journal record kind');assertRecord(value);return value;}
export type LegacyLlmJournalMigrationSource={filePath:string;relativeStatePath:string;sha256:string;recordCount:number};
function legacySqliteStore():SqliteLlmRequestJournalStore{return new SqliteLlmRequestJournalStore(LLM_REQUEST_JOURNAL_DB_PATH);}
export async function migrateLegacyLlmRequestJournalToSqlite():Promise<LegacyLlmJournalMigrationSource[]>{if(LLM_REQUEST_JOURNAL_STORAGE_CONFIG.backend!=='sqlite'||!await fs.pathExists(JOURNAL_PATH))return[];return withJournalFileLock(async()=>{const store=legacySqliteStore();await store.initialize();try{let batch:JournalRecord[]=[];let count=0;const requests=new Set<string>();const flush=async()=>{if(!batch.length)return;const records=batch;batch=[];await store.appendRecords(records);for(const record of records){const stored=await store.getRecord(record);if(!stored||canonicalJournalJson(stored)!==canonicalJournalJson(record))throw new Error(`Legacy LLM request journal conflict for ${record.kind==='object'?record.objectId:record.kind==='request'?record.requestId:record.eventId}`);}};const reader=createInterface({input:fs.createReadStream(JOURNAL_PATH,{encoding:'utf8'}),crlfDelay:Infinity});for await(const raw of reader){const line=raw.trim();if(!line)continue;const record=parseRecordStrict(line);batch.push(record);if(record.kind==='request'||record.kind.startsWith('attempt'))requests.add((record as RequestRecord|AttemptStartRecord|AttemptResultRecord).requestId);count++;if(batch.length>=IMPORT_BATCH_SIZE)await flush();}await flush();for(const requestId of requests){const record=await store.getRequest(requestId);if(!record)throw new Error(`Legacy LLM attempt references missing request ${requestId}`);await validateRequestManifest(store,requestId);}await store.checkIntegrity();const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(JOURNAL_PATH))hash.update(chunk as Buffer);return[{filePath:JOURNAL_PATH,relativeStatePath:path.relative(STATE_DIR,JOURNAL_PATH),sha256:hash.digest('hex'),recordCount:count}];}finally{await store.close();}});}
export function markLlmJournalSqliteAuthority(migrationId:string):void{if(LLM_REQUEST_JOURNAL_STORAGE_CONFIG.backend!=='sqlite')return;const DatabaseSync=require('node:sqlite').DatabaseSync;const db=new DatabaseSync(LLM_REQUEST_JOURNAL_DB_PATH);try{db.exec('CREATE TABLE IF NOT EXISTS llm_journal_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');db.prepare('INSERT INTO llm_journal_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY,migrationId);}finally{db.close();}}
export function readLlmJournalSqliteAuthority(databasePath:string=LLM_REQUEST_JOURNAL_DB_PATH):string|undefined{const DatabaseSync=require('node:sqlite').DatabaseSync;const db=new DatabaseSync(databasePath,{readOnly:true});try{const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_journal_metadata'").get();if(!table)return undefined;const row=db.prepare('SELECT value FROM llm_journal_metadata WHERE key=?').get(LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_KEY);return typeof row?.value==='string'?row.value:undefined;}finally{db.close();}}
export function assertCurrentLlmJournalSqliteAuthority(databasePath:string=LLM_REQUEST_JOURNAL_DB_PATH):void{const authority=readLlmJournalSqliteAuthority(databasePath);if(authority!==LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_MIGRATION_ID)throw new Error(`LLM Journal SQLite source lacks the completed ${LLM_REQUEST_JOURNAL_SQLITE_AUTHORITY_MIGRATION_ID} authority marker; restore the active data root before cutover.`);}
export function hasLlmJournalSqliteAuthority(migrationId:string):boolean{if(LLM_REQUEST_JOURNAL_STORAGE_CONFIG.backend!=='sqlite')return true;return readLlmJournalSqliteAuthority()===migrationId;}

export function setLlmRequestJournalFaultInjectorForTests(injector:((phase:string,record:JournalRecord)=>void)|null):void{writeFaultInjector=injector;}
export async function getLlmRequestJournalStatsForTests(){const counts=await(await getLlmRequestJournalStore()).getCounts();return{objects:counts.objects,requests:counts.requests};}
export async function getLlmRequestManifestForTests(requestId:string){const r=await(await getLlmRequestJournalStore()).getRequest(requestId);return r?{deltaDepth:r.deltaDepth,checkpoint:!!r.checkpointMessageObjectIds,baseRequestId:r.baseRequestId}:null;}
async function testMutation<K extends keyof LlmRequestJournalStore>(key:K,...args:any[]):Promise<any>{const store=await getLlmRequestJournalStore();const operation=store[key] as any;if(typeof operation!=='function')throw new Error(`LLM Journal backend lacks test mutation ${String(key)}.`);return operation.apply(store,args);}
export async function replaceLlmJournalPromptPayloadForTests(id:string,payload:string):Promise<string>{return testMutation('replaceObjectPayloadForTests',id,payload);}
export async function replaceLlmJournalMessageCountForTests(id:string,count:number):Promise<number>{return testMutation('replaceRequestMessageCountForTests',id,count);}
export async function replaceLlmJournalCreatedAtForTests(ids:string[],time:number):Promise<void>{return testMutation('replaceRequestCreatedAtForTests',ids,time);}
export async function replaceLlmJournalRequestIdentityForTests(id:string,v:{purpose:string;promptCacheKeyHash:string;iteration:number}){return testMutation('replaceRequestIdentityForTests',id,v);}
export async function replaceLlmJournalAttemptStartHashForTests(id:string,hash:string){return testMutation('replaceAttemptStartHashForTests',id,hash);}
export async function replaceLlmJournalAttemptResultOutcomeForTests(id:string,outcome:string){return testMutation('replaceAttemptResultOutcomeForTests',id,outcome);}
export function resetLlmRequestJournalForTests():void{void closeLlmRequestJournalStore();resetLlmRequestJournalStoreForTests();}
