import assert from 'node:assert/strict'
import test from 'node:test'
import { describeProcesses, listProcesses, processTree, sameProcess, survivors } from '../../dotnet/scripts/desktop-processes.mjs'

const at = second => `2026-11-23T21:${String(second).padStart(2, '0')}:00.0000000Z`
const row = (pid, ppid, name, second, args = name) => ({ pid, ppid, name, args, created: at(second) })

// A build server left running by an earlier step still names its exited parent's PID, 1348,
// which Windows has since given to the Desktop's Vector child.
const desktop = row(4000, 900, 'Foxwarm.Desktop.exe', 50)
const vector = row(1348, 4000, 'Foxwarm.Desktop.exe', 51, 'Foxwarm.Desktop.exe --foxwarm-vector-child pipe')
const webview = row(5000, 4000, 'msedgewebview2.exe', 52)
const renderer = row(5004, 5000, 'msedgewebview2.exe', 53)
const buildServer = row(6768, 1348, 'VBCSCompiler.exe', 10)
const buildConsole = row(3284, 6768, 'conhost.exe', 11)
const runner = row(900, 4, 'node.exe', 40)
const rows = [runner, desktop, vector, webview, renderer, buildServer, buildConsole]

test('a process is a descendant only of a parent created no later than itself', () => {
  assert.deepEqual(processTree(rows, desktop.pid), [vector, webview, renderer])
  assert.deepEqual(processTree(rows, vector.pid), [])
  assert.deepEqual(processTree(rows, 12345), [])
})

test('a reused PID is a different process', () => {
  const later = { ...vector, name: 'powershell.exe', ppid: 900, created: at(58) }
  assert.equal(sameProcess(vector, later), false)
  assert.deepEqual(survivors([runner, later, buildServer], [vector, webview]), [])
  assert.deepEqual(survivors([runner, vector], [vector, webview]), [vector])
})

test('the failure report names each process, its start and its parent', () => {
  assert.equal(describeProcesses([vector, buildServer], rows), [
    `pid 1348 Foxwarm.Desktop.exe started ${at(51)}, parent 4000 (Foxwarm.Desktop.exe): Foxwarm.Desktop.exe --foxwarm-vector-child pipe`,
    `pid 6768 VBCSCompiler.exe started ${at(10)}, parent 1348: VBCSCompiler.exe`,
  ].join('\n'))
})

test('the process list keeps creation times and reads missing command lines as empty', async () => {
  const listed = await listProcesses(async (file, args) => {
    assert.equal(file, 'powershell.exe')
    assert.match(args.at(-1), /Win32_Process/)
    return { stdout: JSON.stringify([
      { pid: 0, ppid: 0, name: 'System Idle Process', args: null, created: null },
      { pid: 1348, ppid: 4000, name: 'Foxwarm.Desktop.exe', args: 'x', created: at(51) },
    ]) }
  })
  assert.deepEqual(listed, [
    { pid: 0, ppid: 0, name: 'System Idle Process', args: '', created: null },
    { pid: 1348, ppid: 4000, name: 'Foxwarm.Desktop.exe', args: 'x', created: at(51) },
  ])
})
