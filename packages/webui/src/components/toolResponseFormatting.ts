import { formatObject } from './objectFormatting'

export interface ToolResponseLike {
  name: string
  response: any
}

export const formatToolResponseText = (resp: ToolResponseLike): string => formatObject(resp.response)

export const getPrimaryToolResponseText = (resp: ToolResponseLike): string | null => {
  const formatted = formatObject(resp.response)
  return formatted ? formatted : null
}