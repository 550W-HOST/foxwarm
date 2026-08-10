import path from 'path';
import {
  MAX_FULL_TEXT_READ_BYTES,
  buildBoundedTextExcerpt,
  formatBoundedBinaryHexPreview,
  formatDisplayByteConversionDisclaimer,
} from './boundedTextExcerpt';
import {
  nativeFileOperations,
  type FileOperations,
} from './fileOperations';

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

function formatDirectoryListingLine(entry: Awaited<ReturnType<FileOperations['readdir']>>[number], itemNumber: number): string {
  const name = entry.kind === 'directory' ? `${entry.name}/` : entry.name;
  const sizeLabel = entry.kind === 'file' ? `, ${entry.size} B` : '';
  const typeLabel = entry.kind === 'directory' ? 'dir' : entry.kind;
  return `${itemNumber}. \`${name}\` (${typeLabel}${sizeLabel}) - ${new Date(entry.modifiedAtMs).toISOString()}`;
}

export async function readDirectoryListing(
  fullPath: string,
  displayPath: string,
  startLine?: number,
  endLine?: number,
  operations: FileOperations = nativeFileOperations,
): Promise<string> {
  const entries = await operations.readdir(fullPath);
  entries.sort((a, b) => a.name.localeCompare(b.name));

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

class RangeByteCollector {
  totalBytes = 0;
  private fullParts: Buffer[] | null = [];
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);

  append(part: Buffer): void {
    if (part.length === 0) return;
    this.totalBytes += part.length;
    if (this.fullParts) {
      this.fullParts.push(part);
      if (this.totalBytes > MAX_FULL_TEXT_READ_BYTES) this.fullParts = null;
    }
    if (this.head.length < 5000) this.head = Buffer.concat([this.head, part.subarray(0, 5000 - this.head.length)]);
    this.tail = Buffer.concat([this.tail, part]).subarray(Math.max(0, this.tail.length + part.length - 5000));
  }

  trimTrailingLf(): void {
    if (this.totalBytes === 0 || this.tail[this.tail.length - 1] !== 0x0a) return;
    this.totalBytes -= 1;
    this.tail = this.tail.subarray(0, -1);
    if (this.totalBytes < 5000) this.head = this.head.subarray(0, -1);
    if (this.fullParts?.length) {
      const last = this.fullParts.length - 1;
      this.fullParts[last] = this.fullParts[last].subarray(0, -1);
    }
  }

  fullBuffer(): Buffer | null {
    return this.fullParts ? Buffer.concat(this.fullParts) : null;
  }

  samples(): { head: Buffer; tail: Buffer } {
    return { head: this.head, tail: this.tail };
  }
}

async function readLineRangeBounded(
  operations: FileOperations,
  fullPath: string,
  sourceSize: number,
  startLine: number,
  endLine?: number,
): Promise<{ selected: RangeByteCollector; endedAtRequestedLine: boolean }> {
  const selected = new RangeByteCollector();
  let line = 1;
  let offset = 0;
  let endedAtRequestedLine = false;
  outer: while (offset < sourceSize) {
    const buffer = await operations.read(fullPath, offset, Math.min(64 * 1024, sourceSize - offset));
    if (buffer.length === 0) break;
    offset += buffer.length;
    let segmentStart = -1;
    for (let index = 0; index < buffer.length; index += 1) {
      const include = line >= startLine && (endLine === undefined || line <= endLine);
      if (include && segmentStart < 0) segmentStart = index;
      if (buffer[index] !== 0x0a) continue;
      if (include && segmentStart >= 0) {
        selected.append(Buffer.from(buffer.subarray(segmentStart, index + 1)));
        segmentStart = -1;
      }
      if (endLine !== undefined && line === endLine) {
        endedAtRequestedLine = true;
        break outer;
      }
      line += 1;
    }
    if (segmentStart >= 0) selected.append(Buffer.from(buffer.subarray(segmentStart)));
  }
  if (endedAtRequestedLine) selected.trimTrailingLf();
  return { selected, endedAtRequestedLine };
}

function formatBoundedFileRead(
  displayPath: string,
  originalFileSize: number,
  head: Buffer,
  tail: Buffer,
  selectedByteCount: number,
  label: string,
): string {
  const excerpt = buildBoundedTextExcerpt(head, tail, {
    headMayEndMidCodePoint: true,
    tailMayStartMidCodePoint: true,
  });
  const conversionNote = excerpt.escapedByteCount > 0
    ? `\n${formatDisplayByteConversionDisclaimer('file content')}`
    : '';
  const footer = `\n---\nFile content was shortened for inline display.\nOriginal file size: ${originalFileSize} bytes.\nComplete content remains in source file: ${displayPath}.${conversionNote}`;
  if (excerpt.isBinary) return `${formatBoundedBinaryHexPreview(head, tail, selectedByteCount, label, label === 'selected file range' ? 'selected range' : 'file')}${footer}`;
  const escapedByteNote = excerpt.escapedByteCount > 0 ? `; escaped ${excerpt.escapedByteCount} byte(s)` : '';
  return [
    excerpt.renderedHead!,
    `[foxwarm: ${label} middle omitted; showing bounded head and tail samples from ${selectedByteCount}-byte selected content${escapedByteNote}]`,
    excerpt.renderedTail!,
  ].join('\n') + footer;
}

