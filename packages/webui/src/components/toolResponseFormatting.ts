import { formatObject } from './objectFormatting'

export interface ToolResponseLike {
  name: string
  response: any
}

const formatToolValue = (value: unknown): string => (
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)
)

export const formatToolResponseText = (resp: ToolResponseLike): string => {
  if (resp.response?.error !== undefined && resp.response?.error !== null) {
    return formatToolValue(resp.response.error)
  }
  if (resp.response?.output !== undefined && resp.response?.output !== null) {
    return formatToolValue(resp.response.output)
  }
  if (resp.response?.content !== undefined && resp.response?.content !== null) {
    return formatToolValue(resp.response.content)
  }
  return formatObject(resp.response)
}

export const getPrimaryToolResponseText = (resp: ToolResponseLike): string | null => {
  if (resp.response?.error !== undefined && resp.response?.error !== null) {
    return formatToolValue(resp.response.error)
  }
  if (resp.response?.output !== undefined && resp.response?.output !== null) {
    return formatToolValue(resp.response.output)
  }
  if (resp.response?.content !== undefined && resp.response?.content !== null) {
    return formatToolValue(resp.response.content)
  }

  const formatted = formatObject(resp.response)
  return formatted ? formatted : null
}