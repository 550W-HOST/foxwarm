import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { WorkbenchTabHeaderProvider } from './WorkbenchTabHeader'
import WorkbenchTabErrorBoundary from './WorkbenchTabErrorBoundary'
import { PaneDropTargets, WorkbenchPaneToolbar, type WorkbenchPaneProps } from './WorkbenchPane'
import { useWorkbenchTabMenu } from './useWorkbenchTabMenu'
import { ContentBeforeResizeContext } from '../contentResize'
import type { WorkbenchTab } from '../workbench/types'
import { isWorkbenchPaneDragBlankTarget } from './WorkbenchPaneDragArea'

type PositionedHost = { element: HTMLElement; paneId: string; visible: boolean; onFocus: () => void; beforeResize: () => void }

function createContentPositions() {
  const slots = new Map<string, HTMLElement>()
  const hosts = new Map<string, PositionedHost>()
  let layer: HTMLElement | null = null
  let observer: ResizeObserver | null = null
  let frame = 0
  let focusCheckFrame = 0

  const measure = () => {
    window.cancelAnimationFrame(frame)
    frame = 0
    // Fixed-layer and slot rectangles share the browser's current viewport coordinates.
    // Their origins can differ while a mobile visual viewport pans above a keyboard.
    const layerRect = layer?.getBoundingClientRect()
    // Read every slot before writing any host, including during continuous resizing.
    const positions = [...hosts.values()].map(host => {
      const slot = slots.get(host.paneId)
      const rect = layerRect && host.visible && slot?.isConnected ? slot.getBoundingClientRect() : null
      const paneRect = rect && slot ? slot.closest('[data-pane-id]')?.getBoundingClientRect() : null
      const hostRect = host.element.getBoundingClientRect()
      return { host, rect, hostRect, paneRect, radius: rect && slot ? getComputedStyle(slot).borderRadius : '' }
    })
    for (const { host, rect, hostRect } of positions) {
      // CSSOM serializes fractional sizes; compare actual layout, not decimal strings.
      if (rect && (hostRect.width !== rect.width || hostRect.height !== rect.height)) host.beforeResize()
    }
    for (const { host, rect, paneRect, radius } of positions) {
      const visible = !!rect && rect.width > 0 && rect.height > 0
      const style = host.element.style
      if (rect) {
        style.left = `${rect.left - layerRect!.left}px`
        style.top = `${rect.top - layerRect!.top}px`
        style.width = `${rect.width}px`
        style.height = `${rect.height}px`
        style.borderRadius = radius
        // Drop targets retain the whole pane rectangle, including its tab strip.
        const overlay = host.element.querySelector<HTMLElement>('[data-workbench-pane-drop-overlay]')
        if (overlay && paneRect) {
          overlay.style.left = `${paneRect.left - rect.left}px`
          overlay.style.top = `${paneRect.top - rect.top}px`
          overlay.style.width = `${paneRect.width}px`
          overlay.style.height = `${paneRect.height}px`
        }
      }
      const becameVisible = visible && style.visibility !== 'visible'
      style.visibility = visible ? 'visible' : 'hidden'
      style.pointerEvents = visible ? 'auto' : 'none'
      host.element.inert = !visible
      if (becameVisible) {
        try {
          host.element.querySelector('iframe')?.contentWindow?.dispatchEvent(new Event('resize'))
        } catch {
          // Development proxies may give Code a different origin.
        }
      }
    }
  }
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(measure)
  }

  return {
    measure,
    registerLayer(element: HTMLElement | null) {
      layer = element
      schedule()
    },
    registerSlot(paneId: string, element: HTMLElement | null) {
      const previous = slots.get(paneId)
      if (previous) observer?.unobserve(previous)
      if (element) {
        slots.set(paneId, element)
        observer?.observe(element)
      } else slots.delete(paneId)
      schedule()
    },
    registerHost(tabId: string, host: PositionedHost | null) {
      if (host) hosts.set(tabId, host)
      else hosts.delete(tabId)
      schedule()
    },
    start() {
      observer = new ResizeObserver(schedule)
      for (const slot of slots.values()) observer.observe(slot)
      window.addEventListener('resize', schedule)
      document.addEventListener('scroll', schedule, true)
      window.visualViewport?.addEventListener('resize', schedule)
      window.visualViewport?.addEventListener('scroll', schedule)
      // Focus entering an iframe does not bubble through its outer content host.
      const focusFrame = () => {
        window.cancelAnimationFrame(focusCheckFrame)
        // Firefox updates activeElement after blur dispatch, unlike Chromium.
        focusCheckFrame = window.requestAnimationFrame(() => {
          focusCheckFrame = 0
          for (const host of hosts.values()) {
            if (host.visible && !host.element.inert && host.element.contains(document.activeElement)) host.onFocus()
          }
        })
      }
      window.addEventListener('blur', focusFrame)
      return () => {
        window.cancelAnimationFrame(focusCheckFrame)
        focusCheckFrame = 0
        window.cancelAnimationFrame(frame)
        frame = 0
        observer?.disconnect()
        observer = null
        window.removeEventListener('resize', schedule)
        document.removeEventListener('scroll', schedule, true)
        window.visualViewport?.removeEventListener('resize', schedule)
        window.visualViewport?.removeEventListener('scroll', schedule)
        window.removeEventListener('blur', focusFrame)
      }
    },
  }
}

const ContentPositions = createContext<ReturnType<typeof createContentPositions> | null>(null)

