import { useEffect } from 'react'
import { watchFrontendBuild } from '../buildUpdate'

/** The HTML bootstrap owns the single notice, including stale lazy chunks. */
export default function BuildUpdateNotice() {
  useEffect(() => watchFrontendBuild(build => window.foxwarmBoot?.update(build)), [])
  return null
}
