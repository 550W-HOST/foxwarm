import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const vscodeWebPackageRoot = path.resolve(scriptDir, '..');
export const yamlExtensionPin = JSON.parse(await fs.readFile(path.join(vscodeWebPackageRoot, 'yaml-extension-version.json'), 'utf8'));
export const defaultYamlExtensionDir = path.join(vscodeWebPackageRoot, 'assets', 'extensions', 'redhat.vscode-yaml');

export function yamlExtensionDirForWorkbenchOut(workbenchOutDir) {
  if (process.env.FOXWARM_VSCODE_YAML_EXTENSION_DIR) {
    return path.resolve(process.env.FOXWARM_VSCODE_YAML_EXTENSION_DIR);
  }
  return path.join(path.dirname(path.resolve(workbenchOutDir)), 'extensions', 'redhat.vscode-yaml');
}

function findEndOfCentralDirectory(archive) {
  const signature = 0x06054b50;
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error('VSIX has no ZIP end-of-central-directory record.');
}

async function extractVsix(archive, destination) {
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('VSIX central directory is invalid.');
    const flags = archive.readUInt16LE(centralOffset + 8);
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    centralOffset += 46 + nameLength + extraLength + commentLength;

    if (!name.startsWith('extension/')) continue;
    const relative = name.slice('extension/'.length);
    if (!relative || relative.endsWith('/')) continue;
    if ((flags & 0x1) !== 0) throw new Error(`Encrypted VSIX entry is unsupported: ${name}`);
    if (relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error(`Unsafe VSIX entry path: ${name}`);
    }
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`VSIX local entry is invalid: ${name}`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : undefined;
    if (!content) throw new Error(`Unsupported VSIX compression method ${method}: ${name}`);
    if (content.length !== uncompressedSize) throw new Error(`VSIX entry size mismatch: ${name}`);
    const output = path.join(destination, ...relative.split('/'));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, content);
  }
}

async function readPinnedNotice(relativePath) {
  return fs.readFile(path.join(vscodeWebPackageRoot, relativePath), 'utf8');
}

const telemetryConfiguredOriginal = 'isTelemetryConfigured(){return s(i.CONFIG_KEY+".enabled")}';
const telemetryConfiguredPatched = 'isTelemetryConfigured(){return s(i.CONFIG_KEY+".enabled")||!o().get("enabled",!1)}';

async function validateExtractedExtension(directory, requireFoxwarmPatch = true) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.publisher !== yamlExtensionPin.publisher
    || manifest.name !== yamlExtensionPin.name
    || manifest.version !== yamlExtensionPin.version
    || manifest.license !== yamlExtensionPin.license
    || manifest.browser !== './dist/extension-web') {
    throw new Error(`Prepared YAML extension manifest does not match pinned ${yamlExtensionPin.extensionId}@${yamlExtensionPin.version}.`);
  }
  const [license, notices, pinnedLicense, pinnedNotices] = await Promise.all([
    fs.readFile(path.join(directory, 'LICENSE.txt'), 'utf8'),
    fs.readFile(path.join(directory, 'thirdpartynotices.txt'), 'utf8'),
    readPinnedNotice(yamlExtensionPin.licenseFile),
    readPinnedNotice(yamlExtensionPin.noticesFile),
  ]);
  if (license !== pinnedLicense || notices !== pinnedNotices) {
    throw new Error('Prepared YAML extension license/notices do not match the reviewed pinned copies.');
  }
  if (requireFoxwarmPatch) {
    const webBundle = await fs.readFile(path.join(directory, 'dist', 'extension-web.js'), 'utf8');
    if (!webBundle.includes(telemetryConfiguredPatched) || webBundle.includes(telemetryConfiguredOriginal)) {
      throw new Error('Prepared YAML extension is missing the reviewed telemetry-default patch.');
    }
  }
}

async function applyFoxwarmPatch(directory) {
  const bundlePath = path.join(directory, 'dist', 'extension-web.js');
  const source = await fs.readFile(bundlePath, 'utf8');
  const occurrences = source.split(telemetryConfiguredOriginal).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Pinned YAML extension telemetry hook changed (expected one match, found ${occurrences}).`);
  }
  await fs.writeFile(bundlePath, source.replace(telemetryConfiguredOriginal, telemetryConfiguredPatched));
}

async function existingAssetMatches(outDir) {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(outDir, 'foxwarm-extension-assets.json'), 'utf8'));
    if (metadata.extensionId !== yamlExtensionPin.extensionId
      || metadata.version !== yamlExtensionPin.version
      || metadata.sha256 !== yamlExtensionPin.sha256) return false;
    await validateExtractedExtension(outDir);
    return true;
  } catch {
    return false;
  }
}

async function readArchive(archivePath) {
  if (archivePath) return fs.readFile(path.resolve(archivePath));
  const response = await fetch(yamlExtensionPin.artifact);
  if (!response.ok) throw new Error(`Failed to download ${yamlExtensionPin.extensionId}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function prepareYamlExtension({ outDir = defaultYamlExtensionDir, archivePath, force = false } = {}) {
  const resolvedOut = path.resolve(outDir);
  if (resolvedOut === path.parse(resolvedOut).root || resolvedOut === vscodeWebPackageRoot) {
    throw new Error(`Refusing unsafe YAML extension output directory: ${resolvedOut}`);
  }
  if (!force && await existingAssetMatches(resolvedOut)) {
    console.log(`Pinned ${yamlExtensionPin.extensionId}@${yamlExtensionPin.version} is ready at ${resolvedOut}`);
    return resolvedOut;
  }

  const archive = await readArchive(archivePath);
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  if (digest !== yamlExtensionPin.sha256) {
    throw new Error(`YAML extension SHA-256 mismatch: expected ${yamlExtensionPin.sha256}, received ${digest}.`);
  }

  const temporary = `${resolvedOut}.tmp-${process.pid}`;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(temporary, { recursive: true });
  try {
    await extractVsix(archive, temporary);
    await validateExtractedExtension(temporary, false);
    await applyFoxwarmPatch(temporary);
    await validateExtractedExtension(temporary);
    await fs.writeFile(path.join(temporary, 'foxwarm-extension-assets.json'), `${JSON.stringify({
      extensionId: yamlExtensionPin.extensionId,
      version: yamlExtensionPin.version,
      source: yamlExtensionPin.artifact,
      sha256: yamlExtensionPin.sha256,
      license: yamlExtensionPin.license,
      patches: ['honor-effective-telemetry-default-without-opt-in-prompt'],
    }, null, 2)}\n`);
    await fs.rm(resolvedOut, { recursive: true, force: true });
    await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
    await fs.rename(temporary, resolvedOut);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  console.log(`Prepared pinned ${yamlExtensionPin.extensionId}@${yamlExtensionPin.version} at ${resolvedOut}`);
  return resolvedOut;
}
