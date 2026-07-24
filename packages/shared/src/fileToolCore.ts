import fs from 'fs-extra';
import path from 'path';
import type { Stats } from 'fs';

export type FileToolInlineImageResult = {
  output: string;
  mimeType: string;
  sizeBytes: number;
  inlineData: { data: string; mimeType: string };
};

export type FileToolReadResult = string | FileToolInlineImageResult;

export type WriteParentIssue = {
  path: string;
  reason: 'missing' | 'not-directory';
};

export type WriteFileToolPathOptions = {
  overwrite: boolean;
  existsMessage: string | (() => string);
  createDirs?: boolean;
  parentIssueRetryHint?: (issue: WriteParentIssue) => string | undefined;
};

export function formatWriteContentRefRetryHint(filePath: string, contentRef: string, createDirs = false): string {
  const params = [
    `filePath: ${JSON.stringify(filePath)}`,
    `contentRef: ${JSON.stringify(contentRef)}`,
    'overwrite: true',
    ...(createDirs ? ['createDirs: true'] : []),
  ].join(', ');
  const action = createDirs
    ? 'retry and create the missing parent directories'
    : 'confirm overwriting';
  const replacementRequirements = createDirs
    ? 'the same `filePath` and `createDirs: true`'
    : 'the same `filePath` and `overwrite: true`';
  return ` The attempted content is already cached. Do not include or pass the \`content\` argument when using \`contentRef\`; it is unnecessary. To ${action}, call write({ ${params} }). If you intentionally want to correct or replace the attempted content instead, omit \`contentRef\` and call \`write\` with the new \`content\` plus ${replacementRequirements}. Never pass \`content\` and \`contentRef\` together.`;
}

const INLINE_IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

type DirectoryListingEntry = {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
  modifiedAt: string;
};

export function normalizeOptionalLineBound(value: number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return undefined;
  return numeric;
}

function normalizeDirectoryListingStartEnd(startLine: number | undefined, endLine: number | undefined, totalItems: number): { startItem: number; endItem: number } {
  const normalizedStartLine = normalizeOptionalLineBound(startLine);
  const normalizedEndLine = normalizeOptionalLineBound(endLine);
  const startItem = normalizedStartLine !== undefined
    ? Math.max(1, Math.floor(normalizedStartLine))
    : 1;
  const endItem = normalizedEndLine !== undefined
    ? Math.max(0, Math.floor(normalizedEndLine))
    : Math.min(totalItems, startItem + 49);
  return { startItem, endItem };
}

function formatDirectoryListingLine(entry: DirectoryListingEntry, itemNumber: number): string {
  const name = entry.type === 'directory' ? `${entry.name}/` : entry.name;
  const sizeLabel = entry.type === 'file' && typeof entry.size === 'number' ? `, ${entry.size} B` : '';
  const typeLabel = entry.type === 'directory' ? 'dir' : entry.type;
  return `${itemNumber}. \`${name}\` (${typeLabel}${sizeLabel}) - ${entry.modifiedAt}`;
}

