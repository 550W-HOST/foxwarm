// The sidebar's brand: the instance's emoji and name from the WebUI settings when they are
// set, otherwise the Foxwarm logo and name. Inside a Desktop host it is a button that asks
// the host to open its native instance menu below it; elsewhere it is a plain heading.
import { FoxwarmMark } from './FoxwarmMark'
import { hasHostChannel, requestInstanceMenu } from '../windowFrame'

export type InstanceBranding = { instanceName: string; tabIcon: string }

export default function InstanceBrand({ branding, hosted = hasHostChannel() }: { branding: InstanceBranding; hosted?: boolean }) {
  const icon = branding.tabIcon.trim()
  const name = branding.instanceName.trim()
  const content = <>
    {icon
      ? <span className="foxwarm-sidebar-brand-icon shrink-0" aria-hidden="true">{icon}</span>
      : <FoxwarmMark className="foxwarm-sidebar-brand-mark h-6 w-6 shrink-0" />}
    {/* Under the macOS lights only the default wordmark gives way to the menu bar's app name. */}
    <span className="foxwarm-sidebar-wordmark truncate" data-brand-default={name ? undefined : ''}>{name || 'Foxwarm'}</span>
  </>
  return (
    <h1 className="flex min-w-0 items-center gap-2 text-xl font-bold text-fw-text-strong" data-instance-brand="">
      {hosted
        ? <button
            type="button"
            data-instance-menu=""
            aria-haspopup="menu"
            title="Switch instance"
            onClick={event => { requestInstanceMenu(event.currentTarget.getBoundingClientRect()) }}
            className="foxwarm-instance-menu-button -mx-1.5 flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5 text-inherit hover:bg-fw-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring/40"
          >{content}</button>
        : content}
    </h1>
  )
}
