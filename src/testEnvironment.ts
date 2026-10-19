// Test entry points import this before application modules, including when run
// directly without the repository runner's preload.
require('../scripts/test/test-process-env.cjs').initializeTestEnvironment();
