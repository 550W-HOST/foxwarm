import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const dir=mkdtempSync(join(tmpdir(),'session-communications-')),file=join(dir,'bundle.cjs')
build({entryPoints:[new URL('../src/components/sessionCommunications.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'cjs',outfile:file,logLevel:'silent'}).then(()=>{
 const {projectSessionCommunications,receivedSessionCommunication,taskMessageLayout}=createRequire(import.meta.url)(file)
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

 const envelope=(attrs,body)=>`<foxwarm-message ${attrs}>\n${body}\n</foxwarm-message>`
 const taskMessage=(attrs,body='Body')=>({role:'user',parts:[{system:envelope(`type="task" ${attrs}`,body)}]})
 const assignHint='hint="Task assignment from Foxwarm, not direct user input. Complete this task with the task tool."'
 test('Task notices that hand over work, a note or a result become received Task communications in any attribute order',()=>{
  const assigned=receivedSessionCommunication(taskMessage(`time="t" taskId="task_1" event="assigned" recipient="owner" sourceSessionId="lead/main" deliverySeq="4" ${assignHint}`,'You have been assigned a task: task_1 — Title'))
  assert.deepEqual(assigned,{key:'received',direction:'received',peerSessionId:'lead/main',message:'You have been assigned a task: task_1 — Title',task:{taskId:'task_1',event:'assigned',recipient:'owner'}})
  assert.equal(receivedSessionCommunication(taskMessage('sourceSessionId="w/main" event="completed" taskId="task_1" recipient="creator"')).task.event,'completed')
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_1" event="note" recipient="owner" sourceSessionId="lead/main"')).task.recipient,'owner')
  assert.equal(receivedSessionCommunication(taskMessage(`taskId="task_1" event="transferred" recipient="owner" sourceSessionId="lead/main" ${assignHint}`)).task.recipient,'owner')
  // A previous owner's notice stays process detail.
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_1" event="transferred" recipient="previous-owner" sourceSessionId="lead/main"')),null)
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_1" event="released" recipient="previous-owner" sourceSessionId="lead/main"')),null)
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_1" event="cancelled" sourceSessionId="lead/main"')),null)
 })
 test('envelopes before the recipient attribute take the role from the event and, for a transfer, the trusted hint',()=>{
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_1" event="assigned" sourceSessionId="lead/main"')).task.recipient,'owner')
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_1" event="completed" sourceSessionId="w/main"')).task.recipient,'creator')
  assert.equal(receivedSessionCommunication(taskMessage(`taskId="task_1" event="transferred" sourceSessionId="lead/main" ${assignHint}`)).task.recipient,'owner')
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_1" event="transferred" sourceSessionId="lead/main" hint="task notification from Foxwarm; not direct user input"')),null)
  // The hint is the outer attribute only: a quoted envelope in the body changes nothing.
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_1" event="transferred" sourceSessionId="lead/main" hint="task notification from Foxwarm; not direct user input"',`Body\n${envelope(`type="task" ${assignHint}`,'quoted')}`)),null)
 })
 test('user-sourced Task notices come from the user, not a Session',()=>{
  const fromUser=receivedSessionCommunication(taskMessage('taskId="task_9" event="assigned" recipient="owner" time="t" hint="task notification from an authenticated user" sourceKind="user"'))
  assert.equal(fromUser.origin,'user');assert.equal(fromUser.peerSessionId,'');assert.equal(fromUser.task.taskId,'task_9')
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_9" event="assigned"')),null)
  // An older user-sourced transfer names no role and stays in Activity.
  assert.equal(receivedSessionCommunication(taskMessage('taskId="task_9" event="transferred" sourceKind="user" hint="task notification from an authenticated user"')),null)
 })
 test('the first input of a Session reads its envelope part beside the Session tag',()=>{
  const first={role:'user',parts:[{system:'<foxwarm-system kind="session" currentSessionId="peer" currentNode="master" />'},{system:envelope('type="inter-agent" sourceSessionId="lead/main" deliverySeq="2"','Hello')}]}
  assert.deepEqual(receivedSessionCommunication(first),{key:'received',direction:'received',peerSessionId:'lead/main',message:'Hello'})
  const task={role:'user',parts:[first.parts[0],{system:envelope('type="task" taskId="task_1" event="assigned" recipient="owner" sourceSessionId="lead/main"','Work')}]}
  assert.equal(receivedSessionCommunication(task).task.event,'assigned')
  // Text parts or a second envelope are not a single trusted delivery.
  assert.equal(receivedSessionCommunication({role:'user',parts:[first.parts[1],{text:'typed'}]}),null)
  assert.equal(receivedSessionCommunication({role:'user',parts:[first.parts[1],first.parts[1]]}),null)
  const child={role:'user',parts:[{system:'<foxwarm-system kind="session-boundary" event="new-child" parentSessionId="lead/main" currentSessionId="peer" time="t" />'},first.parts[0],first.parts[1]]}
  assert.equal(receivedSessionCommunication(child).message,'Hello')
  // Other system content beside an envelope, such as a compaction boundary, is not a single delivery.
  assert.equal(receivedSessionCommunication({role:'user',parts:[{system:'<foxwarm-system kind="session-boundary" event="compact-completed" currentSessionId="peer" />'},first.parts[1]]}),null)
  assert.equal(receivedSessionCommunication({role:'user',parts:[{system:'<foxwarm-system kind="session" currentSessionId="peer" />\nExtra'},first.parts[1]]}),null)
 })
 test('delivery lists project every Task and send of a call, subcall, nested run and background finish, folding previous owners',()=>{
  const task=(event,recipient)=>({taskId:'task_1',event,title:'Title',recipient})
  const direct={role:'tool',parts:[{functionResponse:{tool_use_id:'assign',response:{taskId:'task_1',sentNotifications:2},__meta:{sessionMessages:[
   {id:'assign',targetSessionId:'old/main',message:'Task ownership transferred',task:task('transferred','previous-owner')},
   {id:'assign#2',targetSessionId:'new/main',message:'You have been assigned a task',task:task('transferred','owner')}]}}}]}
  const script={role:'tool',parts:[{functionResponse:{tool_use_id:'script',response:{status:'failed'},__meta:{toolScriptSubCalls:[
   {id:'tsc_a',name:'run_script',status:'completed',sessionMessages:[{id:'tsc_a',targetSessionId:'child/main',message:'Assignment',task:task('assigned','owner')},{id:'tsc_a#2',targetSessionId:'peer/main',message:'Heads-up'}]},
   {id:'tsc_b',name:'task',status:'failed',sessionMessages:[{id:'tsc_b',targetSessionId:'peer/main',message:'Delivered before the failure',task:task('note','owner')}]}]}}}]}
  const background={role:'user',parts:[{system:'<foxwarm-system kind="event" type="background-script-finished">\nrunId: tsr_1\nstatus: completed\n</foxwarm-system>'}],__meta:{sessionMessages:[{id:'tsc_c',targetSessionId:'peer/main',message:'After the hand-off'}]}}
  const projection=projectSessionCommunications([direct,script,background])
  assert.deepEqual(projection.get(direct),[{key:'assign#2',direction:'sent',peerSessionId:'new/main',message:'You have been assigned a task',task:task('transferred','owner')}])
  assert.deepEqual(projection.get(script).map(item=>[item.key,item.peerSessionId,item.task?.event]),[['tsc_a','child/main','assigned'],['tsc_a#2','peer/main',undefined],['tsc_b','peer/main','note']])
  assert.deepEqual(projection.get(background),[{key:'tsc_c',direction:'sent',peerSessionId:'peer/main',message:'After the hand-off',origin:'background'}])
  // Malformed task evidence is not shown.
  const malformed={role:'tool',parts:[{functionResponse:{tool_use_id:'x',response:{},__meta:{sessionMessages:[{id:'x',targetSessionId:'p',message:'m',task:{taskId:'t'}}]}}}]}
  assert.equal(projectSessionCommunications([malformed]).has(malformed),false)
 })

 test('generated Task lead lines give the header title and the preview starts at the content',()=>{
  const card=(event,message,extra={})=>({key:'k',direction:'received',peerSessionId:'lead/main',message,task:{taskId:'task_1',event,recipient:event==='completed'?'creator':'owner'},...extra})
  assert.deepEqual(taskMessageLayout(card('assigned','You have been assigned a task: task_1 — Review — the cards\nStatus: active\nRead the change.\n\nAdditional instruction:\nUse the harness.')),{title:'Review — the cards',preview:'Read the change.\n\nAdditional instruction:\nUse the harness.'})
  assert.deepEqual(taskMessageLayout(card('transferred','You have been assigned a task: task_1 — Review\nStatus: active\n\nAdditional instruction:\nGo')),{title:'Review',preview:'Additional instruction:\nGo'})
  assert.deepEqual(taskMessageLayout(card('completed','Task completed: task_1 — Review\nStatus: completed\n## Result\nDone.\nTask owner usage: wire; estimated cost $0.01 USD.')),{title:'Review',preview:'## Result\nDone.\nTask owner usage: wire; estimated cost $0.01 USD.'})
  assert.deepEqual(taskMessageLayout(card('note','Note on task task_1 — Review\nIs the old format still read?')),{title:'Review',preview:'Is the old format still read?'})
  // Nothing after the lead: the title still shows and the body is not replaced.
  assert.deepEqual(taskMessageLayout(card('assigned','You have been assigned a task: task_1 — Review\nStatus: open')),{title:'Review',preview:null})
  // The sender reads the title from its delivery record.
  assert.equal(taskMessageLayout({...card('assigned','You have been assigned a task: task_1 — Review\nStatus: active\nBody'),direction:'sent',task:{taskId:'task_1',event:'assigned',recipient:'owner',title:'Recorded'}}).title,'Recorded')
  // Other forms, another Task's ID, truncated bodies and non-Task cards keep the body unchanged with no title.
  for (const message of ['Please review task_1 — Review\nStatus: active','You have been assigned a task: task_2 — Review\nStatus: active\nBody','You have been assigned a task: task_1 — Review\nBody without status','You have been assigned a task: task_1 — \nStatus: active\nBody'])
   assert.equal(taskMessageLayout(card('assigned',message)),null,message)
  assert.equal(taskMessageLayout(card('assigned','You have been assigned a task: task_1 — Review\nStatus: active\nBody',{truncated:true})),null)
  assert.equal(taskMessageLayout({key:'k',direction:'received',peerSessionId:'p',message:'You have been assigned a task: task_1 — Review\nStatus: active\nBody'}),null)
 })
}).finally(()=>rmSync(dir,{recursive:true,force:true}))
