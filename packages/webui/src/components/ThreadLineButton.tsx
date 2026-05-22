import { memo } from 'react'

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
      className={`absolute bottom-0 -left-2 top-0 flex w-4 cursor-pointer items-stretch justify-start rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 sm:-left-2.5 sm:w-5 ${className}`.trim()}
    >
      <span className="ml-2 block w-[2px] bg-current opacity-80 transition-opacity group-hover:opacity-100 sm:ml-2.5" />
    </button>
  )
})

export default ThreadLineButton
