export type FilterableModelOption = {
  key: string
  label: string
  isDefault?: boolean
}

export function formatModelLabel(option: FilterableModelOption, defaultModelKey?: string) {
  return `${option.label}${option.key === defaultModelKey || option.isDefault ? ' · default' : ''}`
}

export function filterModelOptions<T extends FilterableModelOption>(options: T[], query: string, defaultModelKey?: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return options
  return options.filter((option) => (
    formatModelLabel(option, defaultModelKey).toLowerCase().includes(normalizedQuery)
    || option.key.toLowerCase().includes(normalizedQuery)
  ))
}