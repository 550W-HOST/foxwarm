import {
  escapeFoxwarmAttributeValue,
  unescapeFoxwarmAttributeValue,
} from './utils/promptWrappers';

const CONDITIONAL_OPEN_RE = /^[ \t]*<foxwarm-if model-id="([^"]*)">[ \t]*$/;
const CONDITIONAL_CLOSE_RE = /^[ \t]*<\/foxwarm-if>[ \t]*$/;
const CONDITIONAL_OPEN_LIKE_RE = /^[ \t]*<foxwarm-if\b.*$/;
const CONDITIONAL_CLOSE_LIKE_RE = /^[ \t]*<\/foxwarm-if\b.*$/;
const CURRENT_MODEL_HEADER_RE = /^<foxwarm-current-model model-id="([^"]*)" \/>$/;
const SNAPSHOT_HEADER_SEPARATOR = '\n\n';

type SourceLine = {
  content: string;
  start: number;
  end: number;
};

type ConditionalRange = {
  start: number;
  end: number;
  pattern: string;
};

type FenceState = {
  marker: '`' | '~';
  length: number;
};

function splitSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  while (start < source.length) {
    let cursor = start;
    while (cursor < source.length && source[cursor] !== '\r' && source[cursor] !== '\n') cursor += 1;

    const contentEnd = cursor;
    if (cursor < source.length) {
      if (source[cursor] === '\r' && source[cursor + 1] === '\n') cursor += 2;
      else cursor += 1;
    }

    lines.push({ content: source.slice(start, contentEnd), start, end: cursor });
    start = cursor;
  }

  return lines;
}

function openingFence(line: string): FenceState | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return undefined;

  const run = match[1];
  if (run[0] === '`' && line.slice(match[0].length).includes('`')) return undefined;
  return { marker: run[0] as '`' | '~', length: run.length };
}

function closesFence(line: string, fence: FenceState): boolean {
  const marker = fence.marker === '`' ? '`' : '~';
  const match = line.match(new RegExp(`^ {0,3}(${marker}{${fence.length},})[ \\t]*$`));
  return !!match;
}

function findFencedLines(lines: SourceLine[]): boolean[] {
  const fenced = lines.map(() => false);
  let active: FenceState | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].content;
    if (active) {
      fenced[index] = true;
      if (closesFence(line, active)) active = undefined;
      continue;
    }

    const opened = openingFence(line);
    if (opened) {
      fenced[index] = true;
      active = opened;
    }
  }

  return fenced;
}

type ConditionalToken =
  | { kind: 'open'; supported: true; pattern: string }
  | { kind: 'open'; supported: false }
  | { kind: 'close'; supported: boolean };

function parseConditionalToken(line: string): ConditionalToken | undefined {
  const open = line.match(CONDITIONAL_OPEN_RE);
  if (open) {
    return { kind: 'open', supported: true, pattern: unescapeFoxwarmAttributeValue(open[1]) };
  }
  if (CONDITIONAL_CLOSE_RE.test(line)) return { kind: 'close', supported: true };
  if (CONDITIONAL_OPEN_LIKE_RE.test(line)) return { kind: 'open', supported: false };
  if (CONDITIONAL_CLOSE_LIKE_RE.test(line)) return { kind: 'close', supported: false };
  return undefined;
}

function findConditionalRanges(lines: SourceLine[], fenced: boolean[]): ConditionalRange[] {
  const ranges: ConditionalRange[] = [];
  let index = 0;

  while (index < lines.length) {
    if (fenced[index]) {
      index += 1;
      continue;
    }

    const opening = parseConditionalToken(lines[index].content);
    if (opening?.kind !== 'open') {
      index += 1;
      continue;
    }

    let depth = 1;
    let supported = opening.supported;
    let nested = false;
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (fenced[cursor]) continue;
      const token = parseConditionalToken(lines[cursor].content);
      if (!token) continue;
      if (token.kind === 'open') {
        depth += 1;
        nested = true;
        if (!token.supported) supported = false;
        continue;
      }
      if (!token.supported) supported = false;
      depth -= 1;
      if (depth === 0) break;
    }

    if (cursor >= lines.length) {
      // The complete remaining region is ambiguous. Preserve it literally and
      // do not partially evaluate a later opener as an independent condition.
      break;
    }

    if (supported && !nested && opening.supported) {
      ranges.push({
        start: index,
        end: cursor,
        pattern: opening.pattern,
      });
    }
    index = cursor + 1;
  }

  return ranges;
}

function wildcardMatches(pattern: string, modelId: string): boolean {
  const escapedParts = pattern.split('*').map(part => part.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&'));
  return new RegExp(`^${escapedParts.join('.*')}$`).test(modelId);
}

/**
 * Applies complete, nonnested foxwarm-if blocks in one memory-source body.
 * Unsupported or malformed markup remains byte-for-byte literal.
 */
export function filterConditionalMemorySource(source: string, modelId: string): string {
  if (!source || !source.includes('<foxwarm-if')) return source;

  const lines = splitSourceLines(source);
  const ranges = findConditionalRanges(lines, findFencedLines(lines));
  if (ranges.length === 0) return source;

  let output = '';
  let sourceOffset = 0;
  for (const range of ranges) {
    const open = lines[range.start];
    const close = lines[range.end];
    output += source.slice(sourceOffset, open.start);
    if (wildcardMatches(range.pattern, modelId)) {
      output += source.slice(open.end, close.start);
    }
    sourceOffset = close.end;
  }
  output += source.slice(sourceOffset);
  return output;
}

function formatCurrentModelHeader(modelId: string): string {
  return `<foxwarm-current-model model-id="${escapeFoxwarmAttributeValue(modelId)}" />`;
}

/** Prefixes a materialized snapshot with its canonical concrete model identity. */
export function buildCurrentModelSnapshot(modelId: string, snapshotBody: string): string {
  return `${formatCurrentModelHeader(modelId)}${SNAPSHOT_HEADER_SEPARATOR}${snapshotBody}`;
}

/** Reads only the exact first-line header emitted by buildCurrentModelSnapshot. */
export function readCurrentModelSnapshotId(snapshot: string): string | undefined {
  const separatorIndex = snapshot.indexOf(SNAPSHOT_HEADER_SEPARATOR);
  if (separatorIndex < 0) return undefined;

  const firstLine = snapshot.slice(0, separatorIndex);
  const match = firstLine.match(CURRENT_MODEL_HEADER_RE);
  if (!match) return undefined;

  const modelId = unescapeFoxwarmAttributeValue(match[1]);
  if (!modelId || formatCurrentModelHeader(modelId) !== firstLine) return undefined;
  return modelId;
}
