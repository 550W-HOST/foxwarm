import type { Message } from './chatShared'

export interface TimelineTimeMarker {
  timestamp: number
}

const validTimestamp = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime()) ? value : null
)

const sameLocalDay = (left: number, right: number): boolean => {
  const a = new Date(left), b = new Date(right)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Compare the next request start with the preceding persisted end; grouped rows have no separate time line. */
export const deriveTimelineTimeMarkers = (messages: readonly Message[], isGroupedEvent: (message: Message) => boolean): Array<TimelineTimeMarker | null> => {
  let previous: number | null = null
  let showedClock = false
  return messages.map(message => {
    if (message.__meta?.temporary || message.__meta?.synthetic) return null
    const end = validTimestamp(message.__meta?.contextBlock
      ? message.__meta.contextBlock.rawStartTimestamp
      : message.__meta?.timestamp)
    const current = message.__meta?.contextBlock ? end
      : validTimestamp(message.__meta?.llmRequestTiming?.startedAt) ?? end
    const eligible = message.role !== 'tool' && !isGroupedEvent(message)
    let marker: TimelineTimeMarker | null = null
    if (eligible && current !== null) {
      if (!showedClock || previous === null) {
        marker = { timestamp: current }
      } else {
        const gap = current - previous
        if (Math.abs(gap) >= 60_000 || (gap !== 0 && !sameLocalDay(current, previous))) {
          marker = { timestamp: current }
        }
      }
      showedClock = true
    }
    previous = end
    return marker
  })
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
  const title = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).format(date)
  return { text: clock, title }
}
