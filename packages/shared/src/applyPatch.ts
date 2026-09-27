export type ApplyPatchOperation =
  | { action: 'update'; filePath: string; lines: string[] }
  | { action: 'add'; filePath: string; lines: string[] }
  | { action: 'delete'; filePath: string };

export interface ApplyPatchLineCounts {
  added: number;
  deleted: number;
}

interface ApplyPatchChunk {
  origIndex: number;
  delLines: string[];
  insLines: string[];
}

interface ParserState {
  lines: string[];
  index: number;
  fuzz: number;
}

const END_PATCH = '*** End Patch';
const END_FILE = '*** End of File';

const FORMAT_HINT = `Expected apply_patch format:
*** Begin Patch
*** Update File: <path>
@@ optional anchor
 context line (prefix with space)
-line to delete
+line to insert
*** Add File: <path>
+new file content line
*** Delete File: <path>
*** End Patch
For Update File: context lines start with space, deletions with '-', insertions with '+'. Use '@@' to start a new section. See the apply_patch tool description for full details.`;

const FILE_HEADER_PREFIXES = [
  '*** Update File: ',
  '*** Add File: ',
  '*** Delete File: ',
] as const;
const UPDATE_SECTION_TERMINATORS = [END_PATCH, END_FILE] as const;

function isFileHeader(line: string): boolean {
  return FILE_HEADER_PREFIXES.some(prefix => line.startsWith(prefix));
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function extractPatchEnvelope(input: string): string {
  const normalized = normalizeNewlines(input);
  const trimmed = normalized.trim();
  const beginIndex = normalized.indexOf('*** Begin Patch');
  const endIndex = normalized.lastIndexOf(END_PATCH);

  if (beginIndex !== -1 || endIndex !== -1) {
    if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
      throw new Error('Invalid apply_patch input: malformed patch envelope.');
    }

    return normalized.slice(beginIndex, endIndex + END_PATCH.length).trim();
  }

  if (trimmed) {
    const lines = trimmed.split('\n');
    if (isFileHeader(lines[0])) {
      return ['*** Begin Patch', trimmed, END_PATCH].join('\n');
    }
  }

  if (!trimmed) {
    throw new Error(`Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope.\n${FORMAT_HINT}`);
  }

  throw new Error(`Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope, or bare patch must start with *** Update File: / *** Add File: / *** Delete File:.\n${FORMAT_HINT}`);
}

