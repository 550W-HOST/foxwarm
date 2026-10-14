import { useState, type ReactNode } from 'react'
import { RotateCcw, Expand } from 'lucide-react'
import { FoxCub, FoxSplashScreen, FoxSpinner, FoxThinking } from './FoxLoaders'

function PreviewCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl border border-fw-border bg-fw-surface dark:border-fw-border-muted">
      <div className="flex h-9 items-center gap-2 border-b border-fw-border px-3 dark:border-fw-border-muted">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-fw-text-muted">{title}</h3>
        {action}
      </div>
      <div className="flex min-h-[140px] flex-1 items-center justify-center p-4">{children}</div>
    </div>
  )
}

const iconButtonClass = 'inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong'

/** Live previews of the fox loaders, rendered with the active theme's accent. */
export default function FoxLoaderPreview() {
  const [replay, setReplay] = useState(0)
  const [splash, setSplash] = useState(false)

  return (
    <section data-fox-loader-preview className="mt-6 border-t border-fw-border pt-5 dark:border-fw-border-muted">
      <h2 className="text-base font-semibold text-fw-text-strong">Loading animations</h2>
      <p className="mt-1 text-sm text-fw-text">The fox shown while Foxwarm starts and while a model is thinking. It follows the theme's accent color.</p>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <PreviewCard
          title="Entry splash"
          action={<>
            <button type="button" onClick={() => setReplay(count => count + 1)} className={iconButtonClass} aria-label="Replay entry animation"><RotateCcw className="h-3 w-3" aria-hidden="true" />Replay</button>
            <button type="button" onClick={() => setSplash(true)} className={iconButtonClass} aria-label="Preview full-screen splash"><Expand className="h-3 w-3" aria-hidden="true" />Full screen</button>
          </>}
        >
          <FoxCub key={replay} size={120} />
        </PreviewCard>
        <PreviewCard title="Thinking status">
          <div className="inline-flex items-center gap-2 rounded-lg border border-fw-accent-border bg-fw-accent-surface px-4 py-2 text-sm text-fw-accent dark:bg-fw-accent-surface-strong/20">
            <FoxThinking />
            <span>Thinking...</span>
          </div>
        </PreviewCard>
        <PreviewCard title="Spinner">
          <div className="flex items-end gap-5">
            <FoxSpinner size={20} />
            <FoxSpinner size={28} />
            <FoxSpinner size={40} />
          </div>
        </PreviewCard>
      </div>
      {splash && <FoxSplashScreen onClick={() => setSplash(false)} />}
    </section>
  )
}
