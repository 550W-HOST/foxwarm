import registry from '../../../dotnet/Foxwarm/Tools/Ctl/CtlCommands.json'
import { userCommandHeads } from './userCommandHeads'

const commandNames = new Set(userCommandHeads(registry))

// JavaScript whitespace is the Source grammar used by MessageRouter.CommandSpace.
// Keep the complete, case-sensitive command head: unknown slash text is ordinary input.
export function isKnownCommand(text: string): boolean {
  const match = /^\s*(\/[a-zA-Z_\-.]+)(?:\s+([\s\S]*))?$/.exec(text)
  return !!match && commandNames.has(match[1])
}
