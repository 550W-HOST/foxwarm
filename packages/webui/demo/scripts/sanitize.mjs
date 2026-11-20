// Makes a recorded snapshot public-safe and stable: fixed container-style
// paths instead of the generator's temporary directories, and gallery times
// moved to a fixed date so regeneration does not churn every timestamp.

export const GALLERY_EPOCH = Date.UTC(2026, 10, 1, 9, 0, 0)

const pad = value => String(value).padStart(2, '0')
const dateText = date => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`

export function sanitizeSnapshot(snapshot, { replacements, window, forbidden }) {
  const shift = GALLERY_EPOCH - window.start
  const inWindow = ms => ms >= window.start - 60_000 && ms <= window.end + 600_000
  const generationDates = new Map()
  for (let ms = window.start; ms <= window.end + 600_000; ms += 600_000) {
    generationDates.set(dateText(new Date(ms)), dateText(new Date(ms + shift)))
  }
  // One pass, longest first, so a replaced path is never rewritten again.
  const replacementMap = new Map(replacements.filter(([from]) => from))
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const replacementPattern = new RegExp([...replacementMap.keys()].sort((a, b) => b.length - a.length).map(from => `(?<![A-Za-z0-9_.-])${escape(from)}(?![A-Za-z0-9_.-])`).join('|'), 'g')
  const stamp = /(\d{4})-(\d{2})-(\d{2})([ T])(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?( \+0000|Z)/g
  const rewriteText = value => {
    let text = value.replace(replacementPattern, match => replacementMap.get(match))
    text = text.replace(stamp, (match, y, mo, d, sep, h, mi, s, frac = '', zone) => {
      const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, frac ? Math.round(Number(frac) * 1000) : 0)
      if (!inWindow(ms)) return match
      const shifted = new Date(ms + shift)
      const ms3 = frac ? '.' + String(shifted.getUTCMilliseconds()).padStart(3, '0').slice(0, frac.length - 1) : ''
      return `${dateText(shifted)}${sep}${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${ms3}${zone}`
    })
    text = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, match => generationDates.get(match) ?? match)
    return text
  }
  const visit = value => {
    if (typeof value === 'string') return rewriteText(value)
    if (typeof value === 'number') return inWindow(value) ? value + shift : value
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object') {
      const result = {}
      for (const [key, item] of Object.entries(value)) result[rewriteText(key)] = key === 'base64' ? item : visit(item)
      return result
    }
    return value
  }
  const result = visit(snapshot)
  const text = JSON.stringify(result)
  for (const needle of forbidden) {
    const at = needle ? text.search(new RegExp(`(?<![A-Za-z0-9_.-])${escape(needle)}(?![A-Za-z0-9_.-])`)) : -1
    if (at >= 0) {
      throw new Error(`Snapshot still contains ${JSON.stringify(needle)} near: ${text.slice(Math.max(0, at - 120), at + 120)}`)
    }
  }
  return result
}
