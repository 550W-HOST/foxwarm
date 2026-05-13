import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';

import { getAgentDir } from './config';
import { logger } from './common';
import { nodesManager } from './nodes/manager';
import { formatStructuredValue, formatToolResponsePayload } from '../packages/shared/dist/toolResponseFormatting';
import { takeUnicodeSafe, takeUnicodeSafeEnd, truncateUnicodeSafe } from './utils/unicode';

export const TOOL_OUTPUT_GUARD_CHAR_LIMIT = 40000;
const TOOL_OUTPUT_GUARD_EXCERPT_LIMIT = 30000;
const TOOL_OUTPUT_GUARD_STAGE_B_EXCERPT_LIMIT = 18000;
const PRESERVED_VALUE_CHAR_LIMIT = 2000;

const SHALLOW_PRESERVE_KEYS = new Set([
  'fullPath',
  'path',
  'filePath',
  'node',
  'nodeId',
  'fullOutputPath',
  'fullOutputNode',
  'outputFullPath',
  'outputFullNode',
  'outputOriginalLengthChars',
  'outputTruncated',
  'mimeType',
  'mime_type',
  'sizeBytes',
  'sha256',
  'runId',
  'status',
  'mode',
  'ownerSessionId',
  'scriptPath',
  'executedTools',
  'waitingReason',
  'continuationId',
  'createdAt',
  'updatedAt',
  'completedAt',
  'cancelledAt',
  'timeoutSecs',
  'hostCallCount',
  'error',
]);

type ToolOutputGuardOptions = {
  sessionId?: string;
  session?: any;
  toolName: string;
  toolUseId: string;
  nodeId?: string;
};

