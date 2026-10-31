export interface TextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export type UnifiedEdit = { apply_patch: string } | { filePath: string; edits: TextEdit[] };

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function replacement(value: unknown): TextEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each edit must be an object.');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['oldText', 'newText', 'replaceAll'].includes(key))
    || typeof item.oldText !== 'string' || !item.oldText.length || typeof item.newText !== 'string'
    || (own(item, 'replaceAll') && typeof item.replaceAll !== 'boolean')) {
    throw new Error('Each edit requires nonempty oldText, string newText and optional boolean replaceAll.');
  }
  return item as unknown as TextEdit;
}

/** Validate all forms before resolving a path or performing file IO. */
export function parseUnifiedEdit(args: Record<string, unknown>): UnifiedEdit {
  if (own(args, 'apply_patch')) {
    if (Object.keys(args).length !== 1 || typeof args.apply_patch !== 'string' || !args.apply_patch.length) {
      throw new Error('edit apply_patch requires nonempty patch text and cannot be combined with replacement arguments.');
    }
    return { apply_patch: args.apply_patch };
  }
  if (typeof args.filePath !== 'string' || !args.filePath.trim()) throw new Error('edit requires filePath.');
  if (own(args, 'edits')) {
    if (Object.keys(args).some(key => !['filePath', 'edits'].includes(key)) || !Array.isArray(args.edits) || !args.edits.length) {
      throw new Error('edit requires a nonempty edits array without single-replacement arguments.');
    }
    return { filePath: args.filePath, edits: args.edits.map(replacement) };
  }
  if (Object.keys(args).some(key => !['filePath', 'oldText', 'newText', 'replaceAll'].includes(key))) throw new Error('Invalid edit arguments.');
  const { filePath, ...item } = args;
  return { filePath: args.filePath, edits: [replacement(item)] };
}

/** Match validated entries against the original source, reject conflicts, then build one literal result. */
export function applyTextEdits(content: string, edits: readonly TextEdit[]): string {
  const ranges: { start: number; end: number; text: string }[] = [];
  for (const item of edits) {
    let count = 0;
    for (let start = 0; (start = content.indexOf(item.oldText, start)) !== -1; start += item.oldText.length) {
      ranges.push({ start, end: start + item.oldText.length, text: item.newText });
      count++;
    }
    if (!count) throw new Error('Could not find oldText in file. Make sure whitespace matches exactly.');
    if (!item.replaceAll && count !== 1) throw new Error(`Found ${count} occurrences of oldText in file. Make oldText more specific or use replaceAll.`);
  }
  ranges.sort((a, b) => a.start - b.start);
  let cursor = 0;
  const result: string[] = [];
  for (const range of ranges) {
    if (range.start < cursor) throw new Error('Edit entries overlap in the original file.');
    result.push(content.slice(cursor, range.start), range.text);
    cursor = range.end;
  }
  result.push(content.slice(cursor));
  return result.join('');
}

export const UNIFIED_EDIT_DESCRIPTION = 'Edit files using exact text replacements or a patch. For one replacement, supply filePath, oldText and newText. For multiple replacements in one file, supply filePath and edits; all entries match the original content and must not overlap. Alternatively, supply apply_patch to add, modify or delete files using patch text. Use only one form per call.';

export function unifiedEditParameters(filePathDescription: string) {
  const item = {
    oldText: { type: 'string', minLength: 1, description: 'Exact text to replace. Must be nonempty and match once unless replaceAll is true.' },
    newText: { type: 'string', description: 'Replacement text. Use an empty string to delete the matched text.' },
    replaceAll: { type: 'boolean', description: 'Replace every non-overlapping occurrence of oldText. Defaults to false.' },
  };
  return {
    type: 'object', additionalProperties: false,
    properties: {
      filePath: { type: 'string', description: filePathDescription },
      ...item,
      edits: { type: 'array', minItems: 1, description: 'Replacements in one file, all matched against its original content. Entries must not overlap.', items: { type: 'object', additionalProperties: false, properties: item, required: ['oldText', 'newText'] } },
      apply_patch: { type: 'string', description: "Patch text enclosed in *** Begin Patch and *** End Patch. Use *** Update File:, *** Add File: or *** Delete File: headers. Update sections use space-prefixed context, - deletions, + additions and @@ anchors. Paths follow this Node's path rules. Do not combine with filePath or replacement arguments." },
    },
  };
}

/** Hide the legacy wire tool and project one current schema while keeping target path copy. */
export function projectUnifiedEditTools<T extends { name: string; description?: string; parameters?: any }>(tools: T[]): T[] {
  return tools.filter(tool => tool.name !== 'apply_patch').map(tool => tool.name === 'edit'
    ? { ...tool, description: UNIFIED_EDIT_DESCRIPTION, parameters: unifiedEditParameters(tool.parameters?.properties?.filePath?.description || '') }
    : tool);
}