export async function readFileToolPath(
  fullPath: string,
  displayPath: string,
  startLine?: number,
  endLine?: number,
  operations: FileOperations = nativeFileOperations,
): Promise<FileToolReadResult> {
  const stats = await operations.stat(fullPath);
  if (stats.kind === 'directory') {
    return readDirectoryListing(fullPath, displayPath, startLine, endLine, operations);
  }

  const mimeType = getInlineImageMimeType(fullPath);
  if (mimeType) {
    const buffer = await operations.read(fullPath, 0, stats.size);
    return {
      output: `[Image loaded: ${displayPath}]`,
      mimeType,
      sizeBytes: buffer.length,
      inlineData: { data: buffer.toString('base64'), mimeType },
    };
  }

  const normalizedStartLine = normalizeOptionalLineBound(startLine);
  const normalizedEndLine = normalizeOptionalLineBound(endLine);
  if (stats.size > MAX_FULL_TEXT_READ_BYTES) {
    if (normalizedStartLine !== undefined || normalizedEndLine !== undefined) {
      const start = normalizedStartLine !== undefined ? Math.max(1, Math.floor(normalizedStartLine)) : 1;
      const end = normalizedEndLine !== undefined ? Math.max(0, Math.floor(normalizedEndLine)) : undefined;
      const { selected } = await readLineRangeBounded(operations, fullPath, stats.size, start, end);
      const fullSelected = selected.fullBuffer();
      if (fullSelected) {
        return `${fullSelected.toString('utf8')}\n---\nOriginal file size: ${stats.size} bytes.\nComplete content remains in source file: ${displayPath}.`;
      }
      const { head, tail } = selected.samples();
      return formatBoundedFileRead(displayPath, stats.size, head, tail, selected.totalBytes, 'selected file range');
    }
    const sampleLength = Math.min(5000, stats.size);
    const head = await operations.read(fullPath, 0, sampleLength);
    const tail = await operations.read(fullPath, Math.max(0, stats.size - sampleLength), sampleLength);
    return formatBoundedFileRead(displayPath, stats.size, head, tail, stats.size, 'file content');
  }

  let content = (await operations.read(fullPath, 0, stats.size)).toString('utf8');
  if (normalizedStartLine !== undefined || normalizedEndLine !== undefined) {
    const lines = content.split('\n');
    const start = normalizedStartLine !== undefined ? Math.max(0, normalizedStartLine - 1) : 0;
    const end = normalizedEndLine !== undefined ? Math.min(lines.length, normalizedEndLine) : lines.length;
    content = lines.slice(start, end).join('\n');
  }
  return content;
}

export async function findWriteParentIssue(fullPath: string, operations: FileOperations = nativeFileOperations): Promise<WriteParentIssue | null> {
  const parentDir = path.resolve(path.dirname(fullPath));
  const root = path.parse(parentDir).root;
  const relativeParent = path.relative(root, parentDir);
  if (!relativeParent) return null;

  let current = root;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stats = await operations.stat(current);
      if (stats.kind !== 'directory') return { path: current, reason: 'not-directory' };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { path: current, reason: 'missing' };
      throw err;
    }
  }
  return null;
}

export function formatWriteParentIssueMessage(issue: WriteParentIssue, retryHint?: string): string {
  const base = issue.reason === 'missing'
    ? `Parent directory does not exist: ${issue.path}. write does not create parent directories by default. Retry with createDirs=true to create missing parent directories.`
    : `Parent path is not a directory: ${issue.path}.`;
  return retryHint ? `${base}${retryHint}` : base;
}

export async function ensureWriteParentReady(fullPath: string, createDirs?: boolean, operations: FileOperations = nativeFileOperations): Promise<void> {
  if (createDirs === true) {
    await operations.mkdir(path.dirname(fullPath));
    return;
  }

  const parentIssue = await findWriteParentIssue(fullPath, operations);
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

export async function writeFileToolPath(
  fullPath: string,
  content: string,
  options: WriteFileToolPathOptions,
  operations: FileOperations = nativeFileOperations,
): Promise<void> {
  if (options.createDirs === true) {
    await operations.mkdir(path.dirname(fullPath));
  }

  try {
    await operations.write(fullPath, content, options.overwrite ? 'w' : 'wx');
  } catch (err: any) {
    if (err?.code === 'EEXIST' && !options.overwrite) {
      throw new Error(resolveExistsMessage(options.existsMessage));
    }

    if (options.createDirs !== true && shouldDiagnoseWriteParentError(err)) {
      const parentIssue = await findWriteParentIssue(fullPath, operations);
      if (parentIssue) {
        throw new Error(formatWriteParentIssueMessage(parentIssue, options.parentIssueRetryHint?.(parentIssue)));
      }
    }

    throw err;
  }
}
