import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(websiteRoot, '..');
const publicDir = path.join(websiteRoot, 'public');

await mkdir(publicDir, { recursive: true });

const copies = [
  ['install-foxwarm.sh', 'install-foxwarm.sh'],
  ['install-foxwarm.ps1', 'install-foxwarm.ps1'],
  ['packages/webui/public/favicon.svg', 'favicon.svg'],
  ['packages/webui/public/favicon-32x32.png', 'favicon-32x32.png'],
  ['packages/webui/public/favicon-128x128.png', 'favicon-128x128.png']
];

for (const [source, destination] of copies) {
  await copyFile(path.join(repositoryRoot, source), path.join(publicDir, destination));
}
