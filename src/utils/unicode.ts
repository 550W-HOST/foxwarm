const REPLACEMENT_CHARACTER = '�';

export type LoneSurrogateSanitizeResult<T> = {
  value: T;
  replacementCount: number;
  paths: string[];
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

function isAnySurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDFFF;
}

export function replaceLoneSurrogates(text: string, replacement: string = REPLACEMENT_CHARACTER): { text: string; replacementCount: number } {
  let changed = false;
  let replacementCount = 0;
  let result = '';

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (isHighSurrogate(code)) {
      const nextCode = index + 1 < text.length ? text.charCodeAt(index + 1) : NaN;
      if (isLowSurrogate(nextCode)) {
        result += text[index] + text[index + 1];
        index += 1;
      } else {
        result += replacement;
        changed = true;
        replacementCount += 1;
      }
      continue;
    }

    if (isLowSurrogate(code)) {
      result += replacement;
      changed = true;
      replacementCount += 1;
      continue;
    }

    result += text[index];
  }

  return {
    text: changed ? result : text,
    replacementCount,
  };
}

export function containsLoneSurrogate(text: string): boolean {
  return replaceLoneSurrogates(text).replacementCount > 0;
}

function splitGraphemes(text: string): string[] {
  const Segmenter = (globalThis as any).Intl?.Segmenter;
  if (typeof Segmenter === 'function') {
    try {
      const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(text), (entry: any) => String(entry.segment));
    } catch {
      // Fall through to code-point splitting.
    }
  }

  return Array.from(text);
}

function graphemeLength(text: string): number {
  return splitGraphemes(text).length;
}

export function takeUnicodeSafe(text: string, maxGraphemes: number): string {
  const sanitized = replaceLoneSurrogates(text).text;
  if (maxGraphemes <= 0) {
    return '';
  }

  const graphemes = splitGraphemes(sanitized);
  if (graphemes.length <= maxGraphemes) {
    return sanitized;
  }
  return graphemes.slice(0, maxGraphemes).join('');
}

export function takeUnicodeSafeEnd(text: string, maxGraphemes: number): string {
  const sanitized = replaceLoneSurrogates(text).text;
  if (maxGraphemes <= 0) {
    return '';
  }

  const graphemes = splitGraphemes(sanitized);
  if (graphemes.length <= maxGraphemes) {
    return sanitized;
  }
  return graphemes.slice(-maxGraphemes).join('');
}

export function truncateUnicodeSafe(text: string, maxGraphemes: number, ellipsis: string = ''): string {
  const sanitized = replaceLoneSurrogates(text).text;
  if (maxGraphemes <= 0) {
    return sanitized;
  }

  const graphemes = splitGraphemes(sanitized);
  if (graphemes.length <= maxGraphemes) {
    return sanitized;
  }

  return `${graphemes.slice(0, maxGraphemes).join('')}${replaceLoneSurrogates(ellipsis).text}`;
}

export function truncateUnicodeSafeWithEllipsis(text: string, maxGraphemesIncludingEllipsis: number, ellipsis: string = '…'): string {
  const sanitized = replaceLoneSurrogates(text).text;
  if (maxGraphemesIncludingEllipsis <= 0) {
    return sanitized;
  }

  const graphemes = splitGraphemes(sanitized);
  if (graphemes.length <= maxGraphemesIncludingEllipsis) {
    return sanitized;
  }

  const ellipsisText = replaceLoneSurrogates(ellipsis).text;
  const ellipsisGraphemes = graphemeLength(ellipsisText);
  const take = Math.max(0, maxGraphemesIncludingEllipsis - ellipsisGraphemes);
  return `${graphemes.slice(0, take).join('')}${ellipsisText}`;
}

function appendPathSegment(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function sanitizePayloadInternal(value: unknown, path: string, seen: WeakSet<object>): LoneSurrogateSanitizeResult<unknown> {
  if (typeof value === 'string') {
    const replaced = replaceLoneSurrogates(value);
    return {
      value: replaced.text,
      replacementCount: replaced.replacementCount,
      paths: replaced.replacementCount > 0 ? [path] : [],
    };
  }

  if (Array.isArray(value)) {
    let changed = false;
    let replacementCount = 0;
    const paths: string[] = [];
    const next = value.map((entry, index) => {
      const result = sanitizePayloadInternal(entry, `${path}[${index}]`, seen);
      if (result.value !== entry) changed = true;
      replacementCount += result.replacementCount;
      paths.push(...result.paths);
      return result.value;
    });
    return { value: changed ? next : value, replacementCount, paths };
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return { value, replacementCount: 0, paths: [] };
    }
    seen.add(value);

    let changed = false;
    let replacementCount = 0;
    const paths: string[] = [];
    const next: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const result = sanitizePayloadInternal(entry, appendPathSegment(path, key), seen);
      if (result.value !== entry) changed = true;
      replacementCount += result.replacementCount;
      paths.push(...result.paths);
      next[key] = result.value;
    }

    return { value: changed ? next : value, replacementCount, paths };
  }

  return { value, replacementCount: 0, paths: [] };
}

export function sanitizeLoneSurrogatesInPayload<T>(value: T, rootPath: string = '$'): LoneSurrogateSanitizeResult<T> {
  return sanitizePayloadInternal(value, rootPath, new WeakSet<object>()) as LoneSurrogateSanitizeResult<T>;
}

export function containsAnySurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isAnySurrogate(text.charCodeAt(index))) {
      return true;
    }
  }
  return false;
}
