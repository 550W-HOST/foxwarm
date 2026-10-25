import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const builder = fileURLToPath(new URL('../scripts/build-code-oss.mjs', import.meta.url))

test('cold source install prepares upstream headers before npm ci and stops on prerequisite failure', {
  skip: process.platform === 'win32' ? 'The executable npm fixture uses a POSIX shebang.' : false,
}, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-code-install-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const seed = path.join(temp, 'seed')
  await mkdir(seed)
  await execFileAsync('git', ['init', '--quiet', seed])
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture'], { cwd: seed })
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: seed })
  const commit = stdout.trim()
  const cache = path.join(temp, 'cache')
  const source = path.join(cache, commit, 'source')
  await mkdir(path.join(source, 'build', 'npm'), { recursive: true })
  await writeFile(path.join(source, '.git'), `gitdir: ${path.join(seed, '.git')}\n`)
  await writeFile(path.join(source, '.nvmrc'), process.versions.node)
  await writeFile(path.join(source, 'product.json'), JSON.stringify({ nameShort: 'Code - OSS', licenseName: 'MIT' }))
  await writeFile(path.join(source, 'build', 'npm', 'preinstall.ts'), `
    const fs = require('node:fs')
    fs.appendFileSync(process.env.FIXTURE_EVENTS, 'headers\\n')
    process.exit(process.env.FIXTURE_FAIL_HEADERS === '1' ? 29 : 0)
  `)
  const bin = path.join(temp, 'bin')
  await mkdir(bin)
  await writeFile(path.join(bin, 'npm'), `#!${process.execPath}
    const fs = require('node:fs')
    fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      electron: process.env.ELECTRON_SKIP_BINARY_DOWNLOAD,
      playwright: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,
    }) + '\\n')
    process.exit(37)
  `, { mode: 0o755 })

  for (const failHeaders of [false, true]) {
    const events = path.join(temp, failHeaders ? 'failed-headers.events' : 'prepared-headers.events')
    await assert.rejects(execFileAsync(process.execPath, [builder, `--commit=${commit}`, `--cache=${cache}`, `--out=${path.join(temp, 'out')}`], {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FIXTURE_EVENTS: events,
        FIXTURE_FAIL_HEADERS: failHeaders ? '1' : '0',
      },
    }), (error) => {
      assert.match(error.stderr, new RegExp(`exited with ${failHeaders ? 29 : 37}`))
      return true
    })
    const recorded = (await readFile(events, 'utf8')).trim().split('\n')
    assert.equal(recorded[0], 'headers')
    if (failHeaders) {
      assert.equal(recorded.length, 1, 'npm ci must not run when header preparation fails')
    } else {
      assert.equal(recorded.length, 2)
      assert.deepEqual(JSON.parse(recorded[1]), {
        args: ['ci'], cwd: source, electron: '1', playwright: '1',
      })
    }
    await assert.rejects(readFile(path.join(source, 'node_modules', '.foxwarm-code-oss-install.json')), { code: 'ENOENT' })
  }
})
