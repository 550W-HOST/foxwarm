// Gallery Sessions: what the scripted model answers and how the generator drives
// each Session through the real runtime. Session text is product-facing demo copy.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { call, commentary, reasoning, text } from './scripted-model.mjs'

// String.raw keeps the TeX backslashes; escaped backticks are then unescaped.
const MARKDOWN = String.raw`Here is a tour of what replies can contain.

## Text and lists

Replies support **bold**, *italic*, ~~strikethrough~~, \`inline code\` and [links](https://foxwarm.net).

1. Ordered steps
2. With nested items
   - like this one
   - and this one
3. Back to the top level

- [x] Round line totals to cents
- [x] Round tax and total
- [ ] Publish the 0.5.0 notes

> A quote keeps its own styling, for example a customer's report:
> "The invoice total was off by a cent."

## Tables

| Plan | Monthly | Annual | Saving |
| --- | ---: | ---: | ---: |
| Starter | $9 | $90 | 17% |
| Team | $29 | $290 | 17% |
| Business | $79 | $790 | 17% |

## Code

\`\`\`js
export function prorate(price, periodStart, periodEnd, changedAt) {
  const total = (periodEnd - periodStart) / DAY;
  const unused = (periodEnd - changedAt) / DAY;
  return price * unused / total;
}
\`\`\`

\`\`\`bash
npm test -- --test-name-pattern="proration"
\`\`\`

\`\`\`diff
-  return gross - discount;
+  return toCents(gross - discount);
\`\`\`

## Math

The credit for a plan change is \(c = p \cdot \frac{t_{end} - t_{change}}{t_{end} - t_{start}}\), so half of a 30-day period gives \(c = p / 2\).

\[
\text{total} = \operatorname{round}_{0.01}\Big(\sum_i \operatorname{round}_{0.01}(q_i \, u_i \, (1 - d_i))\Big) \cdot (1 + r)
\]

## Diagrams

\`\`\`mermaid
flowchart LR
  A[Plan change] --> B{Mid-period?}
  B -- yes --> C[Prorate unused days]
  B -- no --> D[Bill next period]
  C --> E[Credit on next invoice]
\`\`\`

---

That covers the common formats. Code blocks keep their language label and can be copied.`.replaceAll('\\`', '`')

// Gallery Session order in the sidebar, after the showcase Sessions.
export const sessions = [
  { id: 'gallery/main', displayName: 'Gallery: Start here', existing: true },
  { id: 'gallery/markdown', displayName: 'Gallery: Messages and Markdown' },
  { id: 'gallery/files', displayName: 'Gallery: Files and commands' },
  { id: 'gallery/automation', displayName: 'Gallery: ToolScript, discovery and timers' },
  { id: 'gallery/delegation', displayName: 'Gallery: Delegation and tasks' },
  { id: 'gallery/context', displayName: 'Gallery: Compaction and recall' },
  { id: 'gallery/errors', displayName: 'Gallery: Errors and interruptions' },
  { id: 'gallery/questions', displayName: 'Gallery: Questions' },
  { id: 'gallery/channels', displayName: 'Gallery: Messages from other apps' },
  { id: 'gallery/live', displayName: 'Gallery: Running session' },
  { id: 'gallery-peer/main', displayName: 'Gallery: Peer Agent', existing: true },
]

const OVERVIEW = `This Agent holds a gallery of how Foxwarm shows a conversation. Each Session focuses on one area:

| Session | Shows |
| --- | --- |
| Messages and Markdown | Reasoning, commentary, final answers, tables, code, math and diagrams |
| Files and commands | \`exec\` in the foreground and background, \`read\`, \`write\`, \`edit\` and patches, images and file deliveries |
| ToolScript, discovery and timers | Skills, \`search_tools\`, \`call_tool\`, \`run_script\` and a timer firing |
| Delegation and tasks | Tasks, a child Session, a message to another Agent and \`wait\` |
| Compaction and recall | A context block written by the model and a \`recall\` of the original |
| Errors and interruptions | Tool errors, a failed model request and a stopped turn |
| Questions | An answered \`ask_user\` question and one still waiting |
| Messages from other apps | A message from a Matrix room, shown with its sender |
| Running session | A command still running, with a message queued behind it |

Switch between **Conversation**, **Grouped** and **Detailed** in the Session menu to see the same history at different levels of detail.`

