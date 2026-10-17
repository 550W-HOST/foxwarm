import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTools } from './toolExecutor';
import * as sessions from './sessionManager';
import { shutdownToolScriptRuntime } from './toolscript';
import { INTER_AGENT_HANDOFF_RECALL_PREFIX, INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX, INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX } from './toolCallControls';

const confirmation = {
  handoffRecall: `${INTER_AGENT_HANDOFF_RECALL_PREFIX}\nI recalled the applicable communication rules and the recipient scope for this test.`,
  handoffConfirmation: `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\nThe message was checked for necessity, accuracy, scope, self-containment and communication rules.\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}`,
};

test('real direct, unified and ToolScript sends persist canonical UI deliveries without changing visible results or delivery count', async () => {
  const nonce=`${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const sourceId=`presentation_source_${nonce}`,targetId=`presentation_target_${nonce}`;
  const source=await sessions.getSession(sourceId), target=await sessions.getSession(targetId);
  source.parentSessionId=targetId;
  await sessions.saveSession(sourceId);
  const args={sessionId:'<parent>',message:'Please review the paired measurements.',...confirmation};
  try {
    for (const unified of [false,true]) {
      const id=unified?'unified':'direct';
      const batch=await executeTools([{id,name:unified?'call_tool':'send_to_session',args:unified?{source:'builtin',name:'send_to_session',args}:args}],{sessionId:sourceId},source);
      const response=batch.message.parts.find(part=>part.functionResponse)!.functionResponse!;
      assert.ok(!response.response.error,JSON.stringify(response.response));
      assert.deepEqual(response.__meta?.sessionMessages,[{id,targetSessionId:targetId,message:args.message}]);
      assert.equal(JSON.stringify(response.response).includes('sessionMessages'),false);
      assert.equal(JSON.stringify(response.response).includes('__toolPostAction'),false);
    }
    const batch=await executeTools([{id:'script',name:'run_script',args:{code:`return call_tool("builtin:send_to_session", ${JSON.stringify(args)})`}}],{sessionId:sourceId},source);
    const response=batch.message.parts.find(part=>part.functionResponse)!.functionResponse!;
    assert.ok(!response.response.error,JSON.stringify(response.response));
    const subCall=response.__meta?.toolScriptSubCalls?.find(item=>item.sessionMessage);
    assert.deepEqual(subCall?.sessionMessage,{targetSessionId:targetId,message:args.message});
    assert.match(response.response.result.output,/^Message sent to session/);
    assert.equal(JSON.stringify(response.response).includes('sessionMessage'),false);
    assert.equal((await sessions.getSession(targetId)).queue.filter(item=>item.sourceSessionId===sourceId).length,3);
    assert.equal(target.id,targetId);
  }finally{
    await shutdownToolScriptRuntime();
    await sessions.deleteSession(sourceId).catch(()=>{});await sessions.deleteSession(targetId).catch(()=>{});
  }
});
