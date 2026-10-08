import { LoaderCircle } from 'lucide-react'

export default function RuntimeBusySpinner({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={`runtime-busy-spinner shrink-0 ${className}`} />
}