const SCRIPT = `tests = call_tool("exec", {"summary": "Run the test suite", "command": "npm test 2>&1 | tail -8"})
changelog = call_tool("read", {"filePath": "CHANGELOG.md"})
entries = [line[2:] for line in changelog.splitlines() if line.startswith("- ")]
print(f"{len(entries)} changelog entries")
return {"passing": "fail 0" in tests, "entries": entries}
`

function delegationReply({ input }) {
  const all = JSON.stringify(input)
  const audit = all.includes('Rounding audit complete')
  const staging = all.includes('Staging is free on Tuesday')
  if (audit && staging) return [text('Both checks are back. The audit found nothing to change, and the peer Agent booked staging for Tuesday 14:00–16:00 UTC. 0.5.0 is ready to deploy there.')]
  if (audit) return [text('The audit is back: invoice amounts are rounded once and the proration credit is rounded when billed, so nothing needs to change. Still waiting for the staging window.')]
  return [text('Staging is booked for Tuesday 14:00–16:00 UTC. Still waiting for the audit.')]
}

export const channelSessionId = 'gallery/channels'
export const channelSender = '@dana:example.org'
const CHANNEL_MESSAGE = 'Is the 0.5.0 release still on track for Tuesday? Support wants to warn the annual customers.'

const taskIdIn = value => /\btask_[0-9a-f]{6,}\b/.exec(value || '')?.[0]

