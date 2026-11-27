// Policy script previews against a real C# Main:
// - Setup > Authorization: preview a scripted draft, preview an invalid draft, save, and verify
//   the expanded rules after reload.
// - System > Agents > Rules: view a scripted own layer (with Script pill and expanded rules) and a
//   scripted installation layer, edit and preview an unsaved change, save it, and verify an
//   invalid stored script layer shows its alert.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'

const fixture = await createHostFixture('policy-script-preview')
await writeModelFixture(fixture.data, {
  default: 'local',
  providers: {
    local: {
      providerType: 'openai-responses',
      baseUrl: 'http://127.0.0.1:9/r',
      apiKey: 'synthetic-policy-script-preview',
      models: ['wire'],
    },
  },
})

const validGlobalYaml = [
  'version: 1',
  'defaultAction: deny',
  'data:',
  '  agents: [alpha, beta]',
  'script: |',
  '  return [{"id": f"allow-{a}", "agent": a, "op": "env.read", "action": "allow"} for a in data["agents"]]',
  '',
].join('\n')

const invalidGlobalYaml = [
  'version: 1',
  'script: |',
  '  return [1 / 0]',
  '',
].join('\n')

const replaceMonacoText = async (page, containerSelector, text) => {
  const textbox = `${containerSelector} [role="textbox"]`
  await page.waitForSelector(textbox, { visible: true })
  await page.focus(textbox)
  await page.keyboard.down('Control')
  await page.keyboard.press('A')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.keyboard.sendCharacter(text.replaceAll('\n', '\r\n'))
  const expectedCompact = text.replace(/\s+/g, '')
  await page.waitForFunction(
    (sel, expected) => {
      const lines = [...document.querySelectorAll(`${sel} .view-line`)]
      const actual = lines.map(line => line.textContent || '').join('').replace(/[\s\u00a0]+/g, '')
      return actual === expected
    },
    { timeout: 10000 },
    containerSelector,
    expectedCompact,
  )
}

