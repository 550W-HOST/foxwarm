import { useEffect, useMemo, useRef, useState } from 'react'
import VscodeWebFrameHost, { useVscodeWebFrameBridge, type VscodeWebFrameHostHandle } from './VscodeWebFrameHost'
import { makeVscodeWebUrl } from '../vscodeWeb'
import { API_BASE_PATH } from '../config'

/** One persistent Code editor per working session. Keep this component mounted
 * while the session is hidden so its in-memory editors and terminals survive. */
export default function ProjectCodeFrame({ workspaceId, nodeId, rootPath, visible = true }: {
  workspaceId: string
  nodeId: string
  rootPath: string
  visible?: boolean
}) {
  const [started, setStarted] = useState(visible)
  const frameRef = useRef<VscodeWebFrameHostHandle | null>(null)
  const src = useMemo(() => makeVscodeWebUrl(API_BASE_PATH, window.location.origin, {
    nodeId,
    path: rootPath,
  }, { embedded: true, workspaceId }).toString(), [workspaceId, nodeId, rootPath])
  const bridge = useVscodeWebFrameBridge({ started, src }, frameRef)

  useEffect(() => {
    if (visible) setStarted(true)
  }, [visible])

  return (
    <div className="h-full w-full" style={{ display: visible ? undefined : 'none' }}>
      {started ? <VscodeWebFrameHost src={src} bridge={bridge} /> : null}
    </div>
  )
}