export function turns({ workspace }) {
  return [
    {
      match: 'Support wants to warn the annual customers',
      steps: [{ items: [text('Yes. 0.5.0 goes to staging on Tuesday 14:00–16:00 UTC and to production two days later. Annual customers who changed plans mid-period will see slightly larger credits, because the proration fix stops rounding to whole days.')] }],
    },
    {
      match: 'What does this gallery show?',
      steps: [{ items: [text(OVERVIEW)] }],
    },
    {
      match: 'Show me how replies are formatted',
      steps: [
        { items: [reasoning('The user wants a formatting tour. I will look at the project briefly so the examples use real code, then answer with every common Markdown feature.'), commentary('I\'ll take a quick look at the project so the examples use real code.'), call('md-1', 'exec', { summary: 'Show recent commits', command: 'git log --oneline -3 && ls src test' })], reasoningTokens: 180 },
        { items: [text(MARKDOWN)] },
      ],
    },
    {
      match: 'Commit the clamping change',
      steps: [
        { items: [call('md-2', 'exec', { summary: 'Commit the change', command: 'git add -A && git commit -q -m "Clamp plan changes to the billing period" && git log --oneline -1 && git rev-parse HEAD' })] },
        {
          callIds: [],
          items: ({ input }) => {
            const id = /Clamp plan changes to the billing period(?:\\n|\s)+([0-9a-f]{40})/.exec(JSON.stringify(input))?.[1]
            if (!id) throw new Error('commit id missing from the exec output')
            return [text(`Committed the clamping change with its test and notes:\n\n<foxwarm-commit node="master" path="${workspace}" id="${id}" />\n\nThe card above opens the commit in Code.`)]
          },
        },
      ],
    },
    {
      match: 'Walk through the file and command tools',
      steps: [
        { items: [commentary('Starting with the test suite, then the files themselves.'), call('fs-1', 'exec', { summary: 'Run the test suite', command: 'npm test 2>&1', timeout: 60 })] },
        { items: [call('fs-2', 'read', { filePath: 'src/proration.js' }), call('fs-3', 'read', { filePath: 'docs/revenue-by-plan.png' })] },
        { items: [reasoning('The proration helper divides by the period length in days. I will add a short design note and then tighten the helper with explicit clamping.'), call('fs-4', 'write', { filePath: 'docs/NOTES.md', content: '# Proration notes\n\n- Credits use the exact unused fraction of the period.\n- Plan changes outside the period are clamped to its bounds.\n- Amounts are rounded to cents by the invoice, not here.\n' })], reasoningTokens: 120 },
        { items: [call('fs-5', 'edit', { filePath: 'src/proration.js', oldText: '  const unused = (periodEnd - changedAt) / DAY;', newText: '  const clamped = Math.min(Math.max(changedAt, periodStart), periodEnd);\n  const unused = (periodEnd - clamped) / DAY;' })] },
        { items: [call('fs-6', 'edit', { filePath: 'README.md', edits: [{ oldText: '# Tidepool', newText: '# Tidepool billing' }, { oldText: 'plan-change proration.', newText: 'plan-change proration.\n\nRun `npm test` before committing.' }] })] },
        { items: [call('fs-7', 'edit', { apply_patch: '*** Begin Patch\n*** Add File: test/clamp.test.js\n+import test from \'node:test\';\n+import assert from \'node:assert/strict\';\n+import { prorate } from \'../src/proration.js\';\n+\n+test(\'clamps changes before the period start\', () => {\n+  const start = Date.UTC(2026, 10, 1);\n+  const end = Date.UTC(2026, 11, 1);\n+  assert.equal(prorate(30, start, end, start - 86400000), 30);\n+});\n*** Update File: CHANGELOG.md\n@@\n ## 0.5.0\n \n+- Clamp plan changes outside the billing period.\n - Round invoice line totals, tax and total to cents.\n*** End Patch' })] },
        { items: [commentary('The full matrix takes a moment, so I\'ll let it run in the background.'), call('fs-8', 'exec', { summary: 'Run the full test matrix', command: 'sleep 3 && npm test 2>&1 | tail -9', timeout: 1 })] },
        {
          callIds: ['fs-9'],
          items: ({ outputs }) => {
            const execId = /execId[^A-Za-z0-9]+([A-Za-z0-9_-]+)/.exec(outputs['fs-8'] || '')?.[1]
            return [call('fs-9', 'wait', { reason: 'Waiting for the test matrix', waitExecIds: execId ? [execId] : [] })]
          },
        },
      ],
    },
    {
      match: 'type="background-process-finished"',
      steps: [
        { items: [call('fs-10', 'send_file', { filePath: 'docs/revenue-by-plan.png', caption: 'Revenue by plan, last five months' }), call('fs-11', 'send_file', { filePath: 'docs/plans.csv', caption: 'Plan prices' })] },
        { items: [text('The background run finished and all tests pass, including the new clamp test.\n\n- `src/proration.js` now clamps plan changes to the billing period.\n- `docs/NOTES.md` records the rounding rule.\n- `test/clamp.test.js` covers a change before the period starts.\n\nI also attached the revenue chart and the plan price list.')] },
      ],
    },
    {
      match: 'Find the timer tools',
      steps: [
        { items: [call('au-1', 'skill', { action: 'load', skillName: 'timer-automation' })] },
        { items: [call('au-2', 'search_tools', { query: 'timer', limit: 3, includeSchema: false })] },
        { items: [commentary('I\'ll schedule the check and collect the release facts in one script meanwhile.'), call('au-3', 'call_tool', { toolId: 'builtin:create_timer', args: { afterSeconds: 5, message: 'Check whether the nightly test matrix passed and post a one-line status.' } })] },
        { items: [call('au-4', 'run_script', { summary: 'Collect test and changelog facts', code: SCRIPT })] },
        { items: [text('The timer is set to check the nightly matrix shortly. The script found the suite passing and three changelog entries for 0.5.0:\n\n- Clamp plan changes outside the billing period.\n- Round invoice line totals, tax and total to cents.\n- Credit mid-day plan changes by the fraction of the day left.')] },
      ],
    },
    {
      match: 'Check whether the nightly test matrix passed',
      steps: [
        { items: [call('au-5', 'exec', { summary: 'Check the nightly matrix', command: 'npm test 2>&1 | tail -8' })] },
        { items: [text('Nightly matrix: all tests pass.')] },
      ],
    },
    {
      match: 'Split the release checks',
      steps: [
        { items: [reasoning('Two independent checks: a code audit that a child Session can own, and the deploy window that the peer Agent knows. I will track the audit as a Task.'), call('dl-1', 'task', { action: 'create', title: 'Audit rounding helpers', description: 'Check that every money amount in src/ is rounded to cents exactly once, and list any helper that returns unrounded values.' })], reasoningTokens: 90 },
        {
          callIds: ['dl-2'],
          items: ({ outputs }) => [call('dl-2', 'create_child_session', {
            suffix: 'audit', displayName: 'Audit rounding helpers', taskId: taskIdIn(outputs['dl-1']),
            message: 'Audit the rounding helpers in src/: every money amount should be rounded to cents exactly once. Report helpers that return unrounded values and complete the Task with your findings.',
          })],
        },
        { items: [call('dl-3', 'send_to_session', { sessionId: 'gallery-peer/main', message: 'Could you confirm the staging deploy window for Tidepool 0.5.0?', currentSessionTurnAction: 'continue' })] },
        { items: [call('dl-4', 'wait', { reason: 'Waiting for the audit and the deploy window', waitAllSessions: ['gallery/delegation_audit', 'gallery-peer/main'] })] },
      ],
    },
    {
      match: 'Audit the rounding helpers in src/',
      steps: [
        { items: [call('ch-1', 'exec', { summary: 'Find rounding in src', command: 'grep -n "toCents\\|Math.round\\|return" src/*.js' })] },
        {
          callIds: ['ch-2'],
          items: ({ input }) => [call('ch-2', 'task', { action: 'update', taskId: taskIdIn(JSON.stringify(input)), note: 'invoice.js rounds every line, the subtotal, tax and total. proration.js returns an unrounded credit by design.' })],
        },
        {
          callIds: ['ch-3'],
          items: ({ input }) => [call('ch-3', 'task', { action: 'complete', taskId: taskIdIn(JSON.stringify(input)), result: 'Rounding audit complete. invoice.js rounds each amount once. prorate() returns an unrounded credit; the invoice rounds it when the credit is billed, so no change is needed.' })],
        },
        { items: [text('Audit done and reported on the Task. No changes needed.')] },
      ],
    },
    {
      match: 'confirm the staging deploy window',
      steps: [
        { items: [call('pe-1', 'send_to_session', { sessionId: 'gallery/delegation', message: 'Staging is free on Tuesday from 14:00 to 16:00 UTC. I have booked it for 0.5.0.', currentSessionTurnAction: 'end_turn' })] },
        { items: [text('Booked staging for Tuesday and replied.')] },
      ],
    },
    { match: 'Rounding audit complete', steps: [{ items: delegationReply }] },
    { match: 'Staging is free on Tuesday', steps: [{ items: delegationReply }] },
    {
      match: 'Summarize what the proration helper does',
      steps: [{ items: [text('`prorate(price, periodStart, periodEnd, changedAt)` returns the credit for the unused part of a billing period: the price times the unused fraction of the period. It works in milliseconds, so mid-day changes are credited exactly.')] }],
    },
    {
      match: 'And how is the invoice total rounded?',
      steps: [{ items: [text('Each line total is rounded to cents first. The subtotal is the sum of rounded lines, the tax is rounded on the subtotal, and the total is rounded once more.')] }],
    },
    {
      match: 'Tidy up the context',
      steps: [
        { items: [call('cx-1', 'submit_compact_plan', { inContext: true, replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 4, summary: 'The user asked how the billing helpers work. prorate() credits the unused fraction of a period in milliseconds; invoice totals round each line, the tax and the total to cents.' }] })] },
        { items: [call('cx-2', 'recall', { target: 'msg#2' })] },
        { items: [text('I folded the first two answers into one context block. The original wording is still in the archive; I just recalled message #2 to check the summary against it.')] },
      ],
    },
    {
      match: 'Try a few things that fail',
      steps: [
        { items: [call('er-1', 'read', { filePath: 'src/refunds.js' }), call('er-2', 'exec', { summary: 'Run the lint script', command: 'npm run lint 2>&1' })] },
        { items: [text('Both failed as expected: `src/refunds.js` doesn\'t exist yet, and the project has no `lint` script. Nothing was changed.')] },
      ],
    },
    {
      match: 'Check the release against the staging API',
      steps: [
        { fail: { status: 400, body: { error: { message: 'The request was rejected because the staging endpoint is not configured for this model.', type: 'invalid_request_error' } } } },
      ],
    },
    {
      match: 'Draft a long migration plan',
      steps: [
        { hold: 'Here is a first outline of the migration:\n\n1. Freeze plan changes during the cutover window\n2. Export the current subscriptions' },
      ],
    },
    {
      match: 'Help me choose the release date',
      steps: [
        { items: [call('q-1', 'ask_user', { questions: [
          { question: 'Which date should 0.5.0 ship?', options: [{ label: 'Monday, November 9', description: 'After the weekend test matrix' }, { label: 'Wednesday, November 11', description: 'Leaves time for the docs review', recommended: true }] },
          { question: 'Who should sign off on the release notes?', options: [{ label: 'Dana Reyes' }, { label: 'Lin' }] },
        ] })] },
      ],
    },
    {
      match: 'Answer to question',
      steps: [{ items: [text('Thanks. I\'ll plan the release for Wednesday, November 11 and ask Lin to sign off on the notes.')] }],
    },
    {
      match: 'Should the changelog mention the clamping fix',
      steps: [
        { items: [call('q-2', 'ask_user', { questions: [
          { question: 'Should the 0.5.0 changelog mention the proration clamping fix?', options: [{ label: 'Yes, as a bug fix' }, { label: 'No, it is internal' }] },
        ] })] },
      ],
    },
    {
      match: 'Run the long integration suite',
      steps: [
        { items: [commentary('Starting the integration suite. It usually takes about fifteen minutes.'), call('lv-1', 'exec', { summary: 'Run the integration suite', command: 'npm run test:integration', timeout: 60 })] },
      ],
    },
  ]
}

