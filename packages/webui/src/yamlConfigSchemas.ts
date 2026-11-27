import {
  AGENT_RULES_SCHEMA,
  APP_CONFIG_SCHEMA,
  KNOWN_PROVIDER_TYPES,
  MODELS_CONFIG_SCHEMA,
  TOOL_AUTHORIZATION_POLICY_SCHEMA,
} from '../../shared/src/configSchemas'

export { AGENT_RULES_SCHEMA, APP_CONFIG_SCHEMA, KNOWN_PROVIDER_TYPES, MODELS_CONFIG_SCHEMA, TOOL_AUTHORIZATION_POLICY_SCHEMA }

export const MODELS_YAML_MODEL_URI = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
export const APP_CONFIG_YAML_MODEL_URI = 'inmemory://foxwarm/setup/foxwarm-config.yaml'
export const TOOL_AUTHORIZATION_YAML_MODEL_URI = 'inmemory://foxwarm/setup/foxwarm-tool-authorization.yaml'

/** One editor model per Agent, so switching Agents never shares undo history or markers. */
export const agentRulesYamlModelUri = (agentId: string) => `inmemory://foxwarm/system/agents/${encodeURIComponent(agentId)}/foxwarm-agent-rules.yaml`

export const YAML_CONFIG_SCHEMAS = [
  { uri: MODELS_CONFIG_SCHEMA.$id, fileMatch: ['**/foxwarm-models.yaml'], schema: MODELS_CONFIG_SCHEMA },
  { uri: APP_CONFIG_SCHEMA.$id, fileMatch: ['**/foxwarm-config.yaml'], schema: APP_CONFIG_SCHEMA },
  { uri: TOOL_AUTHORIZATION_POLICY_SCHEMA.$id, fileMatch: ['**/foxwarm-tool-authorization.yaml'], schema: TOOL_AUTHORIZATION_POLICY_SCHEMA },
  { uri: AGENT_RULES_SCHEMA.$id, fileMatch: ['**/foxwarm-agent-rules.yaml'], schema: AGENT_RULES_SCHEMA },
]
