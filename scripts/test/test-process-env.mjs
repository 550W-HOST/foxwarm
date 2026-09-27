import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const runRoot = process.env.FOXWARM_TEST_RUN_ROOT
const testFile = process.env.NODE_TEST_CONTEXT ? process.argv[1] : undefined
const inheritedProcessRoot = process.env.FOXWARM_TEST_PROCESS_ROOT

if (runRoot && (inheritedProcessRoot || testFile)) {
  const repoRoot = process.env.FOXWARM_TEST_REPO_ROOT || process.cwd()
  const relative = testFile ? path.relative(repoRoot, testFile).split(path.sep).join('/') : ''
  const slug = relative ? path.basename(relative).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80) : ''
  const digest = relative ? crypto.createHash('sha256').update(relative).digest('hex').slice(0, 12) : ''
  const processRoot = inheritedProcessRoot || path.join(runRoot, 'processes', `${slug}-${digest}`)
  const dataRoot = inheritedProcessRoot && process.env.FOXWARM_DATA_DIR
    ? process.env.FOXWARM_DATA_DIR
    : path.join(processRoot, 'data')
  const tempRoot = inheritedProcessRoot && process.env.TMPDIR
    ? process.env.TMPDIR
    : path.join(process.env.FOXWARM_TEST_TEMP_ROOT || path.join(runRoot, 'tmp'), digest)
  const isolateTemp = process.env.FOXWARM_TEST_KEEP_SYSTEM_TMP !== '1'
  fs.mkdirSync(dataRoot, { recursive: true })
  if (isolateTemp) fs.mkdirSync(tempRoot, { recursive: true })
  process.env.FOXWARM_TEST_PROCESS_ROOT = processRoot
  process.env.FOXWARM_DATA_DIR = dataRoot
  if (isolateTemp) {
    process.env.TMPDIR = tempRoot
    process.env.TMP = tempRoot
    process.env.TEMP = tempRoot
  }
}
