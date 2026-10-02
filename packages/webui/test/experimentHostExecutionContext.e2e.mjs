// Real admission execution-environment boundary and unchanged explicit exec cwd.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const repo = resolve('.')
const { createHostFixture, until } = await import(pathToFileURL(join(repo, 'packages/webui/test/experimentHostFixture.mjs')))
const { writeModelFixture } = await import(pathToFileURL(join(repo, 'packages/webui/test/experimentModelFixture.mjs')))
const fixture = await createHostFixture('execution-context')
const counts = new Map(), requests = []
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (req, res) => {
 let raw = ''; for await (const bytes of req) raw += bytes
 const body = JSON.parse(raw), key = [...JSON.stringify(body.input).matchAll(/CASE:([\w-]+)/g)].at(-1)?.[1]
 const n = counts.get(key) || 0; counts.set(key, n + 1); requests.push({key, n})
 const output = n === 0 ? [call('write-' + key, 'write', { filePath: key + '-write.txt', content: 'owned-' + key }), call('exec-' + key, 'exec', { command: `pwd > ${key}-pwd.txt; printf 'owned-${key}' > ${key}-exec.txt`, timeout: 3, ...(key === 'explicit-cwd' ? { cwd: 'intended' } : {}) })] : [message('DONE-' + key)]
 res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: randomUUID(), status: 'completed', output, usage: {input_tokens:10,output_tokens:3} } }) + '\n\n')
})
peer.listen(0,'127.0.0.1'); await once(peer,'listening')
await writeModelFixture(fixture.data, { default:'a', providers:{ a:{ providerType:'openai-responses', baseUrl:'http://127.0.0.1:'+peer.address().port, models:['wire'],contextLimit:20000 } } })
const state = join(fixture.data,'state'), sessions=join(state,'sessions'), intended=join(fixture.work,'intended');await mkdir(sessions,{recursive:true});await mkdir(intended)
const variants = [
 ['omitted',{}],['master',{currentNode:'master'}],['empty',{currentNode:'',cwd:''}],['null',{currentNode:null,cwd:null}],
 ['trimmed',{currentNode:'\ufeff master\t',cwd:'\ufeff \n'}],['default-cwd',{currentNode:'master',cwd:fixture.work+'/.'}],
 ['explicit-cwd',{currentNode:'master'}],['queued-default',{cwd:fixture.work},true],
 ['custom-cwd',{currentNode:'master',cwd:intended}],['remote',{currentNode:'owned-unavailable-node'}],
 ['remote-cwd',{currentNode:'owned-unavailable-node',cwd:intended}],['relative-cwd',{cwd:'work'}]
]
const blocked = new Set(['custom-cwd','remote','remote-cwd','relative-cwd'])
const rows=[]
for(const [id,patch,queued] of variants){
 const raw={sessionStateVersion:1,id,agent:'main',model:'a',verbose:false,busy:false,history:[],queue:queued?[{type:'user',parts:[{text:'CASE:'+id}]}]:[],stats:{totalCachedTokens:0,totalInputTokens:0,totalOutputTokens:0},nextMessageSeq:1,nextBlockId:1,meta:{messageCount:0,lastMessageTime:0},promptCacheKey:randomUUID(),persistentMemorySnapshot:'Owned existing snapshot',...patch}
 await writeFile(join(sessions,id+'.json'),JSON.stringify(raw));rows.push({id,agent:'main',busy:false,queueLength:queued?1:0,model:'a',meta:raw.meta,...patch})
}
const { SessionCatalogStore }=await import(pathToFileURL(join(repo,'lib/session/catalogStore.js')));const catalog=new SessionCatalogStore(join(state,'catalog.sqlite'));catalog.initializeEmpty();catalog.replaceAll(rows);catalog.close()
const seed=join(fixture.root,'seed.json');await writeFile(seed,JSON.stringify(rows));execFileSync('node',[join(repo,'dotnet/session-catalog-seed-ts.mjs'),fixture.data,seed],{env:{...process.env,FOXWARM_TS_ROOT:repo}})
const exists=p=>access(p).then(()=>true,()=>false); const results=[]
try {
 await fixture.start()
 const exact = async id => {
  const reply = await fixture.api('POST','/api/session-list/by-id',{ids:[id]}); assert.equal(reply.status,200)
  return reply.body.results[0].session
 }
 for(const [id,patch,queued] of variants){
  const original=await readFile(join(sessions,id+'.json'),'utf8'), prior=requests.length
  const cold = await exact(id); const before=await fixture.api('GET','/api/sessions/'+id+'/history')
  if(blocked.has(id)) {
   assert.equal(before.status,500);assert.match(JSON.stringify(before.body),/does not support this Session's execution environment/)
   assert.equal((await fixture.api('POST','/api/sessions/'+id+'/message',{text:'CASE:'+id})).status,500)
   assert.equal((await fixture.api('POST','/api/sessions/'+id+'/name',{name:'Still metadata'})).status,200)
   assert.equal(requests.length,prior);assert.equal(await readFile(join(sessions,id+'.json'),'utf8'),original)
   assert.equal(await exists(join(fixture.work,id+'-write.txt')),false);assert.equal(await exists(join(fixture.work,id+'-exec.txt')),false)
   assert.equal(await exists(join(intended,id+'-write.txt')),false);assert.equal(await exists(join(intended,id+'-exec.txt')),false)
   const retained=await exact(id);assert.equal(retained.currentNode,cold.currentNode);assert.equal(retained.cwd,cold.cwd)
   results.push({id,blockedBeforeProviderAndEffect:true,preservedAuthority:true,preservedMetadata:true});continue
  }
  assert.equal(before.status,200)
  const warm=await exact(id); assert.equal(warm.currentNode,cold.currentNode); assert.equal(warm.cwd,cold.cwd)
  if(!queued)assert.equal((await fixture.api('POST','/api/sessions/'+id+'/message',{text:'CASE:'+id})).status,202)
  await until(async()=>{const h=await fixture.api('GET','/api/sessions/'+id+'/history');return h.body.messages.some(row=>row.parts?.some(part=>part.text==='DONE-'+id))},id+' paired done')
  const h=(await fixture.api('GET','/api/sessions/'+id+'/history')).body.messages
  const paired=h.flatMap(row=>row.parts||[]).filter(part=>part.functionResponse)
  assert.equal(paired.length,2);assert(paired.every(part=>!part.functionResponse.response.error))
  const actual=JSON.parse(await readFile(join(sessions,id+'.json'),'utf8'));for(const [key,value] of Object.entries(patch))assert.equal(actual[key],value)
  const execRoot=id==='explicit-cwd'?intended:fixture.work
  assert.equal((await readFile(join(execRoot,id+'-pwd.txt'),'utf8')).trim(),execRoot)
  assert.equal(await exists(join(fixture.work,id+'-write.txt')),true);assert.equal(await exists(join(execRoot,id+'-exec.txt')),true)
  results.push({id,queued:Boolean(queued),pairedCalls:paired.length,preservedMetadata:true,preservedContext:true,execRoot})
 }
 await fixture.stop()
 // Real indexed queue startup must validate every mandatory context before any sibling request/effect.
 const bootRows=[]
 for(const [id,node] of [['mandatory-good','master'],['mandatory-bad','owned-unavailable-node']]){
  const raw={sessionStateVersion:1,id,agent:'main',model:'a',verbose:false,busy:false,history:[],queue:[{type:'user',parts:[{text:'CASE:'+id}]}],stats:{totalCachedTokens:0,totalInputTokens:0,totalOutputTokens:0},nextMessageSeq:1,nextBlockId:1,meta:{messageCount:0,lastMessageTime:0},promptCacheKey:randomUUID(),persistentMemorySnapshot:'Existing snapshot',currentNode:node}
  await writeFile(join(sessions,id+'.json'),JSON.stringify(raw));bootRows.push({id,agent:'main',model:'a',busy:false,queueLength:1,meta:raw.meta,currentNode:node})
 }
 const bootCatalog=new SessionCatalogStore(join(state,'catalog.sqlite'));bootCatalog.upsertMany(bootRows);bootCatalog.close()
 const bootSeed=join(fixture.root,'boot-seed.json');await writeFile(bootSeed,JSON.stringify(bootRows));execFileSync('node',[join(repo,'dotnet/session-catalog-seed-ts.mjs'),fixture.data,bootSeed],{env:{...process.env,FOXWARM_TS_ROOT:repo}})
 const bootBefore=await Promise.all(bootRows.map(row=>readFile(join(sessions,row.id+'.json'),'utf8'))), requestCount=requests.length
 await assert.rejects(()=>fixture.start(),/does not support this Session's execution environment/)
 await new Promise(done=>setTimeout(done,100));assert.equal(requests.length,requestCount)
 for(let i=0;i<bootRows.length;i++){
  assert.equal(await readFile(join(sessions,bootRows[i].id+'.json'),'utf8'),bootBefore[i]);assert.equal(await exists(join(fixture.work,bootRows[i].id+'-exec.txt')),false)
 }
 const repaired=JSON.parse(bootBefore[1]);repaired.currentNode='master';await writeFile(join(sessions,'mandatory-bad.json'),JSON.stringify(repaired))
 await fixture.start()
 for(const row of bootRows)await until(async()=>{const h=await fixture.api('GET','/api/sessions/'+row.id+'/history');return h.body.messages.some(message=>message.parts?.some(part=>part.text==='DONE-'+row.id))},row.id+' after actual repair')
 await fixture.stop();console.log(JSON.stringify({ok:true,root:fixture.root,hostPids:fixture.hostPids,peerPid:process.pid,requests:requests.length,mandatoryGlobalFailureBeforeSiblingEffects:true,repairRetry:true,results},null,2))
} finally {await fixture.cleanup();await new Promise(done=>peer.close(done))}