type SavedToolOutput = {
  relativePath: string;
  nodeId: string;
  lengthChars: number;
  sha256: string;
};

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizePathSegment(value: unknown, fallback: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function buildToolOutputRelativePath(options: ToolOutputGuardOptions, suffix: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeSessionId = sanitizePathSegment(options.sessionId || options.session?.id || 'session', 'session');
  const safeToolName = sanitizePathSegment(options.toolName, 'tool');
  const safeToolUseId = sanitizePathSegment(options.toolUseId, 'call');
  const unique = crypto.randomBytes(4).toString('hex');
  const fileName = `${Date.now()}_${safeToolName}_${safeToolUseId}_${suffix}_${unique}.txt`;
  return path.join('.temp', 'tool-outputs', date, safeSessionId, fileName);
}

async function saveCompleteText(text: string, options: ToolOutputGuardOptions, suffix: string): Promise<SavedToolOutput> {
  const agentName = options.session?.agent || 'main';
  const nodeId = options.nodeId || 'master';
  const relativePath = buildToolOutputRelativePath(options, suffix);
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');

  if (nodeId === 'master') {
    const fullPath = path.resolve(getAgentDir(agentName), relativePath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, text, 'utf8');
  } else {
    if (!options.sessionId) {
      throw new Error('Cannot save oversized remote tool output without session context.');
    }
    await nodesManager.writeFileToNode(
      nodeId,
      relativePath,
      Buffer.from(text, 'utf8').toString('base64'),
      false,
      options.sessionId,
    );
  }

  return {
    relativePath,
    nodeId,
    lengthChars: text.length,
    sha256,
  };
}

function buildExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const marker = `\n\n[...TRUNCATED: ${text.length - maxChars} characters omitted...]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.62);
  const tailLength = Math.max(0, available - headLength);
  return `${takeUnicodeSafe(text, headLength)}${marker}${tailLength > 0 ? takeUnicodeSafeEnd(text, tailLength) : ''}`;
}

function buildReadHint(saved: SavedToolOutput): string {
  const readCall = `read({"filePath":"${saved.relativePath}"})`;
  const nodeNote = saved.nodeId === 'master'
    ? `node: ${saved.nodeId}`
    : `node: ${saved.nodeId} (switch to this node first, or use the appropriate node/file tool)`;
  return [
    `Complete output saved to:`,
    `- ${nodeNote}`,
    `- path: ${saved.relativePath}`,
    `Use ${readCall} to inspect the full output.`,
  ].join('\n');
}

function buildTruncatedNotice(args: {
  label: string;
  saved: SavedToolOutput;
  excerpt: string;
}): string {
  return [
    `[TOOL OUTPUT TOO LONG: ${args.label}]`,
    `The complete ${args.label} was ${args.saved.lengthChars} characters and has been truncated in the tool response.`,
    buildReadHint(args.saved),
    '',
    'Showing a truncated excerpt:',
    args.excerpt,
    '',
    `[END TRUNCATED TOOL OUTPUT; full ${args.label} saved to ${args.saved.relativePath}]`,
  ].join('\n');
}

function formatValueForOutputField(value: unknown): string {
  return formatStructuredValue(value);
}

function shouldPreserveValue(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null) return true;
  if (typeof value === 'string') return value.length <= PRESERVED_VALUE_CHAR_LIMIT;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  const formatted = formatStructuredValue(value);
  return formatted.length <= PRESERVED_VALUE_CHAR_LIMIT;
}

function truncatePreservedError(value: unknown, saved: SavedToolOutput): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  const text = formatStructuredValue(value);
  if (text.length <= PRESERVED_VALUE_CHAR_LIMIT) {
    return value;
  }

  return `[TOOL ERROR OUTPUT TOO LONG] The original error content was included in the full saved tool output at ${saved.relativePath} on node ${saved.nodeId}. ${truncateUnicodeSafe(text, 1200, '...')}`;
}

function buildStageBSummary(originalResult: any, saved: SavedToolOutput, excerpt: string): Record<string, any> {
  const summary: Record<string, any> = {
    output: buildTruncatedNotice({
      label: 'formatted tool response',
      saved,
      excerpt,
    }),
    fullOutputPath: saved.relativePath,
    fullOutputNode: saved.nodeId,
    originalLengthChars: saved.lengthChars,
    fullOutputSha256: saved.sha256,
    truncated: true,
  };

  if (isPlainObject(originalResult)) {
    for (const [key, value] of Object.entries(originalResult)) {
      if (key === 'output') {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(summary, key)) {
        continue;
      }
      if (!SHALLOW_PRESERVE_KEYS.has(key)) {
        continue;
      }
      if (key === 'error') {
        summary.error = truncatePreservedError(value, saved);
        continue;
      }
      if (shouldPreserveValue(value)) {
        summary[key] = value;
      }
    }
  }

  return summary;
}

async function guardOutputFieldIfNeeded(result: Record<string, any>, options: ToolOutputGuardOptions): Promise<Record<string, any>> {
  if (!Object.prototype.hasOwnProperty.call(result, 'output')) {
    return result;
  }

  const outputText = formatValueForOutputField(result.output);
  if (outputText.length <= TOOL_OUTPUT_GUARD_CHAR_LIMIT) {
    return result;
  }

  const saved = await saveCompleteText(outputText, options, 'output');
  return {
    ...result,
    output: buildTruncatedNotice({
      label: 'output field',
      saved,
      excerpt: buildExcerpt(outputText, TOOL_OUTPUT_GUARD_EXCERPT_LIMIT),
    }),
    outputFullPath: saved.relativePath,
    outputFullNode: saved.nodeId,
    outputOriginalLengthChars: saved.lengthChars,
    outputFullSha256: saved.sha256,
    outputTruncated: true,
  };
}

/**
 * Guard the model-facing tool result before it is appended to session history.
 *
 * Stage A truncates an oversized top-level `output` field while preserving the
 * rest of the object. Stage B then checks the whole formatted response and, if
 * still oversized, replaces it with a safe summary while shallow-preserving
 * small critical metadata (`fullPath`, `runId`, top-level `error`, etc.).
 */
export async function guardToolOutputForModel(rawResult: any, options: ToolOutputGuardOptions): Promise<any> {
  let result = rawResult;
  const originalFormattedPayload = formatToolResponsePayload(rawResult);

  try {
    if (isPlainObject(result)) {
      result = await guardOutputFieldIfNeeded(result, options);
    }

    const formattedPayload = formatToolResponsePayload(result);
    if (formattedPayload.length <= TOOL_OUTPUT_GUARD_CHAR_LIMIT) {
      return result;
    }

    const fullPayloadToSave = originalFormattedPayload;
    const saved = await saveCompleteText(fullPayloadToSave, options, 'payload');
    return buildStageBSummary(result, saved, buildExcerpt(fullPayloadToSave, TOOL_OUTPUT_GUARD_STAGE_B_EXCERPT_LIMIT));
  } catch (error: any) {
    logger.warn({ err: error, toolName: options.toolName, sessionId: options.sessionId }, 'Failed to guard oversized tool output');
    const fallbackText = originalFormattedPayload;
    if (fallbackText.length <= TOOL_OUTPUT_GUARD_CHAR_LIMIT) {
      return result;
    }

    const fallback = {
      output: [
        '[TOOL OUTPUT TOO LONG]',
        `The tool output was ${fallbackText.length} characters. Saving the full output failed: ${error?.message || String(error)}`,
        buildExcerpt(fallbackText, TOOL_OUTPUT_GUARD_STAGE_B_EXCERPT_LIMIT),
      ].join('\n\n'),
      originalLengthChars: fallbackText.length,
      truncated: true,
      toolOutputGuardError: error?.message || String(error),
    };

    if (isPlainObject(rawResult) && rawResult.error !== undefined) {
      (fallback as any).error = truncatePreservedError(rawResult.error, {
        relativePath: '(full output save failed)',
        nodeId: options.nodeId || 'master',
        lengthChars: fallbackText.length,
        sha256: crypto.createHash('sha256').update(fallbackText).digest('hex'),
      });
    }

    return fallback;
  }
}
