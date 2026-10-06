import { Component, type ErrorInfo, type ReactNode } from 'react'

interface WorkbenchTabErrorBoundaryProps {
  tabId: string
  tabTitle: string
  canClose: boolean
  onClose: () => void
  children: ReactNode
}

type WorkbenchTabErrorBoundaryState = {
  error: Error | null
}

export default class WorkbenchTabErrorBoundary extends Component<WorkbenchTabErrorBoundaryProps, WorkbenchTabErrorBoundaryState> {
  state: WorkbenchTabErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): WorkbenchTabErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Workbench tab failed to render', { tabId: this.props.tabId, tabTitle: this.props.tabTitle }, error, info)
  }

  private retry = () => {
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-fw-surface-sunken px-6 text-center text-sm text-fw-text-muted dark:bg-fw-canvas-edge">
        <div className="max-w-sm space-y-3">
          <div className="text-base font-medium text-fw-text-strong">This tab couldn&apos;t be displayed.</div>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              aria-label="Retry tab"
              onClick={this.retry}
              className="rounded-lg border border-fw-border bg-fw-surface px-3 py-1.5 font-medium text-fw-text transition hover:bg-fw-hover hover:text-fw-text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fw-accent"
            >
              Retry
            </button>
            {this.props.canClose && (
              <button
                type="button"
                aria-label="Close tab"
                onClick={this.props.onClose}
                className="rounded-lg border border-fw-border bg-fw-surface px-3 py-1.5 font-medium text-fw-text transition hover:bg-fw-hover hover:text-fw-text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fw-accent"
              >
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
