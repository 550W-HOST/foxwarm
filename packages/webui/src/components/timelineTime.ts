import type { Message } from './chatShared'

export interface TimelineTimeMarker {
  timestamp: number
  laterMs: number | null
}

const validTimestamp = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime()) ? value : null
)

const sameLocalDay = (left: number, right: number): boolean => {
  const a = new Date(left), b = new Date(right)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Compare adjacent committed history timestamps; tool and grouped event rows have no separate time line. */
export const deriveTimelineTimeMarkers = (messages: readonly Message[], isGroupedEvent: (message: Message) => boolean): Array<TimelineTimeMarker | null> => {
  let previous: number | null = null
  let showedClock = false
  return messages.map(message => {
    if (message.__meta?.temporary || message.__meta?.synthetic) return null
    const current = validTimestamp(message.__meta?.timestamp)
    const eligible = message.role !== 'tool' && !isGroupedEvent(message)
    let marker: TimelineTimeMarker | null = null
    if (eligible && current !== null) {
      if (!showedClock || previous === null) {
        marker = { timestamp: current, laterMs: null }
      } else {
        const gap = current - previous
        if (gap > 0 && (gap >= 60_000 || !sameLocalDay(current, previous))) {
          marker = { timestamp: current, laterMs: gap }
        } else if (gap < 0 && (Math.abs(gap) >= 60_000 || !sameLocalDay(current, previous))) {
          marker = { timestamp: current, laterMs: null }
        }
      }
      showedClock = true
    }
    previous = current
    return marker
  })
}

const formatLater = (durationMs: number): string => {
  let seconds = Math.floor(durationMs / 1000)
  const parts: string[] = []
  for (const [unit, length] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    const count = Math.floor(seconds / length)
    if (count > 0) { parts.push(`${count}${unit}`); seconds %= length }
    if (parts.length === 2) break
  }
  return parts.join(' ')
}

export const formatTimelineTimeMarker = (marker: TimelineTimeMarker, now = Date.now()): { text: string; title: string } => {
  const date = new Date(marker.timestamp)
  const current = new Date(now)
  const today = sameLocalDay(marker.timestamp, now)
  const sameYear = date.getFullYear() === current.getFullYear()
  const options: Intl.DateTimeFormatOptions = {
    ...(today ? {} : { month: 'short', day: 'numeric', ...(!sameYear ? { year: 'numeric' } : {}) }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }
  const clock = new Intl.DateTimeFormat('en-US', options).format(date)
  const later = marker.laterMs !== null && marker.laterMs >= 1000 ? formatLater(marker.laterMs) : ''
  const title = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).format(date)
  return { text: later ? `${clock} · ${later} later` : clock, title }
}