export async function readDirectoryListing(fullPath: string, displayPath: string, startLine?: number, endLine?: number): Promise<string> {
  const dirents = await fs.readdir(fullPath, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  const entries: DirectoryListingEntry[] = [];
  for (const dirent of dirents) {
    const entryPath = path.join(fullPath, dirent.name);
    const entryStats = await fs.lstat(entryPath);
    entries.push({
      name: dirent.name,
      type: dirent.isDirectory() ? 'directory' : (dirent.isFile() ? 'file' : (dirent.isSymbolicLink() ? 'symlink' : 'other')),
      size: dirent.isFile() ? entryStats.size : undefined,
      modifiedAt: entryStats.mtime.toISOString(),
    });
  }

  const totalItems = entries.length;
  const { startItem, endItem } = normalizeDirectoryListingStartEnd(startLine, endLine, totalItems);
  const pageEntries = startItem <= endItem
    ? entries.slice(Math.max(0, startItem - 1), Math.min(totalItems, endItem))
    : [];

  const lines: string[] = [`Directory listing for \`${displayPath}\``, ''];
  if (pageEntries.length === 0) {
    lines.push(totalItems === 0 ? '(empty directory)' : '(no items in requested range)');
  } else {
    lines.push(...pageEntries.map((entry, index) => formatDirectoryListingLine(entry, startItem + index)));
  }

  lines.push('');
  const shownStart = pageEntries.length > 0 ? startItem : 0;
  const shownEnd = pageEntries.length > 0 ? startItem + pageEntries.length - 1 : 0;
  const footer = [`Showing items ${shownStart}-${shownEnd} of ${totalItems}.`];
  const nextStart = startItem + pageEntries.length;
  if (nextStart <= totalItems) {
    const nextEnd = Math.min(totalItems, nextStart + 49);
    footer.push(`Next page: read({ filePath: ${JSON.stringify(displayPath)}, startLine: ${nextStart}, endLine: ${nextEnd} })`);
  }
  lines.push(footer.join(' '));

  return lines.join('\n');
}

export function getInlineImageMimeType(filePath: string): string | undefined {
  return INLINE_IMAGE_MIME[path.extname(filePath).toLowerCase()];
}

export async function readFileToolPath(fullPath: string, displayPath: string, startLine?: number, endLine?: number): Promise<FileToolReadResult> {
  const stats = await fs.stat(fullPath);
  if (stats.isDirectory()) {
    return readDirectoryListing(fullPath, displayPath, startLine, endLine);
  }

  const mimeType = getInlineImageMimeType(fullPath);
  if (mimeType) {
    const buffer = await fs.readFile(fullPath);
    return {
      output: `[Image loaded: ${displayPath}]`,
      mimeType,
      sizeBytes: buffer.length,
      inlineData: { data: buffer.toString('base64'), mimeType },
    };
  }

  let content = await fs.readFile(fullPath, 'utf8');
  const normalizedStartLine = normalizeOptionalLineBound(startLine);
  const normalizedEndLine = normalizeOptionalLineBound(endLine);
  if (normalizedStartLine !== undefined || normalizedEndLine !== undefined) {
    const lines = content.split('\n');
    const start = normalizedStartLine !== undefined ? Math.max(0, normalizedStartLine - 1) : 0;
    const end = normalizedEndLine !== undefined ? Math.min(lines.length, normalizedEndLine) : lines.length;
    content = lines.slice(start, end).join('\n');
  }
  return content;
}

export async function findWriteParentIssue(fullPath: string): Promise<WriteParentIssue | null> {
  const parentDir = path.resolve(path.dirname(fullPath));
  const root = path.parse(parentDir).root;
  const relativeParent = path.relative(root, parentDir);
  if (!relativeParent) return null;

  let current = root;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stats: Stats;
    try {
      stats = await fs.stat(current);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { path: current, reason: 'missing' };
      throw err;
    }
    if (!stats.isDirectory()) return { path: current, reason: 'not-directory' };
  }
  return null;
}

export function formatWriteParentIssueMessage(issue: WriteParentIssue, retryHint?: string): string {
  const base = issue.reason === 'missing'
    ? `Parent directory does not exist: ${issue.path}. write does not create parent directories by default. Retry with createDirs=true to create missing parent directories.`
    : `Parent path is not a directory: ${issue.path}.`;
  return retryHint ? `${base}${retryHint}` : base;
}

export async function ensureWriteParentReady(fullPath: string, createDirs?: boolean): Promise<void> {
  if (createDirs === true) {
    await fs.ensureDir(path.dirname(fullPath));
    return;
  }

  const parentIssue = await findWriteParentIssue(fullPath);
  if (parentIssue) {
    throw new Error(formatWriteParentIssueMessage(parentIssue));
  }
}

function resolveExistsMessage(existsMessage: string | (() => string)): string {
  return typeof existsMessage === 'function' ? existsMessage() : existsMessage;
}

function shouldDiagnoseWriteParentError(err: any): boolean {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}

export async function writeFileToolPath(fullPath: string, content: string, options: WriteFileToolPathOptions): Promise<void> {
  if (options.createDirs === true) {
    await fs.ensureDir(path.dirname(fullPath));
  }

  try {
    await fs.writeFile(fullPath, content, { flag: options.overwrite ? 'w' : 'wx' });
  } catch (err: any) {
    if (err?.code === 'EEXIST' && !options.overwrite) {
      throw new Error(resolveExistsMessage(options.existsMessage));
    }

    if (options.createDirs !== true && shouldDiagnoseWriteParentError(err)) {
      const parentIssue = await findWriteParentIssue(fullPath);
      if (parentIssue) {
        throw new Error(formatWriteParentIssueMessage(parentIssue, options.parentIssueRetryHint?.(parentIssue)));
      }
    }

    throw err;
  }
}
