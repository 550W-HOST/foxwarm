import {
  APP_CONFIG_SCHEMA,
  KNOWN_PROVIDER_TYPES,
  MODELS_CONFIG_SCHEMA,
} from '../../shared/src/configSchemas'

export { APP_CONFIG_SCHEMA, KNOWN_PROVIDER_TYPES, MODELS_CONFIG_SCHEMA }

export const MODELS_YAML_MODEL_URI = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
export const APP_CONFIG_YAML_MODEL_URI = 'inmemory://foxwarm/setup/foxwarm-config.yaml'

export const YAML_CONFIG_SCHEMAS = [
  { uri: MODELS_CONFIG_SCHEMA.$id, fileMatch: ['**/foxwarm-models.yaml'], schema: MODELS_CONFIG_SCHEMA },
  { uri: APP_CONFIG_SCHEMA.$id, fileMatch: ['**/foxwarm-config.yaml'], schema: APP_CONFIG_SCHEMA },
]
