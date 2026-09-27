/**
 * Read-only compatibility adapter for remote node tool results written by
 * older Foxwarm node and browser-extension runtimes.
 *
 * Current writers must emit only canonical `inlineData` / `inlineDataItems`.
 * This adapter is intentionally pure and has exactly one runtime caller:
 * `NodesManager.handleToolResponse`, the remote-node ingress boundary.
 *
 * Once supported nodes/extensions all write the canonical shape, delete this
 * file, its tests, and the single ingress call to switch to the strict path.
 */

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isImageMimeType(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('image/');
}

function normalizeLegacyImageFormat(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const format = value.trim().toLowerCase();
  if (!format) return undefined;
  if (format.includes('/')) return isImageMimeType(format) ? format : undefined;
  if (format === 'jpg') return 'image/jpeg';
  return `image/${format}`;
}

function parseLegacyNodeImageMarker(output: unknown): { data: string; mimeType: string } | null {
  if (typeof output !== 'string') return null;

  if (output.startsWith('__IMAGE__:')) {
    const [, mimeType, data] = output.split(':', 3);
    if (!isImageMimeType(mimeType) || !data) return null;
    return { data, mimeType };
  }

  if (output.startsWith('__SCREENSHOT__:')) {
    const data = output.slice('__SCREENSHOT__:'.length);
    return data ? { data, mimeType: 'image/png' } : null;
  }

  return null;
}

function alreadyUsesCanonicalInlineData(result: Record<string, any>): boolean {
  return isRecord(result.inlineData) || Array.isArray(result.inlineDataItems);
}

export function adaptLegacyRemoteNodeToolResult(result: unknown): unknown {
  if (!isRecord(result) || alreadyUsesCanonicalInlineData(result)) {
    return result;
  }

  const markerImage = parseLegacyNodeImageMarker(result.output);
  if (markerImage) {
    const { output: _legacyMarker, ...metadata } = result;
    return { ...metadata, inlineData: markerImage };
  }

  if (
    typeof result.image === 'string'
    && result.image.length > 0
    && typeof result.encoding === 'string'
    && result.encoding.toLowerCase() === 'base64'
  ) {
    const mimeType = isImageMimeType(result.mimeType)
      ? result.mimeType
      : normalizeLegacyImageFormat(result.format);
    if (!mimeType) return result;

    const { image, encoding: _encoding, format: _format, ...metadata } = result;
    return {
      ...metadata,
      inlineData: { data: image, mimeType },
    };
  }

  if (
    typeof result.screenshot === 'string'
    && result.screenshot.length > 0
    && isImageMimeType(result.mimeType)
  ) {
    const { screenshot, ...metadata } = result;
    return {
      ...metadata,
      inlineData: { data: screenshot, mimeType: result.mimeType },
    };
  }

  return result;
}