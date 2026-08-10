import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const files = {
  app: await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  embedded: await readFile(new URL('../src/EmbeddedWebUiApp.tsx', import.meta.url), 'utf8'),
  client: await readFile(new URL('../src/boundedSessionList.ts', import.meta.url), 'utf8'),
  list: await readFile(new URL('../src/components/SessionListCore.tsx', import.meta.url), 'utf8'),
  collapsed: await readFile(new URL('../src/components/CollapsedSidebar.tsx', import.meta.url), 'utf8'),
  architecture: await readFile(new URL('../src/components/ArchitectureView.tsx', import.meta.url), 'utf8'),
}

test('normal App and embedded roots use bounded Session APIs rather than legacy global GET', () => {
  assert.match(files.app, /useBoundedSessionList/)
  assert.match(files.embedded, /useBoundedSessionList/)
  assert.doesNotMatch(files.app, /fetch\(`\$\{API_BASE_PATH\}\/sessions`\)/)
  assert.doesNotMatch(files.embedded, /fetch\(`\$\{API_BASE_PATH\}\/sessions`\)/)
  assert.match(files.client, /\/session-list\/sidebar/)
  assert.match(files.client, /\/session-list\/children/)
  assert.match(files.client, /\/session-list\/by-id/)
  assert.match(files.client, /\/session-list\/search/)
})

test('bounded cache owns exact watches, focus paths, pages, latest generations, and fixed coalescing', () => {
  assert.match(files.client, /currentWatchIds/)
  assert.match(files.client, /focusSessionId/)
  assert.match(files.client, /rootCursor/)
  assert.match(files.client, /replayCursorWindow/)
  assert.match(files.client, /replayCursorBranches/)
  assert.match(files.client, /generation !== windowGenerationRef\.current/)
  assert.doesNotMatch(files.client, /slice\(0, 100\)/)
  assert.match(files.client, /createSessionListRefreshScheduler/)
  assert.match(files.client, /session-list-delta/)
  assert.match(files.client, /sessions-updated/)
  assert.match(files.client, /session-list\/descendant-activity/)
  assert.match(files.client, /invalidationVersion/)
  assert.match(files.client, /subscriptionIds\.length \? chunkBoundedIds\(subscriptionIds, 100\) : \[\[\]\]/)
  assert.doesNotMatch(files.client, /sources\.push/)
})

test('Sidebar and collapsed rail consume server order without client tie sorting', () => {
  assert.match(files.list, /if \(bounded\?\.serverOrdered\) return 0/)
  assert.doesNotMatch(files.collapsed, /compareSessionListSessions|\.sort\(/)
  assert.match(files.list, /onLoadMoreRoots/)
  assert.match(files.list, /onLoadMoreChildren/)
  assert.match(files.list, /boundedChildPage\?\.total/)
  assert.match(files.list, /\{childTotal\} \{childTotal === 1/)
  assert.match(files.list, /sessionRefs\.current\.delete/)
  assert.match(files.list, /session-list\/descendants/)
})

test('Architecture owns its bounded summary and forest instead of an all-session prop', () => {
  assert.match(files.architecture, /\/session-list\/architecture/)
  assert.match(files.architecture, /\/session-list\/children/)
  assert.match(files.architecture, /globalSummary/)
  assert.match(files.architecture, /replayCursorBranches/)
  assert.match(files.architecture, /pruneEpochRows/)
  assert.match(files.architecture, /session-list\/by-id/)
  assert.match(files.architecture, /focusPathIds/)
  assert.doesNotMatch(files.architecture, /sessions:\s*Session\[\]/)
  assert.doesNotMatch(files.architecture, /\.sort\(sortSessions\)/)
})
