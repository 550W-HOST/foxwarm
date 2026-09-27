#!/usr/bin/env node
import path from 'node:path';
import { defaultYamlExtensionDir, prepareYamlExtension, yamlExtensionPin } from './yaml-extension-assets.mjs';

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--archive=')) options.archivePath = path.resolve(arg.slice('--archive='.length));
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run prepare:yaml-extension -- [--out=<dir>] [--archive=<vsix>] [--force]\n\nDownloads or reads, SHA-256 verifies, license-checks, and extracts the pinned MIT ${yamlExtensionPin.extensionId}@${yamlExtensionPin.version} Open VSX artifact.\n\nDefault output: ${defaultYamlExtensionDir}`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

prepareYamlExtension(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(`YAML extension preparation failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