export function parseApplyPatchInput(input: string): ApplyPatchOperation[] {
  const envelope = extractPatchEnvelope(input);
  const lines = envelope.split('\n');

  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== END_PATCH) {
    throw new Error('Invalid apply_patch input: malformed patch envelope.');
  }

  const body = lines.slice(1, -1);
  const operations: ApplyPatchOperation[] = [];
  let i = 0;

  while (i < body.length) {
    while (i < body.length && body[i].trim() === '') i++;
    if (i >= body.length) break;

    const line = body[i];
    const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid apply_patch input: expected file action header (*** Update File: / *** Add File: / *** Delete File:), got: ${line}\n${FORMAT_HINT}`);
    }

    const action = match[1].toLowerCase() as 'update' | 'add' | 'delete';
    const filePath = match[2].trim();
    i++;

    const sectionLines: string[] = [];
    while (i < body.length && !isFileHeader(body[i])) {
      sectionLines.push(body[i]);
      i++;
    }

    if (action === 'update') {
      operations.push({ action, filePath, lines: parseUpdateSection(sectionLines, filePath) });
    } else if (action === 'add') {
      operations.push({ action, filePath, lines: parseAddSection(sectionLines, filePath) });
    } else {
      if (sectionLines.some(lineText => lineText.trim() !== '')) {
        throw new Error(`Invalid apply_patch input for ${filePath}: delete section should not contain body lines.`);
      }
      operations.push({ action, filePath });
    }
  }

  if (operations.length === 0) {
    throw new Error('Invalid apply_patch input: patch contains no file operations.');
  }

  return operations;
}

function parseUpdateSection(lines: string[], filePath: string): string[] {
  if (lines.length === 0) {
    throw new Error(`Invalid apply_patch input for ${filePath}: update section must include patch lines.`);
  }

  if (!lines.some(line => line.startsWith('+') || line.startsWith('-'))) {
    throw new Error(`Invalid apply_patch input for ${filePath}: update section must include at least one changed line.`);
  }

  return lines;
}

function parseAddSection(lines: string[], filePath: string): string[] {
  const contentLines: string[] = [];

  for (const line of lines) {
    if (!line.startsWith('+')) {
      throw new Error(`Invalid apply_patch input for ${filePath}: add file lines must start with '+'.`);
    }

    contentLines.push(line.slice(1));
  }

  return contentLines;
}

function getLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function restoreLineEndings(text: string, lineEnding: '\n' | '\r\n'): string {
  return lineEnding === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

function isDone(state: ParserState, prefixes: readonly string[]): boolean {
  if (state.index >= state.lines.length) return true;
  return prefixes.some(prefix => state.lines[state.index]?.startsWith(prefix));
}

function readStr(state: ParserState, prefix: string): string {
  const current = state.lines[state.index];
  if (typeof current === 'string' && current.startsWith(prefix)) {
    state.index += 1;
    return current.slice(prefix.length);
  }
  return '';
}

function advanceCursorToAnchor(anchor: string, inputLines: string[], cursor: number, parser: ParserState): number {
  let found = false;

  if (!inputLines.slice(0, cursor).some(line => line === anchor)) {
    for (let i = cursor; i < inputLines.length; i += 1) {
      if (inputLines[i] === anchor) {
        cursor = i + 1;
        found = true;
        break;
      }
    }
  }

  if (!found && !inputLines.slice(0, cursor).some(line => line.trim() === anchor.trim())) {
    for (let i = cursor; i < inputLines.length; i += 1) {
      if (inputLines[i].trim() === anchor.trim()) {
        cursor = i + 1;
        parser.fuzz += 1;
        found = true;
        break;
      }
    }
  }

  return cursor;
}

function readSection(lines: string[], startIndex: number, filePath: string): {
  nextContext: string[];
  sectionChunks: ApplyPatchChunk[];
  endIndex: number;
  eof: boolean;
} {
  const context: string[] = [];
  let delLines: string[] = [];
  let insLines: string[] = [];
  const sectionChunks: ApplyPatchChunk[] = [];
  let mode: 'keep' | 'add' | 'delete' = 'keep';
  let index = startIndex;
  const origIndex = index;

  while (index < lines.length) {
    const raw = lines[index];
    if (raw.startsWith('@@') || raw.startsWith(END_PATCH) || raw.startsWith(END_FILE)) {
      break;
    }
    if (raw === '***') break;
    if (raw.startsWith('***')) {
      throw new Error(`Invalid apply_patch input for ${filePath}: invalid line: ${raw}\n${FORMAT_HINT}`);
    }

    index += 1;
    const lastMode: 'keep' | 'add' | 'delete' = mode;
    let line = raw;
    if (line === '') line = ' ';

    if (line[0] === '+') {
      mode = 'add';
    } else if (line[0] === '-') {
      mode = 'delete';
    } else if (line[0] === ' ') {
      mode = 'keep';
    } else {
      throw new Error(`Invalid apply_patch input for ${filePath}: invalid line: ${line}. Each line must start with ' ' (context), '-' (delete), or '+' (insert).\n${FORMAT_HINT}`);
    }

    line = line.slice(1);

    const switchingToContext = mode === 'keep' && lastMode !== mode;
    if (switchingToContext && (insLines.length > 0 || delLines.length > 0)) {
      sectionChunks.push({
        origIndex: context.length - delLines.length,
        delLines,
        insLines,
      });
      delLines = [];
      insLines = [];
    }

    if (mode === 'delete') {
      delLines.push(line);
      context.push(line);
    } else if (mode === 'add') {
      insLines.push(line);
    } else {
      context.push(line);
    }
  }

  if (insLines.length > 0 || delLines.length > 0) {
    sectionChunks.push({
      origIndex: context.length - delLines.length,
      delLines,
      insLines,
    });
  }

  if (index < lines.length && lines[index] === END_FILE) {
    index += 1;
    return { nextContext: context, sectionChunks, endIndex: index, eof: true };
  }

  if (index === origIndex) {
    throw new Error(`Invalid apply_patch input for ${filePath}: empty update section near line ${index + 1}.`);
  }

  return { nextContext: context, sectionChunks, endIndex: index, eof: false };
}

function equalsSlice(source: string[], target: string[], start: number, mapFn: (value: string) => string): boolean {
  if (start + target.length > source.length) return false;

  for (let i = 0; i < target.length; i += 1) {
    if (mapFn(source[start + i]) !== mapFn(target[i])) return false;
  }

  return true;
}

function findContextCore(lines: string[], context: string[], start: number): { newIndex: number; fuzz: number } {
  if (context.length === 0) {
    return { newIndex: start, fuzz: 0 };
  }

  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, value => value)) {
      return { newIndex: i, fuzz: 0 };
    }
  }

  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, value => value.trimEnd())) {
      return { newIndex: i, fuzz: 1 };
    }
  }

  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, value => value.trim())) {
      return { newIndex: i, fuzz: 100 };
    }
  }

  return { newIndex: -1, fuzz: 0 };
}

function findContext(lines: string[], context: string[], start: number, eof: boolean): { newIndex: number; fuzz: number } {
  if (eof) {
    const endStart = Math.max(0, lines.length - context.length);
    const endMatch = findContextCore(lines, context, endStart);
    if (endMatch.newIndex !== -1) return endMatch;

    const fallback = findContextCore(lines, context, start);
    return { newIndex: fallback.newIndex, fuzz: fallback.fuzz + 10000 };
  }

  return findContextCore(lines, context, start);
}

function parseUpdateDiff(lines: string[], input: string, filePath: string): { chunks: ApplyPatchChunk[]; fuzz: number } {
  const parser: ParserState = {
    lines: [...lines, END_PATCH],
    index: 0,
    fuzz: 0,
  };
  const inputLines = input.split('\n');
  const chunks: ApplyPatchChunk[] = [];
  let cursor = 0;

  while (!isDone(parser, UPDATE_SECTION_TERMINATORS)) {
    const anchor = readStr(parser, '@@ ');
    const hasBareAnchor = !anchor && parser.lines[parser.index] === '@@';
    if (hasBareAnchor) parser.index += 1;

    if (!(anchor || hasBareAnchor || cursor === 0)) {
      throw new Error(`Invalid apply_patch input for ${filePath}: expected '@@' before line: ${parser.lines[parser.index]}`);
    }

    if (anchor.trim()) {
      cursor = advanceCursorToAnchor(anchor, inputLines, cursor, parser);
    }

    const { nextContext, sectionChunks, endIndex, eof } = readSection(parser.lines, parser.index, filePath);
    const nextContextText = nextContext.join('\n');
    const { newIndex, fuzz } = findContext(inputLines, nextContext, cursor, eof);

    if (newIndex === -1) {
      if (eof) {
        throw new Error(`Could not match EOF context while patching ${filePath} starting at line ${cursor + 1}:\n${nextContextText}`);
      }
      throw new Error(`Could not match patch context while patching ${filePath} starting at line ${cursor + 1}:\n${nextContextText}`);
    }

    parser.fuzz += fuzz;
    for (const chunk of sectionChunks) {
      chunks.push({ ...chunk, origIndex: chunk.origIndex + newIndex });
    }

    cursor = newIndex + nextContext.length;
    parser.index = endIndex;
  }

  return { chunks, fuzz: parser.fuzz };
}

function applyChunks(input: string, chunks: ApplyPatchChunk[], filePath: string): string {
  const origLines = input.split('\n');
  const destLines: string[] = [];
  let origIndex = 0;

  for (const chunk of chunks) {
    if (chunk.origIndex > origLines.length) {
      throw new Error(`apply_patch failed for ${filePath}: chunk starts past end of file (${chunk.origIndex} > ${origLines.length}).`);
    }
    if (origIndex > chunk.origIndex) {
      throw new Error(`apply_patch failed for ${filePath}: overlapping chunk at ${chunk.origIndex} (cursor ${origIndex}).`);
    }

    destLines.push(...origLines.slice(origIndex, chunk.origIndex));
    origIndex = chunk.origIndex;

    if (chunk.insLines.length > 0) {
      destLines.push(...chunk.insLines);
    }

    origIndex += chunk.delLines.length;
  }

  destLines.push(...origLines.slice(origIndex));
  return destLines.join('\n');
}

export function applyUpdatePatch(content: string, lines: string[], filePath: string): string {
  const lineEnding = getLineEnding(content);
  const normalizedContent = normalizeNewlines(content);
  const { chunks } = parseUpdateDiff(lines, normalizedContent, filePath);
  const updated = applyChunks(normalizedContent, chunks, filePath);
  return restoreLineEndings(updated, lineEnding);
}

export function buildAddedFileContent(lines: string[]): string {
  return lines.join('\n');
}

export function countApplyPatchOperationLines(operation: ApplyPatchOperation): ApplyPatchLineCounts {
  if (operation.action === 'add') {
    return { added: operation.lines.length, deleted: 0 };
  }

  if (operation.action === 'delete') {
    return { added: 0, deleted: 0 };
  }

  let added = 0;
  let deleted = 0;
  for (const line of operation.lines) {
    if (line.startsWith('+')) added += 1;
    if (line.startsWith('-')) deleted += 1;
  }
  return { added, deleted };
}

export function formatApplyPatchOperationSummary(operation: ApplyPatchOperation, displayPath = operation.filePath): string {
  if (operation.action === 'delete') {
    return `Deleted ${displayPath}`;
  }

  const counts = countApplyPatchOperationLines(operation);
  if (operation.action === 'add') {
    return `Added ${displayPath} (+${counts.added})`;
  }

  return `Updated ${displayPath} (+${counts.added} -${counts.deleted})`;
}
