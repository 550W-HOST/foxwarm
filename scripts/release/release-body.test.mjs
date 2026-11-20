import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const script = path.join(root, 'scripts/release/release-body.py')
function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-release-body-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('reviewed notes lose only their initial H1 and adjacent blank lines', t => {
  const file = path.join(scratch(t), 'notes.md')
  const cases = [
    ['# Foxwarm 0.9.3\n\n\t \n## Changes\n\nBody  \n\n# Later title\n', '## Changes\n\nBody  \n\n# Later title\n'],
    ['# Title\r\n \t\r\n## Changes\r\n\r\nRésumé  \r\n', '## Changes\r\n\r\nRésumé  \r\n'],
    ['# Title\nBody without final newline', 'Body without final newline'],
    ['   # Title ###\n\nBody', 'Body'],
    ['#\n\nBody', 'Body'],
    ['# Title', ''],
    ['# Title\n \t', ''],
    ['', ''],
    ['## Subtitle\n\nBody\n', '## Subtitle\n\nBody\n'],
    ['#hashtag\n\nBody', '#hashtag\n\nBody'],
    ['\n# Later title\n\nBody', '\n# Later title\n\nBody'],
    ['    # Indented code\n\nBody', '    # Indented code\n\nBody'],
    ['Intro\n\n# Later title\n\nBody', 'Intro\n\n# Later title\n\nBody'],
    [Buffer.from([35, 32, 84, 10, 10, 255, 13, 10]), Buffer.from([255, 13, 10])],
  ]
  for (const [input, expected] of cases) {
    fs.writeFileSync(file, input)
    const result = spawnSync('python3', [script, file])
    assert.equal(result.status, 0, result.stderr.toString())
    assert.deepEqual(result.stdout, Buffer.from(expected))
    assert.deepEqual(fs.readFileSync(file), Buffer.from(input))
  }
})

test('publish step supplies filtered notes or generated notes and retains the tag-derived release name', t => {
  const work = scratch(t)
  const source = path.join(work, 'source')
  const notes = path.join(source, 'docs/release-notes/v0.9.3.md')
  fs.mkdirSync(path.dirname(notes), { recursive: true })
  fs.mkdirSync(path.join(source, 'scripts/release'), { recursive: true })
  fs.copyFileSync(script, path.join(source, 'scripts/release/release-body.py'))
  fs.mkdirSync(path.join(work, 'dist'))
  fs.writeFileSync(path.join(work, 'dist/package.zip'), '')
  const bin = path.join(work, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/bash\nprintf "%s\\0" "$@" > "$RUNNER_TEMP/gh-args"\n', { mode: 0o755 })
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  const publish = workflow.split('      - name: Create the release\n')[1].split('        run: |\n')[1]
    .split('\n').map(line => line.replace(/^ {10}/, '')).join('\n')
  const original = '# Foxwarm 0.9.3\n\n## Changes\n\nRelease body.\n'
  for (const reviewed of [true, false]) {
    if (reviewed) fs.writeFileSync(notes, original)
    else fs.unlinkSync(notes)
    const result = spawnSync('bash', ['-e', '-c', publish], {
      cwd: work,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: work,
        GITHUB_REF_NAME: 'v0.9.3', GITHUB_REPOSITORY: 'example/project' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(path.join(work, 'gh-args'), 'utf8').split('\0').slice(0, -1), [
      'release', 'create', 'v0.9.3', 'dist/package.zip', '--repo', 'example/project',
      '--title', 'Foxwarm 0.9.3', '--latest',
      ...(reviewed ? ['--notes-file', path.join(work, 'release-body.md')] : ['--generate-notes']),
    ])
    if (reviewed) {
      assert.equal(fs.readFileSync(path.join(work, 'release-body.md'), 'utf8'), '## Changes\n\nRelease body.\n')
      assert.equal(fs.readFileSync(notes, 'utf8'), original)
    }
  }
})
