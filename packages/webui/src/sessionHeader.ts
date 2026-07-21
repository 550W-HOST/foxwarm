export function formatSessionHeaderSubtitle(sessionId: string, cwd?: string | null): string {
  const sessionLabel = `session ${sessionId}`
  return typeof cwd === 'string' && cwd.trim() ? `${sessionLabel} · ${cwd}` : sessionLabel
}