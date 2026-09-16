import { readFileSync } from 'node:fs';
import { buildCurrentModelSnapshot, filterConditionalMemorySource, readCurrentModelSnapshotId } from '../../src/conditionalMemory';
import { parseFunctionCallArgs, stringifyFunctionCallArgs } from '../../src/toolCallArgs';

type Case = { op: string; source?: string; modelId?: string; body?: string; snapshot?: string };
const corpus = JSON.parse(readFileSync(new URL('./parity-corpus.json', import.meta.url), 'utf8')) as Case[];
const results = corpus.map(item => {
  if (item.op === 'filter') return { kind: 'value', value: filterConditionalMemorySource(item.source ?? '', item.modelId ?? '') };
  if (item.op === 'build') return { kind: 'value', value: buildCurrentModelSnapshot(item.modelId ?? '', item.body ?? '') };
  if (item.op === 'message') return { kind: 'value', value: JSON.parse(item.message ?? '') };
  if (item.op === 'visible') return { kind: 'value', value: JSON.parse(item.message ?? '').modelVisible !== false };
  if (item.op === 'argsStringify') return { kind: 'value', value: stringifyFunctionCallArgs({ args: item.args ?? {}, rawArgsText: item.rawArgsText, argsParseError: item.argsParseError }) };
  if (item.op === 'argsParse') return { kind: 'value', value: parseFunctionCallArgs(item.rawArgsText) };
  const value = readCurrentModelSnapshotId(item.snapshot ?? '');
  return value === undefined ? { kind: 'undefined' } : { kind: 'value', value };
});
process.stdout.write(JSON.stringify(results));
