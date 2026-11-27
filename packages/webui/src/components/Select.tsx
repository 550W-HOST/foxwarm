import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { MENU_SURFACE_CLASS, SelectionMark } from './ContextMenu'
import { clampAnchoredMenuHorizontally, menuPortalContainer, placeAnchoredMenuVertically, readHorizontalViewportBounds, useMenuDismissal } from './menuPositioning'
import { reduceSelectKey, type SelectKeyInput } from './selectKeyboard'
import { usePrimaryPointerCoarse } from '../pointerQueries'

export type SelectOption = {
  value: string
  label: string
  disabled?: boolean
}

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined }

export type SelectProps = DataAttributes & {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  /**
   * `field` sits among form inputs and takes their look from `className`;
   * `toolbar` is the compact filter control used in view toolbars.
   */
  variant?: 'field' | 'toolbar'
  className?: string
  /** Leading icon inside the trigger. */
  icon?: ReactNode
  id?: string
  disabled?: boolean
  title?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

const TOOLBAR_CLASS = 'h-9 rounded-lg border border-fw-border bg-fw-surface px-3 text-xs text-fw-text-strong outline-none hover:bg-fw-hover focus-visible:border-fw-accent-border disabled:cursor-not-allowed disabled:opacity-50'
const LIST_MAX_HEIGHT = 320
const TYPEAHEAD_RESET_MS = 600

/**
 * The WebUI's one choice control. With a fine pointer the trigger opens a drawn
 * list; with a coarse pointer a transparent native select covers the same
 * trigger, so phones show their system picker while the closed state matches.
 */
const Select = forwardRef<HTMLElement, SelectProps>(function Select({
  value,
  options,
  onChange,
  variant = 'field',
  className = '',
  icon,
  id,
  disabled = false,
  title,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  ...rest
}, forwardedRef) {
  const coarse = usePrimaryPointerCoarse()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nativeRef = useRef<HTMLSelectElement>(null)
  useImperativeHandle(forwardedRef, () => (coarse ? nativeRef.current : triggerRef.current) as HTMLElement, [coarse])

  const selectedIndex = options.findIndex(option => option.value === value)
  const shown = options[selectedIndex >= 0 ? selectedIndex : 0]
  const dataAttributes = Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('data-')))
  const triggerClass = `foxwarm-select relative inline-flex min-w-0 items-center gap-2 text-left ${variant === 'toolbar' ? TOOLBAR_CLASS : ''} ${className}`

  // Every label sizes the trigger, as with a native select, so the control
  // keeps its width when the value changes. The sizers draw their label as
  // generated content, so it stays out of the trigger's text.
  const content = (
    <>
      {icon ? <span aria-hidden="true" className="flex shrink-0 items-center text-fw-text-muted">{icon}</span> : null}
      <span className="grid min-w-0 flex-1">
        {options.map(option => <span key={option.value} aria-hidden="true" data-label={option.label} className="foxwarm-select-sizer invisible col-start-1 row-start-1 truncate whitespace-nowrap" />)}
        <span data-select-value aria-hidden={coarse || undefined} className="col-start-1 row-start-1 truncate whitespace-nowrap">{shown?.label ?? ''}</span>
      </span>
      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fw-text-muted" />
    </>
  )

  if (coarse) {
    return (
      <span className={`${triggerClass} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`} data-select-variant={variant} data-select-mode="native" title={title}>
        {content}
        <select
          ref={nativeRef}
          id={id}
          value={value}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          onChange={event => onChange(event.currentTarget.value)}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
          {...dataAttributes}
        >
          {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        </select>
      </span>
    )
  }

  return (
    <SelectList
      triggerRef={triggerRef}
      triggerClass={triggerClass}
      content={content}
      variant={variant}
      value={value}
      options={options}
      selectedIndex={selectedIndex}
      onChange={onChange}
      id={id}
      disabled={disabled}
      title={title}
      ariaLabel={ariaLabel}
      ariaDescribedBy={ariaDescribedBy}
      dataAttributes={dataAttributes}
    />
  )
})

export default Select

