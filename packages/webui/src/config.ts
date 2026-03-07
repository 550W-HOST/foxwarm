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
