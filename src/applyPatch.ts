export type ApplyPatchOperation =
  | { action: 'update'; filePath: string; hunks: ApplyPatchHunk[] }
  | { action: 'add'; filePath: string; lines: string[] }
  | { action: 'delete'; filePath: string };

export interface ApplyPatchHunk {
  anchors: string[];
  lines: string[];
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function extractPatchEnvelope(input: string): string {
  const normalized = normalizeNewlines(input);
  const beginIndex = normalized.indexOf('*** Begin Patch');
  const endIndex = normalized.lastIndexOf('*** End Patch');

  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    throw new Error('Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope.');
  }

  return normalized.slice(beginIndex, endIndex + '*** End Patch'.length).trim();
}

export function parseApplyPatchInput(input: string): ApplyPatchOperation[] {
  const envelope = extractPatchEnvelope(input);
  const lines = envelope.split('\n');

  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') {
    throw new Error('Invalid apply_patch input: malformed patch envelope.');
  }

  const body = lines.slice(1, -1);
  const operations: ApplyPatchOperation[] = [];
  let i = 0;

  const isFileHeader = (line: string) => (
    line.startsWith('*** Update File: ') ||
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ')
  );

  while (i < body.length) {
    while (i < body.length && body[i].trim() === '') i++;
    if (i >= body.length) break;

    const line = body[i];
    const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid apply_patch input: expected file action header, got: ${line}`);
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
      operations.push({ action, filePath, hunks: parseUpdateSection(sectionLines, filePath) });
    } else if (action === 'add') {
      operations.push({ action, filePath, lines: parseAddSection(sectionLines, filePath) });
    } else {
      if (sectionLines.some(line => line.trim() !== '')) {
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

function parseUpdateSection(lines: string[], filePath: string): ApplyPatchHunk[] {
  const hunks: ApplyPatchHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;

    const anchors: string[] = [];
    while (i < lines.length && lines[i].startsWith('@@')) {
      anchors.push(lines[i].slice(2).trim());
      i++;
    }

    const hunkLines: string[] = [];
    let sawChange = false;

    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith('@@') && hunkLines.length > 0 && sawChange) {
        break;
      }

      if (line.trim() === '' && sawChange) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j >= lines.length || lines[j].startsWith('@@')) {
          i = j;
          break;
        }
      }

      if (line.startsWith('-') || line.startsWith('+')) {
        sawChange = true;
      }

      hunkLines.push(line);
      i++;
    }

    if (!sawChange) {
      throw new Error(`Invalid apply_patch input for ${filePath}: update hunk must include at least one changed line.`);
    }

    hunks.push({ anchors, lines: hunkLines });
  }

  if (hunks.length === 0) {
    throw new Error(`Invalid apply_patch input for ${filePath}: update section must include at least one hunk.`);
  }

  return hunks;
}

function parseAddSection(lines: string[], filePath: string): string[] {
  const contentLines: string[] = [];

  for (const line of lines) {
    if (line === '') {
      contentLines.push('');
      continue;
    }

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

function buildHunkSnippets(hunk: ApplyPatchHunk): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of hunk.lines) {
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      continue;
    }
    oldLines.push(line);
    newLines.push(line);
  }

  return {
    oldText: oldLines.join('\n'),
    newText: newLines.join('\n'),
  };
}

function findAnchorOffset(content: string, anchors: string[], filePath: string): number {
  let offset = 0;

  for (const anchor of anchors) {
    const index = content.indexOf(anchor, offset);
    if (index === -1) {
      throw new Error(`Could not find @@ anchor "${anchor}" while patching ${filePath}.`);
    }
    offset = index;
  }

  return offset;
}

export function applyUpdateHunks(content: string, hunks: ApplyPatchHunk[], filePath: string): string {
  const lineEnding = getLineEnding(content);
  let updated = normalizeNewlines(content);

  for (const hunk of hunks) {
    const { oldText, newText } = buildHunkSnippets(hunk);
    const searchStart = findAnchorOffset(updated, hunk.anchors, filePath);
    const firstIndex = updated.indexOf(oldText, searchStart);

    if (firstIndex === -1) {
      throw new Error(`Could not find matching patch hunk in ${filePath}.`);
    }

    const secondIndex = updated.indexOf(oldText, firstIndex + 1);
    if (secondIndex !== -1) {
      throw new Error(`Patch hunk for ${filePath} is ambiguous: matched multiple locations.`);
    }

    updated = updated.slice(0, firstIndex) + newText + updated.slice(firstIndex + oldText.length);
  }

  return restoreLineEndings(updated, lineEnding);
}

export function buildAddedFileContent(lines: string[]): string {
  return lines.join('\n');
}
