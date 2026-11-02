import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const dir=mkdtempSync(join(tmpdir(),'session-communications-')),file=join(dir,'bundle.cjs')
build({entryPoints:[new URL('../src/components/sessionCommunications.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',outfile:file,logLevel:'silent'}).then(()=>{
 const {projectSessionCommunications,receivedSessionCommunication}=createRequire(import.meta.url)(file)
 test('structured incoming messages retain the sender and strip only their transport envelope',()=>{
  const input={role:'user',parts:[{system:'<foxwarm-message type="inter-agent" sourceSessionId="review/main">\nReport\n<foxwarm-system kind="quoted-example">\nKeep this authored example.\n</foxwarm-system>\n</foxwarm-message>'}]}
  const received=receivedSessionCommunication(input)
  assert.equal(received.peerSessionId,'review/main');assert.match(received.message,/^Report/);assert.match(received.message,/<foxwarm-system/);assert.doesNotMatch(received.message,/<\/foxwarm-message>/)
  assert.equal(receivedSessionCommunication({role:'user',parts:[{text:input.parts[0].system}]}),null)
 })
 test('delivery correlation attributes and evidence fields leave cards unchanged',()=>{
  const received=receivedSessionCommunication({role:'user',parts:[{system:'<foxwarm-message type="inter-agent" sourceSessionId="lead/main" deliverySeq="42.2.1" replyTargetSessionId="lead/main" replyVia="send_to_session" time="2026-11-02 10:00:00 +0800" hint="inter-agent message from another session, not direct end-user input">\nCheck the build\n</foxwarm-message>'}]})
  assert.deepEqual(received,{key:'received',direction:'received',peerSessionId:'lead/main',message:'Check the build'})
  const call={role:'model',parts:[{functionCall:{id:'d',name:'send_to_session',args:{sessionId:'worker/main',message:'Check the build'}}}]}
  const result={role:'tool',parts:[{functionResponse:{tool_use_id:'d',response:{output:'ok'},__meta:{sessionMessages:[{id:'d',targetSessionId:'worker/main',message:'Check the build',deliverySeq:'42'}]}}}]}
  const [card]=projectSessionCommunications([call,result]).get(result)
  assert.equal(card.peerSessionId,'worker/main');assert.equal(card.message,'Check the build');assert.equal(card.direction,'sent')
 })
 test('successful direct and builtin-dispatched sends preserve exact body and do not promote failures or stdout',()=>{
  const call=(id,name,args)=>({role:'model',parts:[{functionCall:{id,name,args}}]})
  const result=(id,response,meta)=>({role:'tool',parts:[{functionResponse:{tool_use_id:id,name:'send_to_session',response,__meta:meta}}]})
  const messages=[call('a','send_to_session',{sessionId:'review/main',message:'hello'}),result('a',{output:'done'}),call('b','call_tool',{source:'builtin',name:'send_to_session',args:{sessionId:'analysis/main',message:'inspect'}}),result('b',{output:'done'}),call('c','send_to_session',{sessionId:'bad',message:'not sent'}),result('c',{error:'denied'}),call('d','run_script',{code:'print("Message sent to session")'}),result('d',{output:'Message sent to session `fake`'})]
  const projection=projectSessionCommunications(messages)
  assert.equal(projection.size,2);assert.equal(projection.get(messages[1])[0].message,'hello');assert.equal(projection.get(messages[3])[0].peerSessionId,'analysis/main')
  assert.deepEqual(messages[0].parts[0].functionCall.args,{sessionId:'review/main',message:'hello'})
 })
 test('canceled and absent direct receipts do not become sent cards, while actual delivery metadata remains authoritative', () => {
  for (const name of ['send_to_session', 'functions.send_to_session', 'call_tool']) {
   for (const response of [{ canceled: true, message: 'Tool call canceled before execution.' }, { error: 'Tool call was not started because Stop cancelled it; it was not executed.' }, undefined]) {
    const args = { sessionId: 'peer/main', message: 'Not delivered' }
    const call = { role: 'model', parts: [{ functionCall: { id: 'cancel', name, args: name === 'call_tool' ? { toolId: 'builtin:send_to_session', args } : args } }] }
    const result = { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'cancel', response } }] }
    assert.equal(projectSessionCommunications([call, result]).size, 0)
    result.parts[0].functionResponse.__meta = { sessionMessages: [{ id: 'delivered', targetSessionId: 'resolved/main', message: 'Already delivered' }] }
    assert.deepEqual(projectSessionCommunications([call, result]).get(result), [{ key: 'delivered', direction: 'sent', peerSessionId: 'resolved/main', message: 'Already delivered' }])
   }
  }
 })
 test('canonical targets and script deliveries use out-of-band metadata, preserve distinct sends, and work across a viewport cut',()=>{
  const call={role:'model',parts:[{functionCall:{id:'one',name:'send_to_session',args:{sessionId:'<parent>',message:'full body'}}}]}
  const response={role:'tool',parts:[{functionResponse:{tool_use_id:'one',response:{output:'ok'},__meta:{sessionMessages:[{id:'one',targetSessionId:'parent/main',message:'full',truncated:true}]}}}]}
  const scripts={role:'tool',parts:[{functionResponse:{tool_use_id:'script',response:{output:'ok'},__meta:{toolScriptSubCalls:[{id:'a',status:'completed',sessionMessage:{targetSessionId:'same/main',message:'same'}},{id:'b',status:'completed',sessionMessage:{targetSessionId:'same/main',message:'same'}},{id:'c',status:'failed',sessionMessage:{targetSessionId:'bad',message:'not sent'}}]}}}]}
  const projection=projectSessionCommunications([response,scripts],[call,response,scripts])
  assert.deepEqual(projection.get(response),[{key:'one',direction:'sent',peerSessionId:'parent/main',message:'full body'}])
  assert.equal(projection.get(scripts).length,2)
 })
}).finally(()=>rmSync(dir,{recursive:true,force:true}))