export function WorkbenchContentProvider({ children }: { children: ReactNode }) {
  const positions = useMemo(createContentPositions, [])
  useLayoutEffect(() => positions.start(), [positions])
  // Slot refs may be replaced by split/normalization in this same commit. Position
  // before paint, without treating that temporary absence as a tab lifecycle event.
  useLayoutEffect(() => positions.measure())
  return <ContentPositions.Provider value={positions}>{children}</ContentPositions.Provider>
}

export function WorkbenchContentSlot({ paneId, soleTab, tabType }: { paneId: string; soleTab: boolean; tabType?: WorkbenchTab['type'] }) {
  const positions = useContext(ContentPositions)!
  const setRef = useCallback((element: HTMLDivElement | null) => positions.registerSlot(paneId, element), [positions, paneId])
  return <div ref={setRef} className="foxwarm-workbench-content-slot h-full min-h-0 w-full"
    data-workbench-content-slot={paneId} data-workbench-sole-content={soleTab || undefined}
    data-foxwarm-vscode-web-slot={tabType === 'vscode' ? 'true' : undefined} />
}

export function WorkbenchContentLayer({ children }: { children: ReactNode }) {
  const positions = useContext(ContentPositions)!
  const setRef = useCallback((element: HTMLDivElement | null) => positions.registerLayer(element), [positions])
  return createPortal(<div ref={setRef} className="pointer-events-none fixed inset-0 z-30" data-workbench-content-layer>{children}</div>, document.body)
}

type ContentHostProps = Pick<WorkbenchPaneProps,
  'paneId' | 'focused' | 'collapseDirection' | 'tabs' | 'dragEnabled' | 'hideTabStrip' | 'showPaneControls' | 'canClosePane' |
  'onFocusPane' | 'onSetCollapsed' | 'onClosePane' | 'onCloseTab' | 'onKeepTab' | 'onMoveTabToNewWindow' |
  'canMoveTabToNewWindow' | 'onCloseOtherTabs' | 'onCloseAllTabs'> & {
  tab: WorkbenchTab
  visible: boolean
  canClose?: boolean
  renderContent: () => ReactNode
}

function RenderedTabContent({ renderContent }: { renderContent: () => ReactNode }) {
  return <>{renderContent()}</>
}

export default function WorkbenchContentHost(props: ContentHostProps) {
  const { tab, paneId, visible, tabs, dragEnabled = true, hideTabStrip, renderContent, onFocusPane, onCloseTab } = props
  const positions = useContext(ContentPositions)!
  const elementRef = useRef<HTMLDivElement | null>(null)
  const beforeResize = useRef<(() => void) | null>(null)
  const handleOverlayMount = useCallback((element: HTMLDivElement | null) => {
    if (element) positions.measure()
  }, [positions])
  const { openContextMenu, openMenuAtElement, menu } = useWorkbenchTabMenu(props)
  const header = visible && hideTabStrip && props.showPaneControls !== false && tabs.length === 1 ? {
    tab, paneId, dragEnabled, canMovePane: props.canClosePane, onCloseTab, onKeepTab: props.onKeepTab, openContextMenu, openMenuAtElement,
    paneControls: <WorkbenchPaneToolbar paneId={paneId} collapsed={false}
      verticalRail={props.collapseDirection === 'row'} canClosePane={props.canClosePane}
      onSetCollapsed={props.onSetCollapsed} onClosePane={props.onClosePane} />,
  } : null

  useLayoutEffect(() => {
    if (elementRef.current) positions.registerHost(tab.id, {
      element: elementRef.current,
      paneId,
      visible,
      onFocus: () => { if (!props.focused) onFocusPane(paneId) },
      beforeResize: () => beforeResize.current?.(),
    })
  })
  useLayoutEffect(() => () => positions.registerHost(tab.id, null), [positions, tab.id])
  // The layer is outside the pane DOM; focus and pointer activation are explicit.
  const activate = (event: SyntheticEvent) => {
    const target = event.target as HTMLElement
    // Pane/Close/menu controls own their navigation and must not queue an
    // activation that can reopen a pane immediately after collapsing it.
    if (isWorkbenchPaneDragBlankTarget(target) || target.closest('[data-workbench-pane-controls], [data-workbench-tab-close], [role="menu"]')) return
    onFocusPane(paneId)
  }
  return <div ref={elementRef} className="absolute bg-fw-canvas"
    style={{ visibility: 'hidden', pointerEvents: 'none' }}
    data-workbench-content-tab={tab.id} data-workbench-content-pane={paneId}
    data-history-search-portal={tab.type === 'search' ? tab.id : undefined}
    onPointerDownCapture={activate} onFocusCapture={activate}>
    <div className="h-full min-h-0 overflow-hidden" style={{ borderRadius: 'inherit' }}>
      <ContentBeforeResizeContext.Provider value={beforeResize}>
        <WorkbenchTabHeaderProvider value={header}>
          <WorkbenchTabErrorBoundary tabId={tab.id} tabTitle={tab.title} canClose={props.canClose !== false}
            onClose={() => onCloseTab(tab.id)}>
            <RenderedTabContent renderContent={renderContent} />
          </WorkbenchTabErrorBoundary>
        </WorkbenchTabHeaderProvider>
      </ContentBeforeResizeContext.Provider>
    </div>
    {visible && <PaneDropTargets paneId={paneId} onOverlayMount={handleOverlayMount} />}
    {menu}
  </div>
}
