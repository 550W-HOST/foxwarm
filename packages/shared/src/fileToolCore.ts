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
  /** Exact parent path in a non-native target namespace. */
  parentPath?: string;
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
    ? 'the desired `filePath` and `createDirs: true`'
    : 'the desired `filePath` and `overwrite: true`';
  return ` The attempted content is already cached. Do not include or pass the \`content\` argument when using \`contentRef\`; it is unnecessary. To ${action}, call write({ ${params} }). The cached payload may instead be written to another authorized \`filePath\` in the same session/agent. If you intentionally want to correct or replace the attempted content instead, omit \`contentRef\` and call \`write\` with the new \`content\` plus ${replacementRequirements}. Never pass \`content\` and \`contentRef\` together.`;
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

  fullBuffer(): Buffer | null {
    return this.fullParts ? Buffer.concat(this.fullParts) : null;
  }

  samples(): { head: Buffer; tail: Buffer } {
    return { head: this.head, tail: this.tail };
  }
}

type ExactLineEnding = 'lf' | 'crlf' | 'bare-cr' | 'none' | 'empty';

type ExactLineScanResult = {
  selected: RangeByteCollector;
  selectedStartLine?: number;
  selectedEndLine?: number;
  selectedLineCount: number;
  selectedLinesHaveContent: boolean;
  selectedEnding: ExactLineEnding;
  reachedEof: boolean;
  totalLineCount?: number;
  fileEnding?: ExactLineEnding;
};

class ExactLineScanner {
  private readonly selected = new RangeByteCollector();
  private lineNumber = 1;
  private completedLineCount = 0;
  private currentLineHasContent = false;
  private pendingCr = false;
  private selectedStartLine?: number;
  private selectedEndLine?: number;
  private selectedLineCount = 0;
  private selectedLinesHaveContent = false;
  private selectedEnding: ExactLineEnding = 'empty';
  private fileEnding: ExactLineEnding = 'empty';

  constructor(
    private readonly startLine: number,
    private readonly endLine: number | undefined,
    private readonly stopAfterEnd: boolean,
  ) {}

  private includesCurrentLine(): boolean {
    return this.lineNumber >= this.startLine && (this.endLine === undefined || this.lineNumber <= this.endLine);
  }

  private appendContent(content: Buffer): void {
    if (content.length === 0) return;
    this.currentLineHasContent = true;
    this.fileEnding = 'none';
    if (this.includesCurrentLine()) this.selected.append(Buffer.from(content));
  }

  private finishLine(ending: Exclude<ExactLineEnding, 'empty'>, terminator?: Buffer): boolean {
    const included = this.includesCurrentLine();
    if (included) {
      if (terminator?.length) this.selected.append(terminator);
      this.selectedStartLine ??= this.lineNumber;
      this.selectedEndLine = this.lineNumber;
      this.selectedLineCount += 1;
      if (this.currentLineHasContent) this.selectedLinesHaveContent = true;
      this.selectedEnding = ending;
    }
    this.completedLineCount += 1;
    const completedLine = this.lineNumber;
    this.lineNumber += 1;
    this.currentLineHasContent = false;
    this.fileEnding = ending;
    return this.stopAfterEnd && this.endLine !== undefined && completedLine === this.endLine;
  }

  consume(buffer: Buffer): { stopped: boolean; consumed: number } {
    let index = 0;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (buffer[0] === 0x0a) {
        if (this.finishLine('crlf', Buffer.from([0x0d, 0x0a]))) return { stopped: true, consumed: 1 };
        index = 1;
      } else if (this.finishLine('bare-cr', Buffer.from([0x0d]))) {
        return { stopped: true, consumed: 0 };
      }
    }

    let contentStart = index;
    while (index < buffer.length) {
      const byte = buffer[index];
      if (byte !== 0x0a && byte !== 0x0d) {
        index += 1;
        continue;
      }
      this.appendContent(buffer.subarray(contentStart, index));
      if (byte === 0x0a) {
        index += 1;
        if (this.finishLine('lf', Buffer.from([0x0a]))) return { stopped: true, consumed: index };
      } else if (index + 1 < buffer.length) {
        if (buffer[index + 1] === 0x0a) {
          index += 2;
          if (this.finishLine('crlf', Buffer.from([0x0d, 0x0a]))) return { stopped: true, consumed: index };
        } else {
          index += 1;
          if (this.finishLine('bare-cr', Buffer.from([0x0d]))) return { stopped: true, consumed: index };
        }
      } else {
        this.pendingCr = true;
        index += 1;
      }
      contentStart = index;
    }
    this.appendContent(buffer.subarray(contentStart));
    return { stopped: false, consumed: buffer.length };
  }

  finishEof(): ExactLineScanResult {
    if (this.pendingCr) {
      this.pendingCr = false;
      this.finishLine('bare-cr', Buffer.from([0x0d]));
    } else if (this.currentLineHasContent) {
      this.finishLine('none');
    }
    return this.result(true);
  }

  result(reachedEof: boolean): ExactLineScanResult {
    return {
      selected: this.selected,
      selectedStartLine: this.selectedStartLine,
      selectedEndLine: this.selectedEndLine,
      selectedLineCount: this.selectedLineCount,
      selectedLinesHaveContent: this.selectedLinesHaveContent,
      selectedEnding: this.selectedEnding,
      reachedEof,
      ...(reachedEof ? { totalLineCount: this.completedLineCount, fileEnding: this.fileEnding } : {}),
    };
  }
}

