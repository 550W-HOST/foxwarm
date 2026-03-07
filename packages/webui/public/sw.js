// Simple service worker for PWA
// Use timestamp to force cache invalidation on updates
const CACHE_NAME = 'foxwarm-webui-v' + Date.now()
const CACHE_VERSION = '2026-02-22-13:00'

self.addEventListener('install', (event) => {
  console.log('[SW] Installing new version:', CACHE_VERSION)
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating new version:', CACHE_VERSION)
  event.waitUntil(
    // Delete all old caches
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName)
            return caches.delete(cacheName)
          }
        })
      )
    }).then(() => clients.claim())
  )
})

// Network-first strategy for everything to ensure fresh content
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return
  }
  
  // Network-first for all requests
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses
        if (response.status === 200) {
          const responseToCache = response.clone()
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache)
          })
        }
        return response
      })
      .catch(() => {
        // Fallback to cache if network fails
        return caches.match(event.request).then((response) => {
          return response || new Response('Offline', { status: 503 })
        })
      })
  )
})
