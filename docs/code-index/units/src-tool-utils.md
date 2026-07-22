# Unit: src-tool-utils

Files: src/toolCallArgs.ts, src/toolCallArgs.test.ts, src/toolOutputGuard.ts, src/toolOutputGuard.test.ts, src/toolImages.ts, src/tools/imageTools.test.ts, src/tools/toolsChannelNaming.test.ts, src/tools/toolsPathResolution.test.ts, src/tools/unifiedTools.test.ts

## Purpose

Provides utilities for serializing/parsing tool call arguments, guarding oversized tool outputs before they enter model context, handling image data from tool results (normalization, cropping, writing), and includes comprehensive tests for tool schemas, path resolution, channel naming, and unified tool dispatch.

## Key Exports

- `stringifyFunctionCallArgs` — serializes function call args preserving raw text or reporting parse errors
- `parseFunctionCallArgs` — parses raw argument text into a structured result with error tracking
- `guardToolOutputForModel` — two-stage guard that truncates oversized tool results and saves full output to disk
- `TOOL_OUTPUT_GUARD_CHAR_LIMIT` — character limit constant for tool output truncation
- `normalizeToolResultImages` — extracts and normalizes image data from various tool result formats
- `buildToolImageId` — constructs a deterministic image identifier from tool use ID and index
- `getImageMetaFromPart` — extracts image metadata from a message part
- `buildImageGuidanceText` / `appendImageGuidanceText` — generates model-facing image usage hints
- `cropImageById` — resolves an image by ID from session history and crops it
- `resolveArchiveInlineDataPath` — resolves archived inline data file references
- `NormalizedToolResultImage`, `NormalizedToolResultImages` — TypeScript interfaces for normalized image results

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `stringifyFunctionCallArgs(functionCall)` | ~3–20 | Serializes function call args to JSON string safely |
| `isPlainObject(value)` | ~23–25 | Checks if value is a non-array object |
| `parseFunctionCallArgs(rawArgsText)` | ~27–65 | Parses raw args text into structured result with error info |
| `isPlainObject(value)` (toolOutputGuard) | ~60–62 | Type guard for plain objects |
| `sanitizePathSegment(value, fallback)` | ~64–70 | Sanitizes a string for use in file paths |
| `buildToolOutputRelativePath(options, suffix)` | ~72–79 | Constructs relative path for saved tool output files |
| `saveCompleteText(text, options, suffix)` | ~81–107 | Persists full tool output text to disk or remote node |
| `buildExcerpt(text, maxChars)` | ~120 | Delegates to shared line-aware output truncation for tool-output excerpts |
| `buildSavedOutputLocation(saved)` | ~121–126 | Formats saved output location as text |
| `buildTruncatedNotice(args)` | ~128–140 | Builds full truncation notice with excerpt and location |
| `formatValueForOutputField(value)` | ~142–144 | Formats arbitrary value for output field display |
| `shouldPreserveValue(value)` | ~146–153 | Determines if a value is small enough to preserve in summary |
| `truncatePreservedError(value, saved)` | ~155–166 | Truncates error values that exceed preservation limit |
| `buildStageBSummary(originalResult, saved, excerpt)` | ~168–198 | Builds stage-B truncated summary preserving key metadata |
| `guardOutputFieldIfNeeded(result, options)` | ~200–220 | Stage A: truncates oversized output field specifically |
| `guardToolOutputForModel(rawResult, options)` | ~228–270 | Main entry: two-stage guard with fallback error handling |
| `isObject(value)` (toolImages) | ~1 | Type guard for objects in image module |
| `isImageMimeType(mimeType)` | ~5 | Checks if MIME type is an image type |
| `normalizeMimeTypeFromFormat(format)` | ~10 | Converts short format names to full MIME types |
| `normalizeInlineData(item)` | ~20 | Extracts InlineData from various item shapes |
| `normalizeLegacyImagePayload(result)` | ~30 | Handles legacy browser-style image payloads |
| `parseLegacyOutputImage(output)` | ~48 | Parses __IMAGE__ and __SCREENSHOT__ prefixed strings |
| `buildToolImageId(toolUseId, imageIndex)` | ~65 | Creates deterministic image ID string |
| `probeImageMetadata(inlineData)` | ~70 | Uses sharp to extract width/height/size/hash from image buffer |
| `buildNormalizedToolResultImage(toolUseId, imageIndex, inlineData)` | ~82 | Combines metadata probe with ID generation |
| `normalizeToolResultImages(result, toolUseId, fallbackLabel)` | ~88–140 | Main normalizer: collects images from all formats, strips consumed keys |
| `getImageMetaFromPart(part)` | ~145–170 | Extracts ImageMeta from message part with fallbacks |
| `formatImageSize(meta)` | ~172 | Formats width×height string |
| `sanitizeSuggestedFileName(imageId)` | ~176 | Cleans image ID for use as filename |
| `buildImageGuidanceLabel(meta)` | ~179 | Builds model-facing label with crop/write hints |
| `buildImageGuidanceText(parts)` | ~185 | Joins guidance labels for multiple image parts |
| `appendImageGuidanceText(parts, existingText)` | ~192 | Prepends image guidance to existing text |
| `resolveArchiveInlineDataPath(refPath)` | ~198 | Resolves relative archive path to absolute |
| `buildResolvedImageFromPart(part)` | ~200 | Resolves a message part into buffer + metadata |
| `findImagePartInMessage(message, imageId)` | ~215 | Searches message parts for matching image ID |
| `resolveImageById(sessionId, imageId)` | ~225 | Searches session history and archives for an image |
| `cropImageById(sessionId, imageId, crop)` | ~250 | Resolves image and performs sharp crop extraction |