function SelectList({ triggerRef, triggerClass, content, variant, value, options, selectedIndex, onChange, id, disabled, title, ariaLabel, ariaDescribedBy, dataAttributes }: {
  triggerRef: RefObject<HTMLButtonElement>
  triggerClass: string
  content: ReactNode
  variant: 'field' | 'toolbar'
  value: string
  options: readonly SelectOption[]
  selectedIndex: number
  onChange: (value: string) => void
  id?: string
  disabled: boolean
  title?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  dataAttributes: Record<string, unknown>
}) {
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number) => `${baseId}-option-${index}`
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [placement, setPlacement] = useState<{ left: number; top: number; minWidth: number; maxWidth: number; maxHeight: number } | null>(null)
  const typeaheadRef = useRef('')
  const typeaheadTimer = useRef<number | null>(null)
  const scrollOnOpen = useRef(false)

  const close = useCallback(() => {
    setOpen(false)
    setActive(-1)
    setPlacement(null)
    typeaheadRef.current = ''
  }, [])

  const show = useCallback((index: number) => {
    scrollOnOpen.current = true
    setActive(index)
    setOpen(true)
  }, [])

  const commit = useCallback((index: number | undefined) => {
    close()
    const option = index === undefined ? undefined : options[index]
    if (option && !option.disabled && option.value !== value) onChange(option.value)
  }, [close, onChange, options, value])

  useEffect(() => () => { if (typeaheadTimer.current !== null) window.clearTimeout(typeaheadTimer.current) }, [])
  useEffect(() => { if (disabled && open) close() }, [close, disabled, open])

  useMenuDismissal({ open, menuRef: listRef, insideRefs: [triggerRef], onDismiss: close, escape: false, scrollAnchor: triggerRef })

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const list = listRef.current
    if (!open || !trigger || !list) return
    const anchor = trigger.getBoundingClientRect()
    const viewport = readHorizontalViewportBounds()
    const naturalWidth = Math.max(anchor.width, list.scrollWidth)
    const horizontal = clampAnchoredMenuHorizontally({ anchorLeft: anchor.left, anchorRight: anchor.right, menuWidth: naturalWidth, viewport, align: 'start' })
    const naturalHeight = Math.min(LIST_MAX_HEIGHT, list.scrollHeight)
    const vertical = placeAnchoredMenuVertically({ anchorTop: anchor.top, anchorBottom: anchor.bottom, menuHeight: naturalHeight, viewportHeight: window.innerHeight, shrinkToFit: true, gap: 4 })
    setPlacement({
      left: horizontal.left,
      top: vertical.top,
      minWidth: Math.min(anchor.width, horizontal.maxWidth),
      maxWidth: horizontal.maxWidth,
      maxHeight: Math.min(LIST_MAX_HEIGHT, vertical.maxHeight ?? LIST_MAX_HEIGHT),
    })
    // Measure once per opening; the list keeps its place while it is open.
  }, [open, triggerRef])

  // Keep the active option visible: centered when the list opens, nearest edge afterwards.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!open || !placement || !list || active < 0) return
    const option = list.querySelector<HTMLElement>(`[data-select-index="${active}"]`)
    if (!option) return
    if (scrollOnOpen.current) {
      scrollOnOpen.current = false
      list.scrollTop = Math.max(0, option.offsetTop - (list.clientHeight - option.offsetHeight) / 2)
      return
    }
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight
  }, [active, open, placement])

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const input: SelectKeyInput = { key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey }
    const result = reduceSelectKey({ open, active, selected: selectedIndex, typeahead: typeaheadRef.current }, input, options)
    if (result.handled) {
      event.preventDefault()
      event.stopPropagation()
    }
    typeaheadRef.current = result.typeahead
    if (typeaheadTimer.current !== null) window.clearTimeout(typeaheadTimer.current)
    if (result.typeahead) typeaheadTimer.current = window.setTimeout(() => { typeaheadRef.current = '' }, TYPEAHEAD_RESET_MS)
    if (!result.open) {
      if (open) {
        if (result.commit !== undefined) commit(result.commit)
        else close()
      }
      return
    }
    if (!open) show(result.active)
    else setActive(result.active)
  }

  const portalTarget = open ? menuPortalContainer(triggerRef.current) : null
  const activeId = open && active >= 0 ? optionId(active) : undefined

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        value={value}
        disabled={disabled}
        title={title}
        data-select-variant={variant}
        data-select-mode="list"
        className={triggerClass}
        onMouseDown={event => {
          if (event.button !== 0 || disabled) return
          // Like a native select: the press opens or closes the list and focuses the trigger.
          event.preventDefault()
          triggerRef.current?.focus({ preventScroll: true })
          if (open) close()
          else show(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : options.findIndex(option => !option.disabled))
        }}
        // A label click activates the trigger without a press: focus only, as a native select does.
        onClick={() => triggerRef.current?.focus({ preventScroll: true })}
        onKeyDown={handleKey}
        onBlur={() => { if (open) close() }}
        {...dataAttributes}
      >
        {content}
      </button>
      {open && portalTarget ? createPortal(
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          data-select-list
          tabIndex={-1}
          className={`fixed z-[1200] overflow-y-auto overscroll-contain py-1.5 ${MENU_SURFACE_CLASS}`}
          style={placement
            ? { left: placement.left, top: placement.top, minWidth: placement.minWidth, maxWidth: placement.maxWidth, maxHeight: placement.maxHeight }
            : { left: 0, top: 0, maxHeight: LIST_MAX_HEIGHT, visibility: 'hidden' }}
          // The list belongs to the Select: presses inside it keep focus on the
          // trigger and are not outside presses for an enclosing popover or dialog.
          onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
          onPointerDown={event => event.stopPropagation()}
          onTouchStart={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
        >
          {options.map((option, index) => {
            const selected = index === selectedIndex
            return (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={selected}
                aria-disabled={option.disabled || undefined}
                data-select-option={option.value}
                data-select-index={index}
                data-active={index === active ? 'true' : undefined}
                title={option.label}
                onMouseMove={() => { if (!option.disabled && index !== active) setActive(index) }}
                onClick={() => { if (!option.disabled) commit(index) }}
                className={`flex min-w-0 cursor-default select-none items-center gap-2.5 px-3 py-2 text-sm ${option.disabled ? 'opacity-50' : index === active ? 'bg-fw-hover text-fw-text-strong dark:bg-fw-hover/70' : 'text-fw-text-strong'}`}
              >
                <span className={`min-w-0 flex-1 truncate ${selected ? 'font-medium text-fw-accent' : ''}`}>{option.label}</span>
                <SelectionMark checked={selected} kind="radio" />
              </div>
            )
          })}
        </div>,
        portalTarget,
      ) : null}
    </>
  )
}
