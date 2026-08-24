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
  assert.match(files.client, /getSessionIdleUnreadIds/)
  assert.match(files.client, /session-list-delta/)
  assert.match(files.client, /sessions-updated/)
  assert.match(files.client, /session-list\/descendant-activity/)
  assert.match(files.client, /invalidationVersion/)
  assert.match(files.client, /webUiRealtime\.subscribeSessionList\(subscriptionIds/)
  assert.match(files.client, /onOpen: \(\) => requestSessionListStreamOpenResync\(schedulerRef\.current\)/)
  assert.match(files.client, /\[subscriptionIds\.join\('\\0'\), options\.connectStream, invalidate\]/)
  assert.doesNotMatch(files.client, /new EventSource/)
})

test('bounded active-path expansion owns branch intent and presents loading or retry before continuation', () => {
  assert.match(files.client, /branchTargetsRef/)
  assert.match(files.client, /expandBranches/)
  assert.match(files.client, /branchLoadStates/)
  assert.match(files.client, /retryBranch/)
  assert.match(files.client, /new Map\(branchTargetsRef\.current\)\)\.then\(loadSummary\)/)
  assert.doesNotMatch(files.client, /replayOwnedWindows\(stateRef\.current\.rootTarget, new Map\(\)\)\.then\(loadSummary\)/)
  assert.match(files.client, /if \(generation !== windowGenerationRef\.current\) return false[\s\S]*loadState\.status === 'loading' && branchTargetsRef\.current\.has\(branch\)/)
  assert.match(files.client, /\+\+windowGenerationRef\.current; \+\+branchLoadGenerationRef\.current/)
  assert.match(files.list, /bounded\.onExpandBranches\(sessionsToExpand\)/)
  assert.match(files.list, /data-session-branch-loading/)
  assert.match(files.list, /data-session-branch-retry/)
  assert.match(files.list, /!!boundedChildPage && !branchLoadState/)
  assert.match(files.app, /branchLoadStates: boundedSessions\.branchLoadStates/)
  assert.match(files.embedded, /branchLoadStates: boundedSessions\.branchLoadStates/)
})

test('Sidebar and collapsed rail consume server order without client tie sorting', () => {
  assert.match(files.list, /if \(bounded\?\.serverOrdered\) return 0/)
  assert.doesNotMatch(files.collapsed, /compareSessionListSessions|\.sort\(/)
  assert.match(files.list, /onLoadMoreRoots/)
  assert.match(files.list, /onLoadMoreChildren/)
  assert.match(files.list, /boundedChildPage\?\.total/)
  assert.match(files.list, /getSessionListChildDisclosure/)
  assert.match(files.list, /itemTotal: session\.childTotal/)
  assert.doesNotMatch(files.list, /childTotal === null \? 'Children'/)
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
  assert.match(files.architecture, /webUiRealtime\.subscribeSessionList\(architectureSubscriptionIds/)
  assert.match(files.architecture, /onOpen: \(\) => requestSessionListStreamOpenResync\(scheduler\)/)
  assert.doesNotMatch(files.architecture, /new EventSource/)
  assert.doesNotMatch(files.architecture, /sessions:\s*Session\[\]/)
  assert.doesNotMatch(files.architecture, /\.sort\(sortSessions\)/)
})
