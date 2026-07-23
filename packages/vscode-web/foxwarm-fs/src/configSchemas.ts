import * as vscode from 'vscode';
import { APP_CONFIG_SCHEMA, MODELS_CONFIG_SCHEMA } from '../../../shared/src/configSchemas';
import { isExactWorkspaceRoot, type FoxwarmConfigFile, type FoxwarmConfigFileKind } from './workspaceRoots';

export const FOXWARM_YAML_CONTRIBUTOR = 'foxwarm-config';
export const FOXWARM_MODELS_SCHEMA_URI = 'foxwarm-config://schemas/models';
export const FOXWARM_APP_SCHEMA_URI = 'foxwarm-config://schemas/app';

export type FoxwarmConfigFiles = Record<FoxwarmConfigFileKind, FoxwarmConfigFile>;

type YamlExtensionApi = {
  registerContributor(
    schema: string,
    requestSchema: (resource: string) => string,
    requestSchemaContent: (uri: string) => Promise<string> | string,
    label?: string,
  ): boolean;
};

export function getFoxwarmConfigSchemaUri(resource: string, files: FoxwarmConfigFiles): string | undefined {
  try {
    const uri = vscode.Uri.parse(resource);
    if (isExactWorkspaceRoot(uri, files.models)) return FOXWARM_MODELS_SCHEMA_URI;
    if (isExactWorkspaceRoot(uri, files.app)) return FOXWARM_APP_SCHEMA_URI;
    return undefined;
  } catch {
    return undefined;
  }
}

export function getFoxwarmConfigSchemaContent(uri: string): string {
  if (uri === FOXWARM_MODELS_SCHEMA_URI) return JSON.stringify(MODELS_CONFIG_SCHEMA);
  if (uri === FOXWARM_APP_SCHEMA_URI) return JSON.stringify(APP_CONFIG_SCHEMA);
  throw new Error(`Unknown Foxwarm config schema URI: ${uri}`);
}

export async function registerFoxwarmConfigSchemas(
  files: FoxwarmConfigFiles,
  extensions: Pick<typeof vscode.extensions, 'getExtension'> = vscode.extensions,
): Promise<boolean> {
  const yamlExtension = extensions?.getExtension<YamlExtensionApi>('redhat.vscode-yaml');
  if (!yamlExtension) {
    console.info('Foxwarm config schema support is unavailable because redhat.vscode-yaml is not installed.');
    return false;
  }
  const api = await yamlExtension.activate();
  if (!api || typeof api.registerContributor !== 'function') {
    console.info('Foxwarm config schema support is unavailable because redhat.vscode-yaml did not expose its contributor API.');
    return false;
  }
  const registered = api.registerContributor(
    FOXWARM_YAML_CONTRIBUTOR,
    ((resource: string) => getFoxwarmConfigSchemaUri(resource, files)) as (resource: string) => string,
    getFoxwarmConfigSchemaContent,
  );
  if (!registered) console.info('Foxwarm config schema contributor was already registered.');
  return registered;
}
