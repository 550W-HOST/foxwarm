function sumMatches(output, expression) {
  return [...output.matchAll(expression)].reduce((sum, match) => sum + Number(match[1]), 0)
}

function parseUnittestDetails(line) {
  const details = Object.fromEntries([...line.matchAll(/(failures|errors|skipped|expected failures|unexpected successes)=(\d+)/g)]
    .map(match => [match[1], Number(match[2])]))
  return {
    failures: details.failures || 0,
    errors: details.errors || 0,
    skipped: details.skipped || 0,
    expectedFailures: details['expected failures'] || 0,
    unexpectedSuccesses: details['unexpected successes'] || 0,
  }
}

export function parseTestResultCounts(output) {
  const tap = {}
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const total = sumMatches(output, new RegExp(`^ℹ ${key} (\\d+)$`, 'gm'))
    if (total || new RegExp(`^ℹ ${key} 0$`, 'm').test(output)) tap[key] = total
  }
  if (Object.keys(tap).length) return tap

  const runs = [...output.matchAll(/^Ran (\d+) tests?.*$/gm)]
  if (runs.length) {
    const terminal = [...output.matchAll(/^(OK|FAILED)(?: \(([^\n]*)\))?$/gm)]
    if (terminal.length !== runs.length) return null
    const result = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }
    for (let index = 0; index < runs.length; index += 1) {
      const tests = Number(runs[index][1])
      const status = terminal[index][1]
      const details = parseUnittestDetails(terminal[index][2] || '')
      const fail = details.failures + details.errors + details.unexpectedSuccesses
      const pass = tests - fail - details.skipped - details.expectedFailures
      if (pass < 0 || (status === 'OK' && fail > 0) || (status === 'FAILED' && fail === 0)) return null
      result.tests += tests
      result.pass += pass
      result.fail += fail
      result.skipped += details.skipped
      result.todo += details.expectedFailures
    }
    return result
  }

  const passLines = [...output.matchAll(/^PASS /gm)].length
  return passLines ? { tests: passLines, pass: passLines, fail: 0, cancelled: 0, skipped: 0, todo: 0 } : null
}
