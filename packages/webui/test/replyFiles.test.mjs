import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundle = await build({entryPoints:[new URL('../src/components/replyFiles.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false})
const {buildReplyFileGroups}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const file=(id,extra={})=>({version:1,deliveryId:id,targetKind:'session',targetId:'demo/main',fileName:'report.png',mimeType:'image/png',sizeBytes:123,downloadPath:'/cache/report.png',downloadNodeId:'master',sourceNodeId:'remote-a',...extra})
const input=text=>({role:'user',parts:[{text}]})
const output=text=>({role:'model',parts:[{text}]})
const sent=(id,artifact,extra={})=>({role:'tool',parts:[{functionResponse:{name:'send_file',tool_use_id:id,response:{fileDelivery:artifact,...extra}}}]})

test('receipts appear immediately, follow the reply tail, retain distinct same-name deliveries, and stay in their input-bounded span',()=>{
 const first=sent('call-a',file('a')), second=sent('call-b',file('b',{downloadPath:'/cache/second.png'}))
 assert.equal(buildReplyFileGroups([input('request'),first],'demo/main')[0].endIndex,1)
 const groups=buildReplyFileGroups([input('request'),first,second,output('answer'),input('next'),sent('call-c',file('c')),output('next answer')],'demo/main')
 assert.deepEqual(groups.map(g=>[g.startIndex,g.endIndex,g.files.map(f=>f.deliveryId)]),[[0,3,['a','b']],[4,6,['c']]])
 assert.equal(groups[0].key,buildReplyFileGroups([input('request'),first],'demo/main')[0].key)
 assert.deepEqual(buildReplyFileGroups([first,first],'demo/main')[0].files.map(f=>f.deliveryId),['a'])
})
test('only successful current-target deliveries are exposed, never writes, model prose, failed sends, or other destinations',()=>{
 const cases=[sent('x',file('other',{targetId:'elsewhere/main'})),sent('x',file('telegram',{targetKind:'channel',targetId:'telegram:room'})),sent('x',file('failure'),{error:'failed'}),{role:'tool',parts:[{functionResponse:{name:'write',tool_use_id:'w',response:{fileDelivery:file('fake')}}}]},output(JSON.stringify({fileDelivery:file('prose')}))]
 for(const value of cases)assert.deepEqual(buildReplyFileGroups([value],'demo/main'),[])
 assert.equal(buildReplyFileGroups([sent('x',file('webui',{targetKind:'channel',targetId:'webui:demo/main'}))],'demo/main')[0].files.length,1)
 for(const patch of [{downloadNodeId:'remote-a'},{downloadPath:'relative'},{sizeBytes:-1},{fileName:'../bad'},{version:2}])assert.deepEqual(buildReplyFileGroups([sent('bad',file('invalid',patch))],'demo/main'),[])
})
test('structured ToolScript and unified-tool receipts survive nested returns without parsing stdout',()=>{
 const msg={role:'tool',parts:[{functionResponse:{name:'run_script',tool_use_id:'s',response:{result:{files:[{fileDelivery:file('a')},{fileDelivery:file('b')}],stdout:JSON.stringify({fileDelivery:file('not-a-receipt')})}}}}]}
 assert.deepEqual(buildReplyFileGroups([msg],'demo/main')[0].files.map(f=>f.deliveryId),['a','b'])
})
test('legacy direct sends use paired intent and structured fullPath without guessing text success or inventing sizes',()=>{
 const call={role:'model',parts:[{functionCall:{id:'old',name:'send_file',args:{filePath:'chart.png'}}}]}
 const result={role:'tool',parts:[{functionResponse:{name:'send_file',tool_use_id:'old',response:{fullPath:'/files/chart.png',output:'legacy receipt'}}}]}
 const legacy=buildReplyFileGroups([call,result],'demo/main')[0].files[0]
 assert.equal(legacy.fileName,'chart.png');assert.equal(legacy.mimeType,'image/png');assert.equal(legacy.sizeBytes,undefined)
 assert.deepEqual(buildReplyFileGroups([result],'demo/main'),[])
 assert.deepEqual(buildReplyFileGroups([{...call,parts:[{functionCall:{...call.parts[0].functionCall,args:{sessionId:'other',filePath:'chart.png'}}}]},result],'demo/main'),[])
})
