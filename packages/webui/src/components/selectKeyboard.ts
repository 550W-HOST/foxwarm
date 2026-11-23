/**
 * Keyboard model of the shared Select's desktop list (select-only combobox).
 * Focus stays on the trigger; this decides which option is active, when the
 * list opens or closes, and which option a key commits.
 */

export type SelectKeyOption = {
  label: string
  disabled?: boolean
}

export type SelectKeyState = {
  open: boolean
  /** Highlighted option while open, or -1. */
  active: number
  /** Index of the current value, or -1. */
  selected: number
  /** Characters typed within the type-ahead window. */
  typeahead: string
}

export type SelectKeyInput = {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

export type SelectKeyResult = {
  open: boolean
  active: number
  typeahead: string
  /** Option to choose; the list closes. */
  commit?: number
  /** The key belonged to the Select: prevent its default action and stop propagation. */
  handled: boolean
}

export const SELECT_PAGE_STEP = 10

const enabled = (options: readonly SelectKeyOption[], index: number) => index >= 0 && index < options.length && !options[index].disabled

export function firstEnabledIndex(options: readonly SelectKeyOption[]) {
  return options.findIndex(option => !option.disabled)
}

export function lastEnabledIndex(options: readonly SelectKeyOption[]) {
  for (let index = options.length - 1; index >= 0; index -= 1) if (!options[index].disabled) return index
  return -1
}

/**
 * Moves `distance` enabled-or-not positions from `from` without wrapping, then
 * settles on the nearest enabled option in the travel direction, falling back
 * to the nearest one behind it. Returns `from` when nothing else is enabled.
 */
export function stepEnabledIndex(options: readonly SelectKeyOption[], from: number, distance: number) {
  if (options.length === 0) return -1
  if (from < 0) return distance > 0 ? firstEnabledIndex(options) : lastEnabledIndex(options)
  const direction = distance > 0 ? 1 : -1
  const target = Math.min(options.length - 1, Math.max(0, from + distance))
  for (let index = target; index >= 0 && index < options.length; index += direction) if (enabled(options, index)) return index
  for (let index = target - direction; index !== from && index >= 0 && index < options.length; index -= direction) if (enabled(options, index)) return index
  return enabled(options, from) ? from : -1
}

/**
 * Type-ahead: the first enabled option whose label starts with `query`,
 * searching from `from` and wrapping. Repeating one character cycles through
 * the options that start with it.
 */
export function typeaheadIndex(options: readonly SelectKeyOption[], query: string, from: number) {
  const normalized = query.toLocaleLowerCase()
  if (!normalized || options.length === 0) return -1
  const repeated = [...normalized].every(character => character === normalized[0])
  const search = repeated ? normalized[0] : normalized
  const start = repeated ? from + 1 : Math.max(0, from)
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (start + offset + options.length) % options.length
    if (enabled(options, index) && options[index].label.trim().toLocaleLowerCase().startsWith(search)) return index
  }
  return -1
}

const printable = (input: SelectKeyInput) => input.key.length === 1 && !input.ctrlKey && !input.metaKey && !input.altKey

export function reduceSelectKey(state: SelectKeyState, input: SelectKeyInput, options: readonly SelectKeyOption[]): SelectKeyResult {
  const unchanged: SelectKeyResult = { open: state.open, active: state.active, typeahead: state.typeahead, handled: false }
  const opened = (active: number): SelectKeyResult => ({ open: true, active, typeahead: '', handled: true })
  const start = enabled(options, state.selected) ? state.selected : firstEnabledIndex(options)
  const typeahead = (): SelectKeyResult => {
    const query = state.typeahead + input.key
    const match = typeaheadIndex(options, query, state.open ? state.active : state.selected)
    return { open: true, active: match >= 0 ? match : state.open ? state.active : start, typeahead: query, handled: true }
  }

  if (!state.open) {
    switch (input.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        return opened(start)
      case 'Home':
        return opened(firstEnabledIndex(options))
      case 'End':
        return opened(lastEnabledIndex(options))
      default:
        return printable(input) ? typeahead() : unchanged
    }
  }

  switch (input.key) {
    case 'ArrowDown':
      return { ...unchanged, active: stepEnabledIndex(options, state.active, 1), typeahead: '', handled: true }
    case 'ArrowUp':
      if (input.altKey) return { open: false, active: -1, typeahead: '', commit: enabled(options, state.active) ? state.active : undefined, handled: true }
      return { ...unchanged, active: stepEnabledIndex(options, state.active, -1), typeahead: '', handled: true }
    case 'PageDown':
      return { ...unchanged, active: stepEnabledIndex(options, state.active, SELECT_PAGE_STEP), typeahead: '', handled: true }
    case 'PageUp':
      return { ...unchanged, active: stepEnabledIndex(options, state.active, -SELECT_PAGE_STEP), typeahead: '', handled: true }
    case 'Home':
      return { ...unchanged, active: firstEnabledIndex(options), typeahead: '', handled: true }
    case 'End':
      return { ...unchanged, active: lastEnabledIndex(options), typeahead: '', handled: true }
    case ' ':
      if (state.typeahead) return typeahead()
      return { open: false, active: -1, typeahead: '', commit: enabled(options, state.active) ? state.active : undefined, handled: true }
    case 'Enter':
      return { open: false, active: -1, typeahead: '', commit: enabled(options, state.active) ? state.active : undefined, handled: true }
    case 'Escape':
      return { open: false, active: -1, typeahead: '', handled: true }
    case 'Tab':
      // Closes without a change; focus moves on as usual.
      return { open: false, active: -1, typeahead: '', handled: false }
    default:
      return printable(input) ? typeahead() : unchanged
  }
}
