import { useState } from 'react'
import { RefreshCw } from 'lucide-react'

async function hardReloadApp() {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)))
  }

  if ('caches' in window) {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName).catch(() => false)))
  }

  window.location.reload()
}

export default function ReloadAppButton({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [reloading, setReloading] = useState(false)

  return (
    <button
      type="button"
      onClick={() => {
        if (reloading) return
        setReloading(true)
        void hardReloadApp()
      }}
      className={className || 'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 disabled:cursor-wait disabled:opacity-70 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white'}
      title="Reload app and clear service-worker/cache state first"
      aria-label="Reload app"
      disabled={reloading}
    >
      {children || <RefreshCw className={`h-4 w-4 ${reloading ? 'animate-spin' : ''}`} />}
    </button>
  )
}
