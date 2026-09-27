import { useEffect, useState } from 'react'

export type WebUiBrandingSettingsValue = {
  instanceName: string
  tabIcon: string
}

interface WebUiBrandingSettingsProps {
  value: WebUiBrandingSettingsValue
  onInstanceNameChange: (name: string) => Promise<void> | void
  onTabIconChange: (tabIcon: string) => Promise<void> | void
}

export default function WebUiBrandingSettings({ value, onInstanceNameChange, onTabIconChange }: WebUiBrandingSettingsProps) {
  const [draftInstanceName, setDraftInstanceName] = useState(value.instanceName)
  const [draftTabIcon, setDraftTabIcon] = useState(value.tabIcon)
  const [savingInstanceName, setSavingInstanceName] = useState(false)
  const [savingTabIcon, setSavingTabIcon] = useState(false)
  const [instanceNameError, setInstanceNameError] = useState('')
  const [tabIconError, setTabIconError] = useState('')

  useEffect(() => {
    setDraftInstanceName(value.instanceName)
  }, [value.instanceName])

  useEffect(() => {
    setDraftTabIcon(value.tabIcon)
  }, [value.tabIcon])

  const submitInstanceName = async (name: string) => {
    setSavingInstanceName(true)
    setInstanceNameError('')
    try {
      await onInstanceNameChange(name)
    } catch (error: any) {
      setInstanceNameError(error?.message || 'Failed to save instance name')
    } finally {
      setSavingInstanceName(false)
    }
  }

  const submitTabIcon = async (tabIcon: string) => {
    setSavingTabIcon(true)
    setTabIconError('')
    try {
      await onTabIconChange(tabIcon)
    } catch (error: any) {
      setTabIconError(error?.message || 'Failed to save tab icon')
    } finally {
      setSavingTabIcon(false)
    }
  }

  const inputClass = 'mt-1 w-full rounded border border-fw-border-strong bg-fw-surface px-3 py-2 text-sm text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-1 focus:ring-fw-focus-ring disabled:opacity-70 dark:border-fw-border-strong dark:bg-fw-surface dark:text-fw-text-strong'
  const secondaryButtonClass = 'rounded-lg border border-fw-border px-3 py-2 text-sm font-medium text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-50 dark:border-fw-border dark:text-fw-text-strong dark:hover:bg-fw-hover'

  return (
    <section data-webui-branding-settings className="mt-6 border-t border-fw-border pt-5 dark:border-fw-border-muted">
      <h2 className="text-base font-semibold text-fw-text-strong">Browser appearance</h2>
      <p className="mt-1 text-sm text-fw-text">Customize the shared name and icon shown in browser tabs for this Foxwarm instance.</p>

      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <form
          onSubmit={event => {
            event.preventDefault()
            void submitInstanceName(draftInstanceName)
          }}
        >
          <label className="block text-sm font-medium text-fw-text-strong" htmlFor="webui-instance-name">Rename instance</label>
          <input
            id="webui-instance-name"
            type="text"
            value={draftInstanceName}
            maxLength={80}
            onChange={event => {
              setDraftInstanceName(event.target.value)
              setInstanceNameError('')
            }}
            placeholder="Foxwarm"
            disabled={savingInstanceName}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-fw-text-muted">Leave empty to use Foxwarm.</p>
          {instanceNameError && <p role="alert" className="mt-1 text-xs text-fw-danger">{instanceNameError}</p>}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={savingInstanceName || !value.instanceName}
              onClick={() => void submitInstanceName('')}
              className={secondaryButtonClass}
            >
              Clear
            </button>
            <button
              type="button"
              disabled={savingInstanceName || draftInstanceName === value.instanceName}
              onClick={() => {
                setDraftInstanceName(value.instanceName)
                setInstanceNameError('')
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button type="submit" disabled={savingInstanceName} className="rounded-lg bg-fw-accent px-3 py-2 text-sm font-medium text-fw-text-inverse hover:bg-fw-accent disabled:cursor-wait disabled:opacity-70">
              {savingInstanceName ? 'Saving…' : 'Save name'}
            </button>
          </div>
        </form>

        <form
          onSubmit={event => {
            event.preventDefault()
            void submitTabIcon(draftTabIcon)
          }}
        >
          <label className="block text-sm font-medium text-fw-text-strong" htmlFor="webui-tab-icon">Change tab icon</label>
          <input
            id="webui-tab-icon"
            type="text"
            value={draftTabIcon}
            maxLength={32}
            onChange={event => {
              setDraftTabIcon(event.target.value)
              setTabIconError('')
            }}
            placeholder="🦊"
            disabled={savingTabIcon}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-fw-text-muted">Use an emoji or very short text. Leave empty to use 🦊.</p>
          {tabIconError && <p role="alert" className="mt-1 text-xs text-fw-danger">{tabIconError}</p>}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={savingTabIcon || !value.tabIcon}
              onClick={() => void submitTabIcon('')}
              className={secondaryButtonClass}
            >
              Clear
            </button>
            <button
              type="button"
              disabled={savingTabIcon || draftTabIcon === value.tabIcon}
              onClick={() => {
                setDraftTabIcon(value.tabIcon)
                setTabIconError('')
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button type="submit" disabled={savingTabIcon} className="rounded-lg bg-fw-accent px-3 py-2 text-sm font-medium text-fw-text-inverse hover:bg-fw-accent disabled:cursor-wait disabled:opacity-70">
              {savingTabIcon ? 'Saving…' : 'Save icon'}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
