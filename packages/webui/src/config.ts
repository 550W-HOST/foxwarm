// API base path - dynamically detect based on current location
// Extract base path from pathname and append /api
const getBasePath = () => {
  let pathname = window.location.pathname
  // Remove trailing slash if exists
  if (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1)
  }
  // If at root, return /api
  if (!pathname || pathname === '') {
    return '/api'
  }
  // Otherwise append /api to current path
  return pathname + '/api'
}

export const API_BASE_PATH = getBasePath()

export const makeApiUrl = (relativePath: string) => new URL(`${API_BASE_PATH}${relativePath}`, window.location.origin)

export const makeWebSocketUrl = (relativePath: string) => {
  const url = makeApiUrl(relativePath)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}
