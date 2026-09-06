import { memo } from 'react'
import { ChevronRight } from 'lucide-react'

interface ThreadLineButtonProps {
  expanded: boolean
  onToggle: () => void
  label: string
  className?: string
}

const ThreadLineButton = memo(function ThreadLineButton({
  expanded,
  onToggle,
  label,
  className = '',
}: ThreadLineButtonProps) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={`foxwarm-thread-line-button absolute bottom-0 -left-2 top-0 flex w-[14px] cursor-pointer items-stretch justify-start rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fw-focus-ring sm:-left-2.5 sm:w-[18px] ${className}`.trim()}
    >
      <span className="foxwarm-thread-line-stroke ml-2 block w-[2px] bg-current opacity-80 transition-opacity group-hover:opacity-100 sm:ml-2.5" />
      <ChevronRight className="foxwarm-thread-disclosure-icon hidden" size={13} aria-hidden="true" />
    </button>
  )
})

export default ThreadLineButton
