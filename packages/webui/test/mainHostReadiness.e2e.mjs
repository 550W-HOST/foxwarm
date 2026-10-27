import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostFixture } from './mainHostFixture.mjs'

test('owned normal Main observes stderr startup before checking its health route', async () => {
  const host = await createHostFixture('stderr-readiness', { env: { FOXWARM_LOG_STDERR: '1' } })
  try {
    await host.start()
    assert.equal(host.hostPids.length, 1)
    assert.equal((await host.api('GET', '/health')).body.status, 'ready')
    await host.stop()
  } finally {
    await host.cleanup()
  }
})
