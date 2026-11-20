// Entry point logic with shimmed id/getent/find/chown/setpriv: no privileges or images are needed.
// The entry point never changes ownership of mounted data; that is the operator's step.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const entrypoint = new URL('../../docker/entrypoint.sh', import.meta.url).pathname

function fixture({ euid = 0, rootOwned = false, writable = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-entrypoint-'))
  const log = join(dir, 'calls.log')
  const shim = (name, body) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  shim('id', `case "$1" in -u) [ -n "$2" ] && echo 1000 || echo ${euid};; -g) echo 1000;; esac`)
  shim('getent', 'echo "node:x:1000:1000::/home/node:/bin/sh"')
  shim('find', `echo "find $*" >> ${log}; ${rootOwned ? 'echo "$1/state"' : ':'}`)
  shim('chown', `echo "chown $*" >> ${log}`)
  shim('setpriv', `echo "setpriv $*" >> ${log}
case "$*" in *" test -w "*) ${writable ? 'exit 0' : 'exit 1'};; esac
while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`)
  return { dir, log }
}

function run(options, command = ['env']) {
  const { dir, log } = fixture(options)
  const data = join(dir, 'data')
  try {
    const result = spawnSync('/bin/sh', [entrypoint, ...command], {
      env: { PATH: `${dir}:/usr/bin:/bin`, FOXWARM_DATA_DIR: data, HOME: '/root' },
      encoding: 'utf8',
    })
    return { ...result, calls: existsSync(log) ? readFileSync(log, 'utf8') : '', data }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the script is valid POSIX shell', () => {
  execFileSync('/bin/sh', ['-n', entrypoint])
})

test('a writable data directory is left alone and Foxwarm runs as the fixed user', () => {
  const result = run({ rootOwned: false })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.calls, /chown|find/)
  assert.match(result.calls, /setpriv --reuid=1000 --regid=1000 --init-groups -- env/)
  // sudo in the image depends on setuid still working after the privilege drop.
  assert.doesNotMatch(result.calls, /no-new-privs|no_new_privs/)
  assert.match(result.stdout, /^HOME=\/home\/node$/m)
  assert.match(result.stdout, /^USER=node$/m)
  assert.match(result.stdout, /^FOXWARM_DATA_DIR=/m)
})

test('root-owned data is never re-owned by the entry point', () => {
  const result = run({ rootOwned: true, writable: false })
  assert.doesNotMatch(result.calls, /chown/)
  assert.match(result.stderr, /not writable by node \(1000:1000\).*chown -R 1000:1000/)
})

test('a non-root start executes the command directly', () => {
  const result = run({ euid: 1234 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.calls, '')
  assert.match(result.stdout, /^HOME=\/root$/m)
})

test('an unwritable data directory is reported with the host fix and startup continues', () => {
  const result = run({ writable: false })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /not writable by node \(1000:1000\); on the host, run chown -R 1000:1000/)
})

test('the command receives its arguments unchanged', () => {
  const result = run({}, ['sh', '-c', 'printf "%s|%s" "$0" "$1"', 'a b', 'c'])
  assert.equal(result.stdout, 'a b|c')
})
