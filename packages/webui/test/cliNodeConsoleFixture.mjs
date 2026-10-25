// Existing host PTY machinery drives the real CLI entry; it is not a CLI implementation helper.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { until } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url), pty = require('node-pty')
const { isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
export async function consoleClient(cwd, args, { source = false, command, environment = {}, cols = 120, rows = 42, stdoutFile, stdinFile } = {}) {
  await mkdir(cwd, { recursive: true })
  const executable = process.env.FOXWARM_CLI_EXECUTABLE
  let invocation = command || (source
    ? [process.execPath, resolve('packages/cli-node/dist/tui.js'), ...args]
    : [executable || join(process.env.DOTNET_ROOT, 'dotnet'), ...(executable ? [] : [resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--interactive', ...args])
  if (stdoutFile || stdinFile) invocation = ['/bin/sh', '-c', 'exec \"$@\"' + (stdoutFile ? ' > \"$CLI_STDOUT_FILE\"' : '') + (stdinFile ? ' < \"$CLI_STDIN_FILE\"' : ''), 'redirected-console', ...invocation]
  const before = join(cwd, 'terminal-before'), after = join(cwd, 'terminal-after'), pidFile = join(cwd, 'console-pid')
  // Ink defers dynamic frames until exit in CI; these Source clients need live terminal rendering.
  const terminal = pty.spawn('/bin/sh', ['-c', 'stty -g > "$1"; shift; /bin/sh -c \'echo $$ > "$CLI_PID_FILE"; exec "$@"\' cli "$@"; result=$?; stty -g > "$CLI_AFTER_FILE"; printf "\\nCLI-RETURN:%s\\n" "$result"; exit "$result"', 'console-fixture', before, ...invocation], {
    cwd, cols, rows, env: { ...isolatedApplicationEnv(join(cwd, 'data')), TERM: 'xterm-256color', FOXWARM_AGENTS_DIR: join(cwd, 'agents'), CLI_PID_FILE: pidFile, CLI_AFTER_FILE: after, CLI_STDOUT_FILE: stdoutFile || '', CLI_STDIN_FILE: stdinFile || '', ...(source ? { CI: 'false' } : {}), ...environment },
  })
  let output = '', exit
  const exited = new Promise(done => terminal.onExit(value => { exit = value; done(value) }))
  terminal.onData(data => { output = (output + data).slice(-4 * 1024 * 1024) })
  const handle = {
    cwd, terminal, exited,
    get output() { return output }, get exit() { return exit },
    screen() { const clear = output.lastIndexOf('\u001b[2J'); return clear < 0 ? output : output.slice(clear + 4) },
    write(text) { terminal.write(text) },
    resize(width, height) { terminal.resize(width, height) },
    async signal(signal = 'SIGTERM') { process.kill(Number((await readFile(pidFile, 'utf8')).trim()), signal) },
    async wait(check, label, timeout = 22000) { return until(() => { assert(!exit, output); return check(handle) }, label, timeout) },
    async stopped(code = 0) {
      const result = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Console did not stop: ' + output)), 10000); timer.unref() })])
      assert.equal(result.exitCode, code, output)
      assert.equal(await readFile(after, 'utf8'), await readFile(before, 'utf8'), 'shell terminal modes restored')
      return result
    },
    async dispose() { if (!exit) { await handle.signal().catch(() => terminal.kill()); await exited } },
  }
  return handle
}
