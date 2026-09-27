export const FOXWARM_POPUP_VERSION = 1

export type FoxwarmPopupTarget =
  | { kind: 'chat'; sessionId: string; title?: string }
  | { kind: 'terminal'; terminalId: string; title?: string }
  | { kind: 'agents' }
  | { kind: 'setup' }

const normalizeBoundedText = (value: string | null, maxLength: number): string | null => {
  if (!value) return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  return normalized
}

export function parseFoxwarmPopupTarget(search: string): FoxwarmPopupTarget | null {
  const params = new URLSearchParams(search)
  if (params.get('foxwarmPopupVersion') !== String(FOXWARM_POPUP_VERSION)) return null

  const kind = params.get('foxwarmPopup')
  if (kind === 'agents') return { kind: 'agents' }
  if (kind === 'setup') return { kind: 'setup' }

  const title = normalizeBoundedText(params.get('title'), 200)
  if (kind === 'chat') {
    const sessionId = normalizeBoundedText(params.get('sessionId'), 512)
    return sessionId ? { kind: 'chat', sessionId, ...(title ? { title } : {}) } : null
  }
  if (kind === 'terminal') {
    const terminalId = normalizeBoundedText(params.get('terminalId'), 512)
    return terminalId ? { kind: 'terminal', terminalId, ...(title ? { title } : {}) } : null
  }
  return null
}

export function makeFoxwarmPopupUrl(currentUrl: string | URL, target: FoxwarmPopupTarget): URL {
  const url = new URL(currentUrl.toString())
  url.hash = ''
  url.search = ''
  url.searchParams.set('foxwarmPopup', target.kind)
  url.searchParams.set('foxwarmPopupVersion', String(FOXWARM_POPUP_VERSION))
  if (target.kind === 'chat') url.searchParams.set('sessionId', target.sessionId)
  if (target.kind === 'terminal') url.searchParams.set('terminalId', target.terminalId)
  if ('title' in target && target.title) url.searchParams.set('title', target.title)
  return url
}