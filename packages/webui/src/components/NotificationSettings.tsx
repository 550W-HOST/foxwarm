import { useEffect, useState } from 'react'
import { requestSessionIdleNotificationPermission, useQuestionNotificationMode, type QuestionNotificationMode } from '../sessionIdleNotifications'

type PermissionState = NotificationPermission | 'unsupported'

const readPermission = (): PermissionState => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

const QUESTION_CHOICES: Array<{ value: QuestionNotificationMode; label: string; description: string }> = [
  { value: 'all', label: 'All sessions', description: 'Notify when any session asks you a question.' },
  { value: 'watched', label: 'Only sessions with notifications on', description: 'Notify only for sessions with Notify on idle turned on in the session menu.' },
  { value: 'off', label: 'Off', description: 'Questions still appear in the session list and the conversation.' },
]

const PERMISSION_LABEL: Record<PermissionState, string> = {
  granted: 'Allowed',
  denied: 'Blocked',
  default: 'Not requested yet',
  unsupported: 'Not supported',
}

/** Browser-local notification preferences shown in Setup. */
export default function NotificationSettings() {
  const [permission, setPermission] = useState<PermissionState>(readPermission)
  const [requesting, setRequesting] = useState(false)
  const [questionMode, setQuestionMode] = useQuestionNotificationMode()

  useEffect(() => {
    // The user can change the permission in browser settings while the page stays open.
    const refresh = () => setPermission(readPermission())
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  const requestPermission = async () => {
    setRequesting(true)
    try { await requestSessionIdleNotificationPermission() }
    finally { setRequesting(false); setPermission(readPermission()) }
  }

  return (
    <div className="flex flex-col gap-6">
      <section data-notification-permission={permission}>
        <h2 className="text-base font-semibold text-fw-text-strong">Browser permission</h2>
        <p className="mt-1 text-sm text-fw-text">Notifications appear while Foxwarm is open in this browser. These settings apply to this browser only.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-sm text-fw-text">Status: <span className={`font-medium ${permission === 'granted' ? 'text-fw-success' : permission === 'denied' ? 'text-fw-danger' : 'text-fw-text-strong'}`}>{PERMISSION_LABEL[permission]}</span></span>
          {permission === 'default' && (
            <button type="button" disabled={requesting} onClick={() => void requestPermission()} className="rounded-lg bg-fw-accent px-3 py-1.5 text-sm font-medium text-fw-accent-text hover:opacity-90 disabled:opacity-50">
              Allow notifications
            </button>
          )}
        </div>
        {permission === 'denied' && <p className="mt-2 text-sm text-fw-text-muted">Notifications are blocked for this site. Allow them in your browser's site settings.</p>}
        {permission === 'unsupported' && <p className="mt-2 text-sm text-fw-text-muted">This browser does not support notifications.</p>}
      </section>

      <section className="border-t border-fw-border pt-5 dark:border-fw-border-muted">
        <h2 id="question-notifications-heading" className="text-base font-semibold text-fw-text-strong">Questions from agents</h2>
        <p className="mt-1 text-sm text-fw-text">Get notified when an agent asks you a question in a session you are not viewing.</p>
        <div role="radiogroup" aria-labelledby="question-notifications-heading" className="mt-3 flex flex-col gap-2">
          {QUESTION_CHOICES.map(choice => (
            <label key={choice.value} data-question-notification-choice={choice.value} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 ${questionMode === choice.value ? 'border-fw-accent-border bg-fw-accent-surface dark:bg-fw-accent-surface-strong/30' : 'border-fw-border hover:bg-fw-hover'}`}>
              <input type="radio" name="question-notifications" value={choice.value} checked={questionMode === choice.value} onChange={() => setQuestionMode(choice.value)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-fw-text-strong">{choice.label}</span>
                <span className="block text-xs text-fw-text-muted">{choice.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="border-t border-fw-border pt-5 dark:border-fw-border-muted">
        <h2 className="text-base font-semibold text-fw-text-strong">Idle sessions</h2>
        <p className="mt-1 text-sm text-fw-text">To be notified when a session finishes its work, turn on Notify on idle from that session's menu.</p>
      </section>
    </div>
  )
}
