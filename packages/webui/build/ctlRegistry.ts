import type { Plugin } from 'vite'

/**
 * The WebUI reads the ctl registry only to display which tool a command runs. Bundle the
 * command paths, parameters and targets, without help text.
 */
export function ctlRegistryPlugin(): Plugin {
  return {
    name: 'foxwarm-ctl-registry',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/Tools/Ctl/CtlCommands.json')) return null
      return { code: JSON.stringify(slimCtlRegistry(JSON.parse(code))), map: null }
    },
  }
}

const forModel = (item: { ingress?: string[] }) => !item.ingress || item.ingress.includes('model')

export function slimCtlRegistry(registry: { commands: Array<Record<string, any>> }) {
  return {
    // Only the model's commands, parameters and aliases: the timeline shows model calls.
    commands: registry.commands.filter(forModel).map(command => {
      const aliases = (command.aliases || []).filter((alias: unknown) => typeof alias === 'string')
      return {
        path: command.path,
        ...(aliases.length ? { aliases } : {}),
        target: command.target,
        params: (command.params || []).filter(forModel).map((parameter: Record<string, any>) => {
          const { help: _help, ingress: _ingress, ...shape } = parameter
          return shape
        }),
      }
    }),
  }
}
