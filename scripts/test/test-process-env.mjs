import testEnvironment from './test-process-env.cjs'

// Ordinary fixture subprocesses inherit their parent's owned environment. Do
// not replace a child fixture's explicit data/config overrides on every spawn.
if (process.env.FOXWARM_TEST_RUN_ROOT && process.env.NODE_TEST_CONTEXT && !process.env.FOXWARM_TEST_PROCESS_ROOT) {
  testEnvironment.initializeTestEnvironment()
}
