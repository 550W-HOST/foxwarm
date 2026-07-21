import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RefreshCw, Settings } from 'lucide-react'
import ReloadAppButton from './ReloadAppButton'
import { MENU_VIEWPORT_GUTTER, clampAnchoredMenuHorizontally, readHorizontalViewportBounds } from './menuPositioning'

type ThemeMode = 'auto' | 'light' | 'dark'
type UiThemeStyle = 'default' | '550a'
type SendKeyMode = 'modEnter' | 'enter'

interface GlobalUiSettingsMenuProps {
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  uiThemeStyle: UiThemeStyle
  onUiThemeStyleChange: (style: UiThemeStyle) => void
  sendKeyMode: SendKeyMode
  onSendKeyModeChange: (mode: SendKeyMode) => void
  groupTools: boolean
  onGroupToolsChange: (enabled: boolean) => void
  showUsageBadge: boolean
  onShowUsageBadgeChange: (enabled: boolean) => void
  instanceName: string
  onInstanceNameChange: (name: string) => Promise<void> | void
  tabIcon: string
  onTabIconChange: (tabIcon: string) => Promise<void> | void
  menuAlign?: 'start' | 'end'
  onOpenSetup?: () => void
  setupActive?: boolean
}

export default function GlobalUiSettingsMenu({
  themeMode,
  onThemeChange,
  uiThemeStyle,
  onUiThemeStyleChange,
  sendKeyMode,
  onSendKeyModeChange,
  groupTools,
  onGroupToolsChange,
  showUsageBadge,
  onShowUsageBadgeChange,
  instanceName,
  onInstanceNameChange,
  tabIcon,
  onTabIconChange,
  menuAlign = 'end',
  onOpenSetup,
  setupActive = false,
}: GlobalUiSettingsMenuProps) {
  const [open, setOpen] = useState(false)
  const [renamingInstance, setRenamingInstance] = useState(false)
  const [editingTabIcon, setEditingTabIcon] = useState(false)
  const [draftInstanceName, setDraftInstanceName] = useState(instanceName)
  const [draftTabIcon, setDraftTabIcon] = useState(tabIcon)
  const [savingInstanceName, setSavingInstanceName] = useState(false)
  const [savingTabIcon, setSavingTabIcon] = useState(false)
  const [instanceNameError, setInstanceNameError] = useState('')
  const [tabIconError, setTabIconError] = useState('')
  const [menuOffset, setMenuOffset] = useState(0)
  const [menuPositioned, setMenuPositioned] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) {
      setMenuOffset(0)
      setMenuPositioned(false)
      return
    }

    let animationFrame = 0
    let lastGeometry = ''

    const updatePosition = () => {
      const anchor = rootRef.current
      const menu = menuRef.current
      if (!anchor || !menu) return

      const viewport = readHorizontalViewportBounds()
      const maxWidth = Math.max(0, viewport.right - viewport.left - MENU_VIEWPORT_GUTTER * 2)
      const maxWidthStyle = `${maxWidth}px`
      if (menu.style.maxWidth !== maxWidthStyle) {
        menu.style.maxWidth = maxWidthStyle
      }

      const anchorRect = anchor.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const geometry = [anchorRect.left, anchorRect.right, menuRect.width, viewport.left, viewport.right, menuAlign].join(':')

      if (geometry !== lastGeometry) {
        lastGeometry = geometry
        const placement = clampAnchoredMenuHorizontally({
          anchorLeft: anchorRect.left,
          anchorRight: anchorRect.right,
          menuWidth: menuRect.width,
          viewport,
          align: menuAlign,
        })
        setMenuOffset((current) => Math.abs(current - placement.offset) < 0.25 ? current : placement.offset)
        setMenuPositioned(true)
      }
    }

    const watchGeometry = () => {
      updatePosition()
      animationFrame = window.requestAnimationFrame(watchGeometry)
    }
    watchGeometry()

    return () => window.cancelAnimationFrame(animationFrame)
  }, [menuAlign, open])

  const menuButtonClass = 'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-100 disabled:cursor-wait disabled:opacity-70 dark:text-gray-300 dark:hover:bg-gray-700'
  const modifierLabel = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl'
  const toggleRowClass = 'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
  const menuAlignClass = menuAlign === 'start' ? 'left-0' : 'right-0'

  useEffect(() => {
    if (open && !renamingInstance) {
      setDraftInstanceName(instanceName)
      setInstanceNameError('')
    }
  }, [instanceName, open, renamingInstance])

  useEffect(() => {
    if (open && !editingTabIcon) {
      setDraftTabIcon(tabIcon)
      setTabIconError('')
    }
  }, [tabIcon, open, editingTabIcon])

  const submitInstanceName = async (name: string) => {
    setSavingInstanceName(true)
    setInstanceNameError('')
    try {
      await onInstanceNameChange(name)
      setRenamingInstance(false)
      setOpen(false)
    } catch (error: any) {
      setInstanceNameError(error?.message || 'Failed to save instance name')
    } finally {
      setSavingInstanceName(false)
    }
  }

  const submitTabIcon = async (nextTabIcon: string) => {
    setSavingTabIcon(true)
    setTabIconError('')
    try {
      await onTabIconChange(nextTabIcon)
      setEditingTabIcon(false)
      setOpen(false)
    } catch (error: any) {
      setTabIconError(error?.message || 'Failed to save tab icon')
    } finally {
      setSavingTabIcon(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition ${setupActive ? 'border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-900/40 dark:text-blue-200' : 'border-gray-200 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'}`}
        title="UI settings"
        aria-label="Open UI settings"
        aria-pressed={setupActive}
      >
        <Settings className="h-4 w-4" />
      </button>

      {open && (
        <div
          ref={menuRef}
          data-global-ui-settings-menu
          className={`absolute ${menuAlignClass} top-full z-50 mt-2 w-72 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100`}
          style={{ transform: `translateX(${menuOffset}px)`, visibility: menuPositioned ? 'visible' : 'hidden' }}
        >
          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Theme style</div>
            <div className="flex gap-1">
              {([
                { value: 'default' as const, label: 'Default' },
                { value: '550a' as const, label: '550A' },
              ]).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onUiThemeStyleChange(option.value)
                    setOpen(false)
                  }}
                  className={`flex-1 rounded px-2 py-1 text-xs ${uiThemeStyle === option.value ? (option.value === '550a' ? 'bg-red-500 text-white shadow-[0_0_12px_rgba(238,85,85,0.28)]' : 'bg-blue-500 text-white') : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="mb-2 mt-3 text-xs font-medium text-gray-500 dark:text-gray-400">Color mode</div>
            <div className="flex gap-1">
              {(['auto', 'light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    onThemeChange(mode)
                    setOpen(false)
                  }}
                  className={`flex-1 rounded px-2 py-1 text-xs capitalize ${themeMode === mode ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Input</div>
            <div className="flex gap-1">
              {([
                { value: 'modEnter' as const, label: `${modifierLabel}+Enter` },
                { value: 'enter' as const, label: 'Enter' },
              ]).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSendKeyModeChange(option.value)}
                  className={`flex-1 rounded px-2 py-1 text-xs ${sendKeyMode === option.value ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                  title={`${option.label} sends`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Chat</div>
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => onGroupToolsChange(!groupTools)}
                className={toggleRowClass}
              >
                <span>Group tools</span>
                <span className={`ml-3 inline-flex h-4 w-7 items-center rounded-full transition ${groupTools ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                  <span className={`h-3 w-3 rounded-full bg-white transition ${groupTools ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </span>
              </button>
              <button
                type="button"
                onClick={() => onShowUsageBadgeChange(!showUsageBadge)}
                className={toggleRowClass}
              >
                <span>Show usage badges</span>
                <span className={`ml-3 inline-flex h-4 w-7 items-center rounded-full transition ${showUsageBadge ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                  <span className={`h-3 w-3 rounded-full bg-white transition ${showUsageBadge ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </span>
              </button>
            </div>
          </div>

          <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Application</div>
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => {
                  setDraftInstanceName(instanceName)
                  setInstanceNameError('')
                  setEditingTabIcon(false)
                  setRenamingInstance((current) => !current)
                }}
                className={menuButtonClass}
              >
                <span>WebUI: Rename instance</span>
                <span className="ml-3 max-w-[7rem] truncate text-[10px] text-gray-400 dark:text-gray-500">
                  {instanceName || 'Foxwarm'}
                </span>
              </button>
              {renamingInstance && (
                <form
                  className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/50"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitInstanceName(draftInstanceName)
                  }}
                >
                  <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-300" htmlFor="webui-instance-name">
                    Instance name
                  </label>
                  <input
                    id="webui-instance-name"
                    type="text"
                    value={draftInstanceName}
                    maxLength={80}
                    onChange={(event) => setDraftInstanceName(event.target.value)}
                    placeholder="e.g. blackwell-node"
                    disabled={savingInstanceName}
                    className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-70 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <p className="mt-1 text-[10px] leading-snug text-gray-500 dark:text-gray-400">
                    Stored on this Foxwarm server. It changes the browser tab title for everyone using this instance.
                  </p>
                  {instanceNameError && <p className="mt-1 text-[10px] text-red-600 dark:text-red-400">{instanceNameError}</p>}
                  <div className="mt-2 flex items-center justify-end gap-1">
                    <button
                      type="button"
                      disabled={savingInstanceName || !instanceName}
                      onClick={() => void submitInstanceName('')}
                      className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      disabled={savingInstanceName}
                      onClick={() => setRenamingInstance(false)}
                      className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={savingInstanceName}
                      className="rounded bg-blue-500 px-2 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:cursor-wait disabled:opacity-70"
                    >
                      {savingInstanceName ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              )}
              <button
                type="button"
                onClick={() => {
                  setDraftTabIcon(tabIcon)
                  setTabIconError('')
                  setRenamingInstance(false)
                  setEditingTabIcon((current) => !current)
                }}
                className={menuButtonClass}
              >
                <span>WebUI: Change tab icon</span>
                <span className="ml-3 max-w-[7rem] truncate text-base leading-none text-gray-500 dark:text-gray-300">
                  {tabIcon || '🦊'}
                </span>
              </button>
              {editingTabIcon && (
                <form
                  className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/50"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitTabIcon(draftTabIcon)
                  }}
                >
                  <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-300" htmlFor="webui-tab-icon">
                    Browser tab icon
                  </label>
                  <input
                    id="webui-tab-icon"
                    type="text"
                    value={draftTabIcon}
                    maxLength={32}
                    onChange={(event) => setDraftTabIcon(event.target.value)}
                    placeholder="e.g. 🚀"
                    disabled={savingTabIcon}
                    className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-70 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <p className="mt-1 text-[10px] leading-snug text-gray-500 dark:text-gray-400">
                    Use an emoji or very short text. It changes the favicon shown in the browser tab for this Foxwarm instance.
                  </p>
                  {tabIconError && <p className="mt-1 text-[10px] text-red-600 dark:text-red-400">{tabIconError}</p>}
                  <div className="mt-2 flex items-center justify-end gap-1">
                    <button
                      type="button"
                      disabled={savingTabIcon || !tabIcon}
                      onClick={() => void submitTabIcon('')}
                      className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      disabled={savingTabIcon}
                      onClick={() => setEditingTabIcon(false)}
                      className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={savingTabIcon}
                      className="rounded bg-blue-500 px-2 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:cursor-wait disabled:opacity-70"
                    >
                      {savingTabIcon ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              )}
              {onOpenSetup && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenSetup()
                    setOpen(false)
                  }}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${setupActive ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'}`}
                >
                  <span>WebUI: Open setup</span>
                  {setupActive && <span className="text-[10px] uppercase tracking-wide">active</span>}
                </button>
              )}
              <ReloadAppButton className={menuButtonClass}>
                <span>WebUI: reload</span>
                <RefreshCw className="h-3.5 w-3.5" />
              </ReloadAppButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
