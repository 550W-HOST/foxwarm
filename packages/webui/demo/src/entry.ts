// Demo entry: loads the recorded snapshot and installs the browser mock. The
// demo HTML imports this module before the WebUI entry, and the top-level await
// holds the WebUI back until every shim is in place.
import snapshotUrl from '../fixtures/snapshot.json?url'
import { installClock, installDemo } from './install'
import type { DemoSnapshot } from './mock'
import { unpackSnapshot } from './pack.mjs'

const response = await fetch(snapshotUrl)
if (!response.ok) throw new Error(`Demo data unavailable (${response.status})`)
const snapshot = unpackSnapshot(await response.json()) as DemoSnapshot
installClock(snapshot.recordedAt)
const server = installDemo(snapshot)
;(window as any).foxwarmDemo = { readOnly: true, sessions: server.snapshot.sessions }
