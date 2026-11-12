import { execFileSync } from 'node:child_process'

// Ends a Windows process tree. taskkill exits with 128 when the process is already gone,
// which is the state cleanup wants; any other failure of a still-running process is real.
export function killProcessTree(child, run = execFileSync) {
  try {
    run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch (error) {
    if (error?.status !== 128 && child.exitCode === null && child.signalCode === null) throw error
  }
}

// Runs every cleanup step even when an earlier one fails. After a failed acceptance the
// cleanup failures are only reported, so the acceptance error stays the one that propagates
// from the caller's finally block; after a passed acceptance the first of them is thrown.
export async function runCleanup(steps, acceptanceFailed, report = message => console.error(message)) {
  const failures = []
  for (const [label, step] of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
      report(`Cleanup step failed (${label}): ${error?.message ?? error}`)
    }
  }
  if (!acceptanceFailed && failures.length) {
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Several cleanup steps failed')
  }
}
