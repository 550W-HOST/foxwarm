'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.dirname(__dirname);

// The package boundary and one-shot frontends select the same managed payload.
// Configuration belongs to the installation, not the directory containing Debug binaries.
function coreExecutable() {
  const published = fs.existsSync(path.join(root, 'Foxwarm.dll'));
  const assembly = published
    ? path.join(root, 'Foxwarm.dll')
    : path.join(root, 'dotnet', 'Foxwarm', 'bin', 'Debug', 'net10.0', 'Foxwarm.dll');
  if (!fs.existsSync(assembly)) {
    throw new Error('Foxwarm managed build output is missing. Run `npm run build` (requires the .NET 10 SDK) first.');
  }
  const apphost = path.join(root, process.platform === 'win32' ? 'Foxwarm.exe' : 'Foxwarm');
  return published && fs.existsSync(apphost)
    ? { command: apphost, args: [] }
    : { command: 'dotnet', args: [assembly] };
}

function coreEnvironment(env = process.env) {
  return { ...env, FOXWARM_APP_ROOT: path.resolve(env.FOXWARM_APP_ROOT || root) };
}

module.exports = { coreExecutable, coreEnvironment };
