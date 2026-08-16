import { TextDecoder } from 'util';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function normalizeWebUiMultipartFilename(fileName: string): string {
  let hasNonAsciiByte = false;
  const bytes = new Uint8Array(fileName.length);

  for (let index = 0; index < fileName.length; index += 1) {
    const codePoint = fileName.charCodeAt(index);
    if (codePoint > 0xFF) return fileName;
    if (codePoint > 0x7F) hasNonAsciiByte = true;
    bytes[index] = codePoint;
  }

  if (!hasNonAsciiByte) return fileName;

  try {
    const decoded = UTF8_DECODER.decode(bytes);
    return decoded === fileName ? fileName : decoded;
  } catch {
    return fileName;
  }
}