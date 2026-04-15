import * as sharedToolResponseFormatting from '../../../shared/toolResponseFormatting'

const { formatToolResponsePayload } = sharedToolResponseFormatting as {
  formatToolResponsePayload: (response: unknown) => string
}

export interface ToolResponseLike {
  name: string
  response: any
}

export const formatToolResponseText = (resp: ToolResponseLike): string => formatToolResponsePayload(resp.response)

export const getPrimaryToolResponseText = (resp: ToolResponseLike): string | null => {
  const formatted = formatToolResponsePayload(resp.response)
  return formatted ? formatted : null
}