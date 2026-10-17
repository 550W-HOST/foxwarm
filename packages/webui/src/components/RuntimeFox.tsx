import { FoxSleeping, FoxSpinner } from './FoxLoaders'

export type RuntimeFoxKind = 'request' | 'tool' | 'compact' | 'waiting' | 'retry' | 'stopping' | 'interrupted' | 'error' | 'unknown'

// Author-calibrated optical frames: the visible silhouette occupies ~90% of the
// slot's longest axis, matching the original fox. No DOM measurement or stretching.
const POSE_FRAME = {
  tool: { viewBox: '2.54 -9.32 117.27 117.27', strokeWidth: 4.055 },
  compact: { viewBox: '12.87 7.91 98.03 98.03', strokeWidth: 3.389 },
  retry: { viewBox: '6.97 6.56 88.49 88.49', strokeWidth: 3.060 },
  stopping: { viewBox: '15.11 2.23 97.78 97.78', strokeWidth: 3.380 },
  interrupted: { viewBox: '6.02 12.55 102.08 102.08', strokeWidth: 3.529 },
  error: { viewBox: '25.65 22.12 78.27 78.27', strokeWidth: 2.706 },
  unknown: { viewBox: '19.18 1.73 89.16 89.16', strokeWidth: 3.083 },
} as const

/** A compact three-quarter face; the silhouette, not an overlaid symbol, carries the pose. */
function Face({ sad = false }: { sad?: boolean }) {
  return <>
    <path d={sad
      ? 'M-19 -5 Q-23 -12 -26 -18 Q-14 -21 -7 -14 Q0 -17 7 -14 Q14 -21 26 -18 Q23 -12 19 -5 L21 2 Q10 8 0 17 Q-10 8 -21 2 Z'
      : 'M-19 -5 Q-23 -18 -19 -28 L-6 -15 Q0 -17 6 -15 L19 -28 Q23 -18 19 -5 L21 2 Q10 8 0 17 Q-10 8 -21 2 Z'} />
    <path d={sad ? 'M-12 2 L-6 0 M6 0 L12 2' : 'M-12 -1 L-7 2 M7 2 L12 -1'} />
    <path className="fw-runtime-fox-nose" d="M-3 10 Q0 8 3 10 L0 13 Z" />
  </>
}

/** Request and Waiting retain their original artwork; other states have clean, complete silhouettes. */
export default function RuntimeFox({ kind, size = 24, animated = kind !== 'interrupted' && kind !== 'error' }: { kind: RuntimeFoxKind; size?: number; animated?: boolean }) {
  if (kind === 'request') return <span aria-hidden="true" className="fw-runtime-fox-wrap" data-runtime-fox={kind} data-animated={animated ? 'true' : 'false'}><FoxSpinner size={size} /></span>
  if (kind === 'waiting') return <span aria-hidden="true" className="fw-runtime-fox-wrap" data-runtime-fox={kind} data-animated={animated ? 'true' : 'false'}><FoxSleeping size={size} /></span>
  return <svg aria-hidden="true" data-runtime-fox={kind} data-animated={animated ? 'true' : 'false'} className="fw-runtime-fox" viewBox={POSE_FRAME[kind].viewBox} width={size} height={size} style={{ strokeWidth: POSE_FRAME[kind].strokeWidth }}>
    {kind === 'tool' && <g className="fw-runtime-fox-step">
      <path className="fw-runtime-fox-tail" d="M84 44 C101 42 103 21 113 17 C117 40 108 57 91 60 M109 36 L102 39 L104 45" />
      <path d="M45 42 Q64 29 81 42 Q94 51 87 66 L102 80 H89 L74 65 M66 64 L52 83 H38 L49 65 M30 58 L24 76 H12 L19 55" />
      <g transform="translate(29 41) rotate(-9) scale(.82)"><Face /></g>
    </g>}
    {kind === 'compact' && <g className="fw-runtime-fox-gather">
      <path d="M60 34 C82 27 106 43 106 65 C106 91 62 96 18 90 L30 79 C50 66 78 62 97 70 M72 47 Q86 51 84 64" />
      <path d="M31 61 Q24 63 25 70 M33 78 L41 80 L37 85" />
      <g transform="translate(37 47) rotate(8) scale(.83)"><Face /></g>
    </g>}
    {kind === 'retry' && <>
      <path className="fw-runtime-fox-tail" d="M50 87 C24 98 8 82 12 62 Q15 48 27 49 Q20 62 29 68 M16 63 L23 65 L19 70" />
      <path d="M42 40 Q33 56 37 74 Q40 85 54 86 H76 M54 63 L59 86 M75 57 Q86 70 80 86 H91" />
      <g transform="translate(67 39) rotate(17) scale(.85)"><g className="fw-runtime-fox-glance"><Face /></g></g>
    </>}
    {kind === 'stopping' && <>
      <path d="M83 58 C96 58 105 65 108 77 C96 73 97 91 76 90 H46 M96 70 L91 75 L98 78" />
      <path d="M34 70 Q33 79 37 84 L47 87 M62 63 L58 87 M68 47 Q79 53 78 66" />
      <path className="fw-runtime-fox-paw" d="M42 60 Q23 69 20 56 L20 47 Q24 40 28 47 L30 53" />
      <g transform="translate(51 36) scale(.85)"><Face /></g>
    </>}
    {kind === 'interrupted' && <>
      <path d="M50 51 C65 35 96 42 102 64 Q106 79 91 87 M71 60 Q82 63 82 74" />
      <path d="M16 82 C37 75 63 75 82 80 Q97 84 103 76 C100 94 66 94 43 90 Q25 89 16 86 Z M48 78 L54 83 L49 87" />
      <g transform="translate(32 60) rotate(-13) scale(.78)"><Face /></g>
    </>}
    {kind === 'error' && <>
      <path d="M73 57 Q82 63 79 74 M35 59 Q28 72 34 83 M48 67 L47 86 M61 67 L62 86" />
      <path d="M32 87 Q57 95 80 88 Q95 84 100 74 Q85 77 73 81 M86 79 L84 84 L91 82" />
      <g transform="translate(54 49) scale(.94)"><Face sad /></g>
    </>}
    {kind === 'unknown' && <>
      <path d="M39 48 Q28 63 34 85 H47 M63 52 Q76 62 71 85 H59 L56 65 M45 64 L47 85" />
      <path className="fw-runtime-fox-tail" d="M73 86 C93 89 106 76 103 58 Q101 45 93 40 C97 58 86 61 82 70 M96 57 L90 60 L94 66" />
      <g transform="translate(49 35) rotate(-18) scale(.87)"><g className="fw-runtime-fox-puzzle"><Face /></g></g>
    </>}
  </svg>
}
