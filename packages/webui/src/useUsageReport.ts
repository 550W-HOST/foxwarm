import { useCallback, useEffect, useRef, useState } from 'react'
import { webUiRealtime } from './realtime'
import { loadUsage, msUntilNextDay, toDateInput, type UsageReport } from './usageOverview'

/** Advances at local midnight so Today, This week and This month move with the clock. */
export function useLocalDay() {
  const [day, setDay] = useState(() => toDateInput(new Date()))
  useEffect(() => {
    const timer = window.setTimeout(() => setDay(toDateInput(new Date())), msUntilNextDay() + 1000)
    return () => window.clearTimeout(timer)
  }, [day])
  return day
}

/** Loads a usage report and reloads it when recorded usage changes. */
export function useUsageReport(url: string | null) {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const reload = useCallback(async () => {
    if (!url) return
    const current = ++generation.current
    setLoading(true)
    try {
      const next = await loadUsage(url)
      if (current === generation.current) { setReport(next); setError('') }
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [url])
  useEffect(() => {
    if (!url) { generation.current++; setReport(null); return }
    void reload()
    let pending: number | null = null
    const schedule = () => { if (pending === null) pending = window.setTimeout(() => { pending = null; void reload() }, 1000) }
    const unsubscribe = webUiRealtime.subscribeSessionList([], {
      onOpen: schedule,
      onMessage: message => { if (message.type === 'usage-changed') schedule() },
    })
    return () => { if (pending !== null) window.clearTimeout(pending); unsubscribe(); generation.current++ }
  }, [url, reload])
  return { report, error, loading, reload }
}
