import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/questionContent.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { projectQuestionContent, questionContentSummary } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const descriptor = '<foxwarm-image name="attachment1_screen.png" node="master" path="/private/upload.png" />'
const screenshotAnswer = `<attachment-ref ref="attachment1" />还有这个，mac上怎么打不开code\n${descriptor}`

test('legacy via-message answers project protocol markers to readable attachment labels', () => {
  const projected = projectQuestionContent(screenshotAnswer, true)
  assert.equal(projected.markdown, '\\[Image: screen.png\\]还有这个，mac上怎么打不开code')
  assert.deepEqual(projected.attachments, [{ ref: 'attachment1', name: 'screen.png', kind: 'image', node: 'master', path: '/private/upload.png', mimeType: 'image/png' }])
  assert.equal(questionContentSummary(screenshotAnswer, true), '[Image: screen.png]还有这个，mac上怎么打不开code')
  assert.doesNotMatch(projected.markdown, /foxwarm-image|attachment-ref|\/private\/upload/)
})

test('old outer wrappers disappear while body Markdown remains intact', () => {
  const source = `<foxwarm-message type="channel" channelType="webui">\n**Use SQLite**\n\n- Keep backups\n</foxwarm-message>`
  assert.equal(projectQuestionContent(source, true).markdown, '**Use SQLite**\n\n- Keep backups')
  assert.equal(questionContentSummary(source, true), 'Use SQLite Keep backups')
})

test('fenced and inline code that quote attachment syntax stay literal', () => {
  for (const literal of [`\`${descriptor}\``, `\`\`\`xml\n${descriptor}\n\`\`\``, `~~~xml\n${descriptor}\n~~~`]) {
    const projected = projectQuestionContent(`${literal}\n\nActual attachment:\n${screenshotAnswer}`, true)
    assert.ok(projected.markdown.includes(literal))
    assert.equal(projected.attachments.length, 1)
  }
  assert.deepEqual(projectQuestionContent(`\`${descriptor}\``, true), { markdown: `\`${descriptor}\``, attachments: [] })
})

test('pasted text is kept as literal code, even when it contains long fences', () => {
  const pasted = `${descriptor}\n${'`'.repeat(20)}\n<attachment-ref ref="attachment1" />`
  const projected = projectQuestionContent(`<pasted-text>${pasted}</pasted-text>`, true)
  assert.equal(projected.attachments.length, 0)
  assert.ok(projected.markdown.includes(pasted))
  assert.ok(projected.markdown.startsWith('`'.repeat(21)))
})

test('transport envelopes do not hide literal code from the protection pass', () => {
  for (const literal of [`\`${descriptor}\``, `\`\`\`xml\n${descriptor}\n\`\`\``]) {
    const wrapped = `<foxwarm-message type="channel">\n${literal}\n</foxwarm-message>`
    const projected = projectQuestionContent(wrapped, true)
    assert.equal(projected.markdown, literal)
    assert.equal(projected.attachments.length, 0)
  }
})

test('code quoting pasted-text tags remains exactly literal, including inside transport envelopes', () => {
  for (const literal of [`\`<pasted-text>${descriptor}</pasted-text>\``, `\`\`\`xml\n<pasted-text>\n${descriptor}\n</pasted-text>\n\`\`\``]) {
    for (const source of [literal, `<foxwarm-message type="channel">\n${literal}\n</foxwarm-message>`]) {
      assert.deepEqual(projectQuestionContent(source, true), { markdown: literal, attachments: [] })
    }
  }
})

test('a standalone attachment ref cannot turn following code into active metadata', () => {
  const literal = `\`\`\`xml\n${descriptor}\n\`\`\``
  const projected = projectQuestionContent(`<attachment-ref ref="attachment1" />\n${literal}`, true)
  assert.ok(projected.markdown.includes(literal))
  assert.equal(projected.attachments.length, 0)
  const inline = projectQuestionContent(`<attachment-ref ref="attachment1" /> actual \`${descriptor}\``, true)
  assert.ok(inline.markdown.includes(`\`${descriptor}\``))
  assert.equal(inline.attachments.length, 0)
})

test('inline pasted blocks gain their own code boundaries and preserve quoted fences', () => {
  const literal = `\`\`\`xml\n${descriptor}\n\`\`\``
  const projected = projectQuestionContent(`Before <pasted-text>${literal}</pasted-text> after`, true)
  assert.equal(projected.attachments.length, 0)
  assert.ok(projected.markdown.includes(`Before \n\n\`\`\`\`\n${literal}\n\`\`\`\`\n\n after`))
})

test('code inside quotes and lists retains its container and cannot activate attachments', () => {
  for (const literal of [
    `> \`\`\`xml\n> ${descriptor}\n> \`\`\``,
    `- Example:\n  \`\`\`xml\n  ${descriptor}\n  \`\`\``,
    `>     ${descriptor}`,
    `- Example:\n\n      ${descriptor}`,
  ]) {
    const projected = projectQuestionContent(literal, true)
    assert.equal(projected.markdown, literal)
    assert.equal(projected.attachments.length, 0)
  }
})

test('structured answer text is not mistaken for generated attachment metadata', () => {
  assert.deepEqual(projectQuestionContent(screenshotAnswer), { markdown: screenshotAnswer, attachments: [] })
})

test('descriptor attributes are decoded and filenames cannot inject Markdown', () => {
  const source = '<attachment-ref ref="attachment2" />\n<foxwarm-file name="attachment2_[x](javascript:alert).txt" node="worker-1" path="/tmp/a&amp;b.txt" mime="text/plain" />'
  const projected = projectQuestionContent(source, true)
  assert.equal(projected.attachments[0].path, '/tmp/a&b.txt')
  assert.equal(projected.attachments[0].node, 'worker-1')
  assert.ok(projected.markdown.includes('\\[x\\]\\(javascript:alert\\)'))
})

test('missing and duplicate descriptors do not expose protocol strings', () => {
  assert.equal(questionContentSummary('<attachment-ref ref="attachment9" />', true), '[Attachment 9]')
  assert.equal(projectQuestionContent(`${screenshotAnswer}\n${descriptor}`, true).attachments.length, 1)
})

test('summaries remove Markdown formatting without losing code, link labels or table cells', () => {
  assert.equal(questionContentSummary('**Yes**, use `SQLite` and [the docs](https://example.test).'), 'Yes, use SQLite and the docs.')
  const summary = questionContentSummary('| Key | Value |\n| --- | --- |\n| mode | safe |')
  assert.match(summary, /Key.*Value.*mode.*safe/)
  assert.equal(questionContentSummary(''), '')
})
