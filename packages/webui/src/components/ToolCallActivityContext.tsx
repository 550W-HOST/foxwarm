import { createContext } from 'react'

// Undefined preserves compatibility with backends predating per-call activity.
export const ToolCallActivityContext = createContext<ReadonlySet<string> | undefined>(undefined)
