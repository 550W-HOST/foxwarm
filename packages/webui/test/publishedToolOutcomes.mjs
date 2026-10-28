// Only the four scripted qualification calls may contribute tool diagnostics.
const calls = [
  ['packaged-toolscript', 'run_script'],
  ['packaged-browser-open', 'browse_open'],
  ['packaged-browser-image', 'browse_get'],
  ['packaged-react-artifact', 'artifact'],
]

const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined

export function publishedToolOutcomes(messages = []) {
  const responses = messages.flatMap(row => row.parts || []).map(part => part.functionResponse).filter(Boolean)
  return calls.flatMap(([id, name]) => {
    const response = responses.findLast(row => row.tool_use_id === id && row.name === name)
    if (!response) return []
    const result = response.response, failure = result?.error
    return [{
      id, name, status: text(result?.status, 80) || (failure ? 'error' : 'completed'),
      ...(failure ? { error: { type: text(failure.type, 80), message: text(typeof failure === 'string' ? failure : failure.message, 1500) } } : {}),
    }]
  })
}