async function scanFileLineRange(
  operations: FileOperations,
  fullPath: string,
  sourceSize: number,
  startLine: number,
  endLine?: number,
  stopAfterEnd = true,
): Promise<ExactLineScanResult> {
  const scanner = new ExactLineScanner(startLine, endLine, stopAfterEnd);
  let offset = 0;
  while (offset < sourceSize) {
    const buffer = await operations.read(fullPath, offset, Math.min(64 * 1024, sourceSize - offset));
    if (buffer.length === 0) break;
    offset += buffer.length;
    const consumed = scanner.consume(buffer);
    if (consumed.stopped) {
      return consumed.consumed === buffer.length && offset >= sourceSize
        ? scanner.finishEof()
        : scanner.result(false);
    }
  }
  return offset >= sourceSize ? scanner.finishEof() : scanner.result(false);
}

function formatRequestedLineRange(startLine: number, endLine?: number): string {
  return endLine === undefined ? `${startLine}-end` : `${startLine}-${endLine}`;
}

function lineCountText(lineCount: number): string {
  return `File has ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}.`;
}

function formatSelectedLines(scan: ExactLineScanResult, requestedStart: number, requestedEnd?: number): string {
  const start = scan.selectedStartLine!;
  const end = scan.selectedEndLine!;
  const selected = start === end ? `Selected line ${start}` : `Selected lines ${start}-${end}`;
  const total = scan.totalLineCount === undefined ? '' : ` of ${scan.totalLineCount}`;
  const requested = requestedEnd !== undefined && end < requestedEnd
    ? ` (requested lines ${requestedStart}-${requestedEnd})`
    : '';
  return `${selected}${total}${requested}.`;
}

function formatTextResult(content: string, ending: ExactLineEnding, footerLines: string[]): string {
  return `${content}${footerSeparatorForEnding(ending)}---\n${footerLines.join('\n')}`;
}

function footerSeparatorForEnding(ending: ExactLineEnding): string {
  return ending === 'lf' || ending === 'crlf' || ending === 'bare-cr' ? '' : '\n';
}

function buildRangeFooter(scan: ExactLineScanResult, start: number, end: number | undefined, sourceSize: number): string[] {
  const lines = [formatSelectedLines(scan, start, end), `File size: ${sourceSize} bytes.`];
  if (!scan.selectedLinesHaveContent) lines.push('Selected lines contain only empty content.');
  if (scan.reachedEof && scan.selectedEndLine === scan.totalLineCount && scan.fileEnding === 'none') {
    lines.push('File has no trailing newline.');
  }
  return lines;
}

