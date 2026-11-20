interface RegistryShape {
  nouns?: ReadonlyArray<{ name: string }>
  commands?: ReadonlyArray<{ path: string, ingress?: readonly string[] }>
  shortcuts?: ReadonlyArray<{ name: string }>
  userHeads?: readonly string[]
}

/**
 * User command heads from the ctl registry: `/help`, the shortcuts and every noun with a user
 * command. The production bundle carries them precomputed (build/ctlRegistry.ts).
 */
export function userCommandHeads(registry: RegistryShape): string[] {
  if (registry.userHeads) return [...registry.userHeads]
  const nouns = new Set((registry.commands || []).filter(command => command.ingress?.includes('user')).map(command => command.path.split(' ')[0]))
  return [
    '/help',
    ...(registry.shortcuts || []).map(shortcut => `/${shortcut.name}`),
    ...(registry.nouns || []).filter(noun => nouns.has(noun.name)).map(noun => `/${noun.name}`),
  ]
}
