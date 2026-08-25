export interface LegacyEditLineCounts {
  removed: number
  added: number
}

export const countLogicalPayloadLines = (text: string): number => {
  if (text.length === 0) return 0

  const lines = text.split(/\r\n|\r|\n/)
  return lines.length - (/\r\n$|\r$|\n$/.test(text) ? 1 : 0)
}

export const getLegacyEditLineCounts = (oldText: string, newText: string): LegacyEditLineCounts => ({
  removed: countLogicalPayloadLines(oldText),
  added: countLogicalPayloadLines(newText),
})