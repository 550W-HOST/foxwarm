export const formatObject = (obj: any): string => {
  if (!obj || typeof obj !== 'object') return String(obj)
  const keys = Object.keys(obj)
  if (keys.length === 1) {
    const value = obj[keys[0]]
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return keys.map(key => {
    const value = obj[key]
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : value
    return `${key}: ${valueStr}`
  }).join('\n')
}