try {
  await fixture.start()

  // Seed an Agent with a scripted local layer.
  const created = await fixture.api('POST', '/api/agents', {
    agentId: 'scripted-worker',
    rules: {
      data: { ops: ['env.read'] },
      script: "return [{'id': f'allow-{o}', 'op': o, 'node': {'exact': 'master'}, 'action': 'allow'} for o in data['ops']] + [{'id': 'deny-rest', 'action': 'deny'}]",
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created))

  const page = await fixture.openApp()
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.setViewport({ width: 1440, height: 900 })

  // ---------------------------------------------------------------------------
  // 1. Setup > Authorization: preview scripted draft, preview invalid draft, save & reload.
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-authorization')
  await page.click('#setup-tab-authorization')
  const authEditor = '[aria-label="Tool authorization YAML editor"]'
  await page.waitForSelector(`${authEditor} [role="textbox"]`, { visible: true })

  // Preview a valid unsaved scripted draft.
  await replaceMonacoText(page, authEditor, validGlobalYaml)
  await page.waitForSelector('[data-authorization-preview]')
  await page.click('[data-authorization-preview]')
  await page.waitForSelector('[data-authorization-expanded-preview] [data-rule-id="allow-alpha"]')
  await page.waitForSelector('[data-authorization-expanded-preview] [data-rule-id="allow-beta"]')
  const draftPreviewText = await page.$eval('[data-authorization-expanded-preview]', el => el.textContent || '')
  assert.match(draftPreviewText, /Expanded rules/)
  assert.match(draftPreviewText, /2 rules/)
  assert.match(draftPreviewText, /Draft/)
  assert.match(draftPreviewText, /Calls that match no rule: deny/)

  // Preview an invalid scripted draft.
  await replaceMonacoText(page, authEditor, invalidGlobalYaml)
  await page.click('[data-authorization-preview]')
  await page.waitForSelector('[data-authorization-expanded-preview] [role="alert"]')
  const invalidPreviewText = await page.$eval('[data-authorization-expanded-preview]', el => el.textContent || '')
  assert.match(invalidPreviewText, /Invalid/)
  assert.match(invalidPreviewText, /line 1/)

  // Save the valid scripted policy.
  await replaceMonacoText(page, authEditor, validGlobalYaml)
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save policy')?.click())
  await until(
    async () => page.$eval('[data-save-feedback="authorization"]', el => el.getAttribute('role') === 'status' && el.textContent?.trim()).catch(() => null),
    'scripted global policy save feedback',
    10000,
  )

  // Reload and verify the saved expanded rules render without Draft.
  await page.reload({ waitUntil: 'networkidle0' })
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-authorization')
  await page.click('#setup-tab-authorization')
  await page.waitForSelector('[data-authorization-expanded-preview]')
  await page.click('[data-authorization-expanded-preview] button[aria-expanded="false"]')
  await page.waitForSelector('[data-authorization-expanded-preview] [data-rule-id="allow-alpha"]')
  await page.waitForSelector('[data-authorization-expanded-preview] [data-rule-id="allow-beta"]')
  const savedPreviewText = await page.$eval('[data-authorization-expanded-preview]', el => el.textContent || '')
  assert.match(savedPreviewText, /2 rules/)
  assert.doesNotMatch(savedPreviewText, /Draft/)

  // ---------------------------------------------------------------------------
  // 2. System > Agents > Rules: scripted own layer view, edit + preview + save, and invalid alert.
  await page.evaluate(() => { location.hash = 'system' })
  await page.waitForSelector('[data-system-tab="agents"]')
  await page.click('[data-system-tab="agents"]')
  await page.waitForSelector('[data-architecture-agent-id="scripted-worker"]')
  await page.click('[data-architecture-agent-id="scripted-worker"]')
  await page.waitForSelector('[data-architecture-agent-inspector-id="scripted-worker"]')
  await page.click('[data-agent-tab="rules"]')
  await page.waitForSelector('[data-rule-layers]')

  // Installation rules layer reflects the saved scripted global policy.
  const installHeader = await page.$eval('[data-rule-layer="installation"]', el => el.textContent || '')
  assert.match(installHeader, /Script/)
  await page.click('[data-rule-layer="installation"] button[aria-expanded="false"]')
  await page.waitForSelector('[data-rule-layer="installation"] [data-rule-id="allow-alpha"]')

  // Own layer in view mode shows Script pill, Expanded rules label, and expanded rules.
  const ownViewText = await page.$eval('[data-rule-layer="own"]', el => el.textContent || '')
  assert.match(ownViewText, /Script/)
  assert.match(ownViewText, /Allowlist/)
  await page.waitForSelector('[data-rule-layer="own"] [data-rule-expanded-label]')
  await page.waitForSelector('[data-rule-layer="own"] [data-rule-id="allow-env.read"]')
  await page.waitForSelector('[data-rule-layer="own"] [data-rule-id="deny-rest"]')

  // Edit own layer, preview an unsaved scripted change, then save.
  await page.click('[data-rule-layer="own"] [data-rule-edit]')
  await page.waitForSelector('[data-rule-editor] [role="textbox"]', { visible: true })
  const updatedAgentYaml = [
    'data:',
    '  ops: [env.write]',
    'script: "return [{\'id\': f\'allow-{o}\', \'op\': o, \'action\': \'allow\'} for o in data[\'ops\']]"',
    '',
  ].join('\n')
  await replaceMonacoText(page, '[data-rule-editor]', updatedAgentYaml)
  await page.waitForSelector('[data-rule-preview]')
  await page.click('[data-rule-preview]')
  await page.waitForSelector('[data-rule-expanded-preview] [data-rule-id="allow-env.write"]')

  await page.click('[data-rule-save]:not(:disabled)')
  await page.waitForSelector('[data-rule-layer="own"] [data-rule-id="allow-env.write"]')

  // Corrupt the stored Agent script on disk, restart Main, and verify the invalid layer alert.
  await page.goto('about:blank')
  await fixture.stop()
  const agentsPath = join(fixture.data, 'state/agents.json')
  const index = JSON.parse(await readFile(agentsPath, 'utf8'))
  index['scripted-worker'].rules = { script: 'return [1 / 0]' }
  await writeFile(agentsPath, JSON.stringify(index, null, 2))
  await fixture.start()

  await page.goto(`${fixture.origin}/#system`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('[data-system-tab="agents"]')
  await page.click('[data-system-tab="agents"]')
  await page.waitForSelector('[data-architecture-agent-id="scripted-worker"]')
  await page.click('[data-architecture-agent-id="scripted-worker"]')
  await page.waitForSelector('[data-architecture-agent-inspector-id="scripted-worker"]')
  await page.click('[data-agent-tab="rules"]')
  await page.waitForSelector('[data-rule-layer="own"] [data-rule-error]')
  const invalidAgentText = await page.$eval('[data-rule-layer="own"]', el => el.textContent || '')
  assert.match(invalidAgentText, /Invalid/)
  assert.match(invalidAgentText, /These rules are invalid, so all tool calls of this agent are refused:/)
  assert.match(invalidAgentText, /line 1/)

  assert.deepEqual(browserErrors, [])
  console.log('Policy script preview e2e passed')
} finally {
  await fixture.cleanup()
}