export async function drive(ctx) {
  const { send, waitIdle, api, answerQuestions } = ctx
  await ctx.createAgent('gallery')
  await ctx.createAgent('gallery-peer')
  // An oversized memory file makes the peer Agent show the memory-size warning.
  await mkdir(join(ctx.dataRoot, 'agents/gallery-peer/memory'), { recursive: true })
  await writeFile(join(ctx.dataRoot, 'agents/gallery-peer/memory/MEMORY.md'), releaseHandbook())
  await api('POST', '/sessions/gallery-peer%2Fmain/refresh-memory', {})
  for (const session of sessions) await ctx.createSession(session)

  await send('gallery/main', 'What does this gallery show?')
  await waitIdle('gallery/main')

  await send('gallery/markdown', 'Show me how replies are formatted in this chat, using our project as the example.')
  await waitIdle('gallery/markdown')

  await send('gallery/files', 'Walk through the file and command tools on the Tidepool checkout: run the tests, read and change a few files, and run the full matrix in the background.')
  await ctx.waitFor(() => ctx.model.done('type="background-process-finished"'), 'background completion turn')
  await waitIdle('gallery/files')

  await send('gallery/markdown', 'Commit the clamping change.')
  await waitIdle('gallery/markdown')

  await send('gallery/automation', 'Find the timer tools, schedule a check of the nightly matrix, and collect the release facts.')
  await waitIdle('gallery/automation')
  await ctx.waitFor(() => ctx.model.done('Check whether the nightly test matrix passed'), 'timer turn', 60000)
  await waitIdle('gallery/automation')

  await send('gallery/delegation', 'Split the release checks: have a child audit the rounding helpers and ask the peer Agent for the staging window.')
  await ctx.waitFor(() => ctx.model.done('Staging is free on Tuesday') || ctx.model.done('Rounding audit complete'), 'delegation reports', 90000)
  await waitIdle('gallery/delegation_audit')
  await waitIdle('gallery-peer/main')
  await waitIdle('gallery/delegation', { quietMs: 4000 })

  await send('gallery/context', 'Summarize what the proration helper does.')
  await waitIdle('gallery/context')
  await send('gallery/context', 'And how is the invoice total rounded?')
  await waitIdle('gallery/context')
  await send('gallery/context', 'Tidy up the context: fold the first two answers into a summary, then check it against the original.')
  await waitIdle('gallery/context')

  await send('gallery/errors', 'Try a few things that fail so I can see how errors look.')
  await waitIdle('gallery/errors')
  await send('gallery/errors', 'Check the release against the staging API.')
  await waitIdle('gallery/errors', { quietMs: 3000 })
  await send('gallery/errors', 'Draft a long migration plan for moving annual plans to the new proration rules.')
  await ctx.waitHeld('Draft a long migration plan')
  await api('POST', `/sessions/${encodeURIComponent('gallery/errors')}/stop`, {})
  await waitIdle('gallery/errors')

  await send('gallery/questions', 'Help me choose the release date and the reviewer for 0.5.0.')
  await answerQuestions('gallery/questions', ['Wednesday, November 11', 'Lin'])
  await waitIdle('gallery/questions')
  await send('gallery/questions', 'Should the changelog mention the clamping fix? Ask me before you edit it.')
  await ctx.waitForOpenQuestion('gallery/questions')

  // Left running for the recording: a long command and a message queued behind it.
  // Arrives through the Matrix channel bound to this Session, not through the WebUI.
  ctx.matrix.deliver(channelSender, CHANNEL_MESSAGE)
  await ctx.waitFor(() => ctx.model.done('Support wants to warn the annual customers'), 'channel message reply')
  await waitIdle(channelSessionId)
  await ctx.waitFor(() => ctx.matrix.sent.length > 0, 'Matrix reply delivery')

  await send('gallery/live', 'Run the long integration suite and tell me what fails.')
  await ctx.waitFor(() => ctx.model.seen('Run the long integration suite'), 'running command')
  await ctx.sleep(1500)
  await api('POST', `/sessions/${encodeURIComponent('gallery/live')}/message`, { text: 'When it finishes, list the failures before anything else.' })

  for (const session of sessions) {
    if (session.id.includes('_')) continue
    await api('POST', `/sessions/${encodeURIComponent(session.id)}/move`, { position: 'last', updateOrder: true })
  }
}

// A release log kept in top-level memory instead of docs: realistic, and long
// enough to cross the generator's memory warning threshold.
function releaseHandbook() {
  const lines = ['# Release desk', '', 'I coordinate Tidepool staging deploys. Deploy windows are Tuesday and Thursday, 14:00-16:00 UTC.', '', '## Release log', '']
  const areas = ['invoices', 'proration', 'tax rounding', 'plan changes', 'refunds', 'dunning emails', 'CSV export', 'webhooks']
  for (let minor = 1; minor <= 5; minor++) {
    for (let patch = 0; patch <= 14; patch++) {
      const area = areas[(minor * 3 + patch) % areas.length]
      const day = String(1 + (patch * 2) % 27).padStart(2, '0')
      lines.push(`### 0.${minor}.${patch}`, '', `- Deployed to staging on 2026-0${minor + 4}-${day} in the Tuesday window; production followed two days later.`, `- Main change: ${area}. Verified with the full test matrix and a manual check of three sample invoices.`, `- Rollback plan: redeploy 0.${minor}.${Math.max(0, patch - 1)}; no data migration was involved.`, `- Notes: customers on annual plans were checked separately; support was told about the ${area} change before release.`, '')
    }
  }
  return lines.join('\n')
}