function formatBoundedFileRead(
  displayPath: string,
  originalFileSize: number,
  head: Buffer,
  tail: Buffer,
  selectedByteCount: number,
  label: string,
  metadataLines: string[] = [],
  footerSeparator = '\n',
): string {
  const excerpt = buildBoundedTextExcerpt(head, tail, {
    headMayEndMidCodePoint: true,
    tailMayStartMidCodePoint: true,
  });
  const conversionNote = excerpt.escapedByteCount > 0
    ? `\n${formatDisplayByteConversionDisclaimer('file content')}`
    : '';
  const footerLines = [
    'File content was shortened for inline display.',
    ...metadataLines,
    `File size: ${originalFileSize} bytes.`,
    `Complete content remains in source file: ${displayPath}.`,
  ];
  const footerBody = `---\n${footerLines.join('\n')}${conversionNote}`;
  if (excerpt.isBinary) {
    return `${formatBoundedBinaryHexPreview(head, tail, selectedByteCount, label, label === 'selected file range' ? 'selected range' : 'file')}\n${footerBody}`;
  }
  const footer = `${footerSeparator}${footerBody}`;
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
      if (end !== undefined && end < start) {
        return `(no content in requested line range ${formatRequestedLineRange(start, end)})\n---\nFile size: ${stats.size} bytes.`;
      }
      const scan = await scanFileLineRange(operations, fullPath, stats.size, start, end);
      if (scan.selectedLineCount === 0) {
        const footer = [
          ...(scan.totalLineCount !== undefined ? [lineCountText(scan.totalLineCount)] : []),
          `File size: ${stats.size} bytes.`,
        ];
        return `(no content in requested line range ${formatRequestedLineRange(start, end)})\n---\n${footer.join('\n')}`;
      }
      const fullSelected = scan.selected.fullBuffer();
      if (fullSelected) {
        const selectedContent = fullSelected.toString('utf8');
        return `${formatTextResult(selectedContent, scan.selectedEnding, buildRangeFooter(scan, start, end, stats.size))}\nComplete content remains in source file: ${displayPath}.`;
      }
      const { head, tail } = scan.selected.samples();
      const metadata = [formatSelectedLines(scan, start, end)];
      if (!scan.selectedLinesHaveContent) metadata.push('Selected lines contain only empty content.');
      if (scan.reachedEof && scan.selectedEndLine === scan.totalLineCount && scan.fileEnding === 'none') {
        metadata.push('File has no trailing newline.');
      }
      return formatBoundedFileRead(
        displayPath,
        stats.size,
        head,
        tail,
        scan.selected.totalBytes,
        'selected file range',
        metadata,
        footerSeparatorForEnding(scan.selectedEnding),
      );
    }
    const sampleLength = Math.min(5000, stats.size);
    const head = await operations.read(fullPath, 0, sampleLength);
    const tail = await operations.read(fullPath, Math.max(0, stats.size - sampleLength), sampleLength);
    return formatBoundedFileRead(displayPath, stats.size, head, tail, stats.size, 'file content');
  }

  const buffer = await operations.read(fullPath, 0, stats.size);
  const hasRange = normalizedStartLine !== undefined || normalizedEndLine !== undefined;
  const start = normalizedStartLine !== undefined ? Math.max(1, Math.floor(normalizedStartLine)) : 1;
  const end = normalizedEndLine !== undefined ? Math.max(0, Math.floor(normalizedEndLine)) : undefined;
  const scanner = new ExactLineScanner(start, end, false);
  scanner.consume(buffer);
  const scan = scanner.finishEof();

  if (!hasRange) {
    if (scan.totalLineCount === 0) {
      return `(empty file)\n---\n${lineCountText(0)}\nFile size: ${stats.size} bytes.`;
    }
    const footer = [lineCountText(scan.totalLineCount!), `File size: ${stats.size} bytes.`];
    if (!scan.selectedLinesHaveContent) footer.push('File content contains only empty lines.');
    if (scan.fileEnding === 'none') footer.push('File has no trailing newline.');
    return formatTextResult(buffer.toString('utf8'), scan.fileEnding!, footer);
  }

  if (end !== undefined && end < start || scan.selectedLineCount === 0) {
    return `(no content in requested line range ${formatRequestedLineRange(start, end)})\n---\n${lineCountText(scan.totalLineCount!)}\nFile size: ${stats.size} bytes.`;
  }
  const selected = scan.selected.fullBuffer()!;
  return formatTextResult(selected.toString('utf8'), scan.selectedEnding, buildRangeFooter(scan, start, end, stats.size));
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
    await operations.mkdir(options.parentPath ?? path.dirname(fullPath));
  }

  try {
    await operations.write(fullPath, content, options.overwrite ? 'w' : 'wx');
  } catch (err: any) {
    if (err?.code === 'EEXIST' && !options.overwrite) {
      throw new Error(resolveExistsMessage(options.existsMessage));
    }

    if (options.createDirs !== true && shouldDiagnoseWriteParentError(err)) {
      let parentIssue: WriteParentIssue | null;
      if (options.parentPath !== undefined) {
        try {
          const stats = await operations.stat(options.parentPath);
          parentIssue = stats.kind === 'directory' ? null : { path: options.parentPath, reason: 'not-directory' };
        } catch (parentError: any) {
          if (parentError?.code !== 'ENOENT') throw parentError;
          parentIssue = { path: options.parentPath, reason: 'missing' };
        }
      } else {
        parentIssue = await findWriteParentIssue(fullPath, operations);
      }
      if (parentIssue) {
        throw new Error(formatWriteParentIssueMessage(parentIssue, options.parentIssueRetryHint?.(parentIssue)));
      }
    }

    throw err;
  }
}
