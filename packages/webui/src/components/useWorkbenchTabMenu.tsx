import { useMemo, useState, type MouseEvent } from 'react'
import { Bookmark, Copy, ExternalLink, X } from 'lucide-react'
import ContextMenu, { type ContextMenuAnchorRect, type ContextMenuEntry } from './ContextMenu'
import type { WorkbenchTab } from '../workbench/types'

export interface WorkbenchTabMenuOptions {
  tabs: WorkbenchTab[]
  onCloseTab: (tabId: string) => void
  onKeepTab: (tabId: string) => void
  onMoveTabToNewWindow: (tabId: string) => void
  canMoveTabToNewWindow: (tabId: string) => boolean
  onCloseOtherTabs: (tabId: string) => void
  onCloseAllTabs: () => void
}

interface TabContextMenuState {
  tabId: string
  x: number
  y: number
  anchorRect?: ContextMenuAnchorRect
  preferredPlacement?: 'point' | 'bottom-start' | 'bottom-end'
}

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Fallback below
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function getTabCopyId(tab: WorkbenchTab) {
  if (tab.type === 'chat') return tab.sessionId
  return tab.id
}

function getTabCopyPath(tab: WorkbenchTab) {
  if (tab.type === 'terminal') return tab.cwd || null
  return null
}

export function useWorkbenchTabMenu({ tabs, onCloseTab, onKeepTab, onMoveTabToNewWindow, canMoveTabToNewWindow, onCloseOtherTabs, onCloseAllTabs }: WorkbenchTabMenuOptions) {
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null)
  const contextMenuTab = useMemo(
    () => (contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) || null : null),
    [contextMenu, tabs],
  )

  const menuEntries = useMemo<ContextMenuEntry[]>(() => {
    if (!contextMenuTab) return []

    const entries: ContextMenuEntry[] = []
    const copyPath = getTabCopyPath(contextMenuTab)

    if (contextMenuTab.type === 'chat' && contextMenuTab.preview) {
      entries.push({
        key: 'keep',
        label: 'Keep',
        icon: <Bookmark className="h-4 w-4" />,
        onSelect: () => onKeepTab(contextMenuTab.id),
      })
    }

    entries.push({
      key: 'copy-id',
      label: 'Copy id',
      icon: <Copy className="h-4 w-4" />,
      onSelect: () => {
        void copyTextToClipboard(getTabCopyId(contextMenuTab))
      },
    })

    if (copyPath) {
      entries.push({
        key: 'copy-path',
        label: 'Copy path',
        icon: <Copy className="h-4 w-4" />,
        onSelect: () => {
          void copyTextToClipboard(copyPath)
        },
      })
    }

    entries.push({ key: 'separator-window', type: 'separator' })
    entries.push({
      key: 'move-new-window',
      label: 'Move to new window',
      icon: <ExternalLink className="h-4 w-4" />,
      disabled: !canMoveTabToNewWindow(contextMenuTab.id),
      onSelect: () => onMoveTabToNewWindow(contextMenuTab.id),
    })

    entries.push({ key: 'separator-close', type: 'separator' })
    entries.push({
      key: 'close',
      label: 'Close',
      icon: <X className="h-4 w-4" />,
      danger: true,
      onSelect: () => onCloseTab(contextMenuTab.id),
    })

    entries.push({ key: 'separator-bulk-close', type: 'separator' })
    entries.push({
      key: 'close-others',
      label: 'Close others',
      icon: <X className="h-4 w-4" />,
      disabled: tabs.length <= 1,
      onSelect: () => onCloseOtherTabs(contextMenuTab.id),
    })
    entries.push({
      key: 'close-all',
      label: 'Close all',
      icon: <X className="h-4 w-4" />,
      onSelect: onCloseAllTabs,
    })

    return entries
  }, [canMoveTabToNewWindow, contextMenuTab, onCloseAllTabs, onCloseOtherTabs, onCloseTab, onKeepTab, onMoveTabToNewWindow, tabs.length])

  const openContextMenu = (tabId: string, event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      tabId,
      x: event.clientX,
      y: event.clientY,
      preferredPlacement: 'point',
    })
  }

  const openMenuAtElement = (tabId: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    setContextMenu({ tabId, x: rect.left, y: rect.bottom, anchorRect: rect, preferredPlacement: 'bottom-start' })
  }

  return {
    openContextMenu,
    openMenuAtElement,
    menu: (
      <ContextMenu
        open={!!contextMenuTab}
        entries={menuEntries}
        point={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null}
        anchorRect={contextMenu?.anchorRect || null}
        preferredPlacement={contextMenu?.preferredPlacement || 'point'}
        onClose={() => setContextMenu(null)}
      />
    ),
  }
}
