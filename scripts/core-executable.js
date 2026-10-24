'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.dirname(__dirname);

// The package boundary and one-shot frontends select the same managed payload.
// Configuration belongs to the installation, not the directory containing runtime binaries.
function coreExecutable() {
  const published = fs.existsSync(path.join(root, 'Foxwarm.dll'));
  const assembly = published
    ? path.join(root, 'Foxwarm.dll')
    : path.join(root, 'runtime', 'current', 'Foxwarm.dll');
  if (!fs.existsSync(assembly)) {
    throw new Error('Foxwarm managed build output is missing. Run `npm run build` (requires the .NET 10 SDK) first.');
  }
  const apphost = path.join(root, process.platform === 'win32' ? 'Foxwarm.exe' : 'Foxwarm');
  return published && fs.existsSync(apphost)
    ? { command: apphost, args: ['--installation-root', root] }
    : { command: 'dotnet', args: [fs.realpathSync(assembly), '--installation-root', root] };
}

module.exports = { coreExecutable };
