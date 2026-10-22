import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Normal Source owners use only the explicitly supplied disposable data root.
const [mode, root] = process.argv.slice(2)
if (!root || !['seed', 'reopen', 'race'].includes(mode)) throw new Error('usage: lifecycle-transition-fixture-ts.mjs seed|reopen|race ROOT')
process.env.FOXWARM_DATA_DIR = root
process.env.FOXWARM_AGENTS_DIR = path.join(root, 'agents')
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '..')
if (mode !== 'reopen') {
  await fs.mkdir(path.join(root, 'state'), { recursive: true })
  await fs.writeFile(path.join(root, 'state/models.yaml'), 'default: a\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    apiKey: fixture-not-a-key\n    models: [wire]\n')
  await fs.writeFile(path.join(root, 'state/app.yaml'), 'dbWorkers: false\nvector:\n  enabled: false\n')
}
const load = relative => import(pathToFileURL(path.join(repository, 'lib', relative)).href)
const sm = await load('sessionManager.js')
const archive = await load('session/archiveStore.js')
await sm.loadSessions()
const text = value => ({ role: 'user', parts: [{ text: value }] })
if (mode === 'race') {
  const parent = (await sm.createEmptySession('parent')).session
  await sm.appendSessionMessage(parent, text('parent prefix'))
  let reached, release
  const held = new Promise(resolve => { reached = resolve })
  const resume = new Promise(resolve => { release = resolve })
  sm.setSessionPersistenceFaultInjectorForTests(async (phase, id) => {
    if (phase === 'history' && id === 'parent_cut') {
      reached()
      await resume
      throw new Error('owned precommit failure')
    }
  })
  const creating = sm.forkSession(parent.id, 'cut')
  const failed = assert.rejects(creating, /owned precommit failure/)
  await held
  let moveFinished = false
  const moving = sm.moveSessionToTarget({ sourceSessionId: parent.id, newSessionId: 'moved' }).then(value => {
    moveFinished = true
    return value
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(moveFinished, false)
  release()
  await failed
  sm.setSessionPersistenceFaultInjectorForTests(null)
  await moving
  assert.equal(await archive.getSessionBranch('parent_cut'), null)
  assert.equal((await archive.readLocalArchiveMessages('moved')).length, 1)
  assert.equal((await sm.createEmptySession('parent_cut')).session.id, 'parent_cut')
  console.log('LIFECYCLE_FIXTURE:' + JSON.stringify({ failedForkRemoved: true, parentRows: 1, targetReusable: true, moveSerialized: true }))
} else {
  const { taskService } = await load('tools/taskTools.js')
  if (mode === 'seed') {
    const parent = (await sm.createEmptySession('parent')).session
    await sm.appendSessionMessage(parent, text('retained audit'))
    const taskId = (await taskService.execute({ action: 'create', title: 'cross-lifecycle task' }, parent.id)).task.id
    let reached, release
    const held = new Promise(resolve => { reached = resolve })
    const resume = new Promise(resolve => { release = resolve })
    sm.setSessionPersistenceFaultInjectorForTests(async (phase, id) => {
      if (phase === 'history' && id === 'parent_child') {
        reached()
        await resume
      }
    })
    const creating = taskService.createAttachedChild(taskId, parent.id,
      () => sm.createChildSession(parent.id, 'child', false, { taskId }), 'accepted child work')
    await held
    const moving = sm.moveSessionToTarget({ sourceSessionId: parent.id, newSessionId: 'moved-parent' })
    release()
    const attached = await creating
    assert.equal(attached.assignmentDelivered, true)
    const childId = attached.childSessionId
    sm.setSessionPersistenceFaultInjectorForTests(null)
    await moving
    await sm.moveSessionToTarget({ sourceSessionId: childId, newSessionId: 'moved-child' })
    await sm.clearSession('moved-parent')
    const forkId = await sm.forkSession('moved-parent', 'cut')
    assert.equal((await sm.getSession(forkId)).queue.length, 0)
    await sm.deleteSession(forkId)
    await fs.writeFile(path.join(root, 'transition.json'), JSON.stringify({ taskId, forkId }))
    console.log('LIFECYCLE_FIXTURE:' + JSON.stringify({ childQueue: (await sm.getSession('moved-child')).queue.length, activeHistory: (await sm.getSession('moved-parent')).history.length }))
  } else {
    const { taskId, forkId } = JSON.parse(await fs.readFile(path.join(root, 'transition.json'), 'utf8'))
    const child = await sm.getSession('parent_child')
    const parent = await sm.getSession('parent')
    assert.equal(child.id, 'moved-child')
    assert.equal(child.parentSessionId, parent.id)
    assert.equal(child.queue.length, 1)
    const completed = await taskService.execute({ action: 'complete', taskId, result: 'cold completion' }, child.id)
    assert.equal(completed.warning, undefined)
    assert.equal(completed.sentNotifications, 1)
    assert.match(JSON.stringify(parent.queue), /cold completion/)
    assert.equal(parent.history.length, 0)
    assert.equal((await archive.readLocalArchiveMessages(parent.id)).length, 1)
    assert.equal(sm.getSessionCatalog(forkId), undefined)
    assert.ok(await archive.getSessionBranch(forkId))
    console.log('LIFECYCLE_FIXTURE:' + JSON.stringify({ completed: true, sent: completed.sentNotifications, childQueue: child.queue.length, parentRows: 1, deletedForkRetained: true }))
  }
}
process.exit(0)
