import { createContext } from 'react'
import type { ToolScriptSubCall } from './chatShared'

export const ToolScriptProgressContext = createContext<Record<string, ToolScriptSubCall[]>>({})
