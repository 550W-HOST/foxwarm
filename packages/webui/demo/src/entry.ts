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
// Phones open the Session list in Flat mode, which orders by recency and would put the
// gallery (recorded last) above the showcase. Start them on the curated order instead;
// a visitor's own choice is kept, and Flat stays available.
try {
  const mobileListMode = 'foxwarm_session_list_mobile_view_mode_v1'
  if (localStorage.getItem(mobileListMode) === null) localStorage.setItem(mobileListMode, 'default')
} catch { /* Storage may be unavailable; the WebUI then uses its own default. */ }
const server = installDemo(snapshot)
;(window as any).foxwarmDemo = { readOnly: true, sessions: server.snapshot.sessions }
