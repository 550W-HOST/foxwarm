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

export function slimCtlRegistry(registry: { commands: Array<Record<string, any>> }) {
  return {
    commands: registry.commands.map(command => ({
      path: command.path,
      ...(command.aliases ? { aliases: command.aliases } : {}),
      target: command.target,
      params: (command.params || []).map((parameter: Record<string, any>) => {
        const { help: _help, ...shape } = parameter
        return shape
      }),
    })),
  }
}