## Dependencies

- `./types` — `FunctionCall`, `ImageMeta`, `InlineData`, `Message`, `MessagePart`
- `./config` — `getAgentDir`, `getAgentMemoryDir`
- `./common` — `logger`
- `./nodes/manager` — `nodesManager` (remote file writes)
- `./sessionManager` — session retrieval, archived messages, channel/file sending
- `../packages/shared/dist/toolResponseFormatting` — `formatStructuredValue`, `formatToolResponsePayload`
- `./utils/unicode` — `takeUnicodeSafe`, `takeUnicodeSafeEnd`, `truncateUnicodeSafe`
- `./llm` — `executeTools`, `fixToolCalls` (tested)
- `./llmProviders/openai` — `convertToOpenAIFormat`, `convertToOpenAIResponsesFormat` (tested)
- `./tools` — tool implementations and definitions (tested)
- `./toolsSessionAgent` — `tool_send_file`, `tool_send_to_channel` (tested)
- `./isolatedCheck` — `checkToolPermission` (tested)
- `./mcpClient` — MCP server/tool operations (tested)

## Behavior

- `parseFunctionCallArgs` gracefully handles malformed JSON by preserving the raw text and a structured error message, preventing 400 errors on provider APIs.
- `guardToolOutputForModel` applies a two-stage truncation: Stage A targets the `output` field specifically; Stage B catches any remaining oversized payload. Both stages save the complete text to disk and return a line-aware excerpt with location metadata, Foxwarm placeholder notes, and original line/character counts. A fallback path handles save failures.
- The guard preserves a curated set of shallow metadata keys (paths, IDs, status, error) in truncated summaries so the model retains actionable context.
- `normalizeToolResultImages` unifies multiple legacy image formats (base64 payloads, `__IMAGE__:` prefixes, `__SCREENSHOT__:` prefixes, inline data items) into a consistent `MessagePart[]` with probed metadata.
- `cropImageById` resolves images by walking session history backwards (including archives), then uses sharp to extract a sub-region.
- The `wait` tool's stop-current-turn behavior is suppressed when any other tool in the batch returns an error.

## Integration

- The output guard is called by `executeTools` in the LLM layer before tool results are appended to session history, ensuring model context stays within token limits.
- The guard preserves the structured tool-result object shape; provider serializers later call `formatToolResponsePayload()` to produce string content for OpenAI Chat Completions, OpenAI Responses function_call_output, and Anthropic tool_result blocks.
- Image normalization feeds into the message part system, enabling downstream image tools (`image_crop`, `image_write_to_file`) to reference prior tool images by ID.
- `stringifyFunctionCallArgs` is used by OpenAI format converters to serialize tool calls for the provider API, preserving exact raw text when available.
- The test files validate tool schema contracts (parameter naming, `defaultInject` metadata), path resolution behavior (session cwd, isolated agents), read range placeholder handling (`startLine/endLine: 0` as omitted), write parent-directory semantics (`createDirs=true`), channel naming conventions, and the unified `call_tool`/`search_tools` dispatch layer.