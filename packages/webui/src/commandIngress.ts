import catalog from '../../../dotnet/Foxwarm/Channels/CommandCatalog.json'

const commandNames = new Set(catalog.map(command => command.name))

// JavaScript whitespace is the Source grammar used by MessageRouter.CommandSpace.
// Keep the complete, case-sensitive catalog head: unknown slash text is ordinary input.
export function isKnownCommand(text: string): boolean {
  const match = /^\s*(\/[a-zA-Z_\-.]+)(?:\s+([\s\S]*))?$/.exec(text)
  return !!match && commandNames.has(match[1])
}
