// Entry for `node browser-host.bundle.cjs`.
//   (no flag)   serve the line protocol on stdin/stdout until stdin closes
//   --describe  print {"available", "reason"?, "tools"} once and exit; launches nothing
import { BrowserManager, definitions } from './manager.js';
import { locateChromium } from './chromium.js';
import { serve } from './server.js';

// stdout carries the protocol only.
const protocolOutput = process.stdout;
console.log = (...parts) => console.error(...parts);

if (process.argv.includes('--describe')) {
  const found = locateChromium();
  const description = { tools: definitions(), available: !!found.path };
  if (!found.path) description.reason = found.reason;
  protocolOutput.write(JSON.stringify(description) + '\n', () => process.exit(0));
} else {
  const manager = new BrowserManager();
  const stop = () => void manager.close().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('uncaughtException', (error) => console.error('browser host:', error));
  process.on('unhandledRejection', (error) => console.error('browser host:', error));
  serve({ input: process.stdin, output: protocolOutput, manager, onExit: () => process.exit(0) });
}
