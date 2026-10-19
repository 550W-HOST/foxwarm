import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { readArchiveMessages, readLocalArchiveMessages } from './archive';

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('forked and new child Sessions do not inherit an existing handoff boundary', async () => {
  const sourceId = id('child_handoff_fork_source');
  const source = await sessionManager.getSession(sourceId);
  source.childHandoffState = { boundary: 'report-required', resolved: false };
  await sessionManager.saveSession(sourceId);
  let forkId: string | undefined;
  let childId: string | undefined;
  try {
    forkId = await sessionManager.forkSession(sourceId, 'fork');
    childId = await sessionManager.createChildSession(sourceId, 'new-child', false);
    assert.equal((await sessionManager.getSession(forkId)).childHandoffState, undefined);
    assert.equal((await sessionManager.getSession(childId)).childHandoffState, undefined);
    assert.deepEqual((await sessionManager.getSession(sourceId)).childHandoffState, {
      boundary: 'report-required', resolved: false,
    });
  } finally {
    if (forkId) await sessionManager.deleteSession(forkId).catch(() => false);
    if (childId) await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});

test('new and forked children append identity and instructions without inventing model confirmation', async () => {
  const sourceId = id('child_confirmation_source');
  const source = await sessionManager.getSession(sourceId);
  await sessionManager.appendSessionMessages(source, [
    { role: 'model', parts: [{ text: 'Understood. I am a child session. Waiting for task from parent session.' }] },
    { role: 'user', parts: [{ text: 'A real subsequent user request.' }] },
    { role: 'model', parts: [{ functionCall: { id: 'inherited-call', name: 'read', args: { filePath: 'example.txt' } } }] },
  ]);
  source.childHandoffState = { boundary: 'report-required', resolved: false };
  await sessionManager.saveSession(sourceId);
  const inheritedHistory = structuredClone(source.history);
  const archiveBefore = await readLocalArchiveMessages(sourceId);
  const created: string[] = [];
  try {
    for (const fork of [false, true]) {
      for (const taskId of [undefined, 'task_fixture']) {
        const childId = await sessionManager.createChildSession(sourceId, `${fork ? 'fork' : 'new'}_${taskId || 'ordinary'}`, fork, { taskId });
        created.push(childId);
        const child = await sessionManager.getSession(childId);
        assert.equal(child.parentSessionId, sourceId);
        assert.equal(child.childHandoffState, undefined);
        assert.equal(child.queue.length, 0);
        assert.deepEqual(child.history.filter(message => message.role === 'model'),
          fork ? inheritedHistory.filter(message => message.role === 'model') : [],
          'inherit old model rows unchanged, but never append a framework confirmation');
        const opening = child.history.at(-1)!;
        assert.equal(opening.role, 'user');
        const guidance = opening.parts.map(part => part.system || '').join('');
        assert.match(guidance, taskId ? /linked to task task_fixture/ : /send_to_session/);
        assert.doesNotMatch(guidance, /manually forked by the user/);
        if (fork) {
          assert.deepEqual(child.history.slice(0, inheritedHistory.length), inheritedHistory);
          assert.equal(child.promptCacheKey, source.promptCacheKey);
          const suffix = child.history.slice(inheritedHistory.length);
          assert.deepEqual(suffix.map(message => message.role), ['tool', 'user', 'user']);
          assert.equal(suffix[0].parts[0].functionResponse?.tool_use_id, 'inherited-call');
          assert.equal(suffix[0].parts[0].functionResponse?.response.output, 'Pending execution in parent session');
          const archive = await readArchiveMessages(childId);
          assert.deepEqual(archive.slice(0, archiveBefore.length), archiveBefore.map(record => ({
            ...record, sourceSessionId: sourceId, inherited: true,
          })));
        } else {
          assert.notEqual(child.promptCacheKey, source.promptCacheKey);
          assert.deepEqual(child.history.map(message => message.role), ['user']);
        }
      }
    }
    assert.deepEqual(source.history, inheritedHistory);
    assert.deepEqual(await readLocalArchiveMessages(sourceId), archiveBefore);
  } finally {
    for (const childId of created) await sessionManager.deleteSession(childId).catch(() => false);
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});
