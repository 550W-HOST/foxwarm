import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionNoticeMessage, isSystemFailurePublished, markSystemFailurePublished } from './sessionNotices';
import { parseSessionNotice } from '../packages/shared/dist/sessionNotice';
import { parseSessionControlFeedback, getSessionControlAction } from '../packages/shared/dist/sessionControlFeedback';
import { replySessionControl } from './commands/sessionControlFeedback';
import { isModelVisibleMessage } from './session/messageVisibility';

test('system failures preserve diagnostics as display-only, bounded typed events', () => {
  const message = createSessionNoticeMessage({source:'compaction',severity:'error',title:'Compaction failed',summary:'No valid plan.',details:'diagnostic '.repeat(4000)});
  assert.equal(message.role,'model'); assert.equal(isModelVisibleMessage(message),false);
  assert.equal(message.__meta?.noticeType,'system-event');
  const event = parseSessionNotice(message.__meta?.sessionNotice);
  assert.equal(event?.source,'compaction'); assert.ok((event?.details?.length || 0)<=32768);
  assert.match(event?.details || '',/truncated/);
  assert.equal(message.parts[0].text,'diagnostic '.repeat(4000));
  assert.equal(parseSessionNotice({ ...event, severity:{toString(){throw Error('must not coerce')}} }),null);
  assert.equal(parseSessionNotice({ ...event, details:'x'.repeat(32769) }),null);
  assert.equal(parseSessionNotice({ ...event, version:2 }),null);
  assert.equal((parseSessionNotice({ ...event, unexpected:true }) as any)?.unexpected,undefined);
});

test('failure deduplication is scoped to the exact Session and works for immutable errors', () => {
  const error=Object.freeze(new Error('synthetic failure'));
  assert.equal(isSystemFailurePublished('one',error),false);
  markSystemFailurePublished('one',error);
  assert.equal(isSystemFailurePublished('one',error),true);
  assert.equal(isSystemFailurePublished('two',error),false);
  assert.equal(isSystemFailurePublished('one',new Error('synthetic failure')),false);
  markSystemFailurePublished('two',error);
  assert.equal(isSystemFailurePublished('two',error),true);
});

test('control intents and feedback use explicit closed metadata rather than receipt text', () => {
  for (const [command,action] of [[' /stop ','stop'],['/stop compact','cancel-compaction'],['/continue','continue'],['/dequeue','dequeue'],['/compact 90','compact'],['/compact tools 0.01','compact']] as const) assert.equal(getSessionControlAction(command),action);
  for (const text of ['hello','/stop compact extra','/stopall']) assert.equal(getSessionControlAction(text),null);
  assert.equal(getSessionControlAction('/continue later'),'continue');
  const feedback={action:'stop',status:'accepted',message:'Stop requested'};
  assert.deepEqual(parseSessionControlFeedback({...feedback,privateField:true}),feedback);
  assert.equal(parseSessionControlFeedback({...feedback,status:'stopped'}),null);
  assert.equal(parseSessionControlFeedback({...feedback,action:{toString(){throw Error('must not coerce')}}}),null);
  const replies:any[]=[];
  const ctx:any={channelType:'webui',reply:(...args:any[])=>replies.push(args)};
  replySessionControl(ctx,'stop',{status:'accepted',message:'Stop requested'},'legacy receipt');
  assert.deepEqual(replies[0],['Stop requested',{sessionControlFeedback:feedback}]);
  ctx.channelType='telegram';
  replySessionControl(ctx,'stop',{status:'accepted',message:'Stop requested'},'legacy receipt');
  assert.deepEqual(replies[1],['legacy receipt']);
});
