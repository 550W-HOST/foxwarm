export const extractOpenAIReasoningSummaryTitles = (text: string): string[] => {
  const trimmed = text.trimStart()
  if (!/^\*\*[^*\n]+\*\*\s*(?:\r?\n|$)/.test(trimmed)) {
    return []
  }

  const titles: string[] = []
  const titleLinePattern = /^\*\*([^*\n]+)\*\*\s*$/gm
  let match: RegExpExecArray | null
  while ((match = titleLinePattern.exec(trimmed)) !== null) {
    const title = match[1].trim()
    if (title) titles.push(title)
  }
  return titles
}

