export const VSCODE_WEB_TAB_ID = 'vscode-web';

export function getVscodeWebPath(apiBasePath: string): string {
  const normalizedApiBase = apiBasePath.replace(/\/+$/, '');
  const deploymentBase = normalizedApiBase.endsWith('/api')
    ? normalizedApiBase.slice(0, -'/api'.length)
    : normalizedApiBase;
  return `${deploymentBase}/vscode-web/` || '/vscode-web/';
}

export function makeVscodeWebUrl(apiBasePath: string, origin: string): URL {
  return new URL(getVscodeWebPath(apiBasePath), origin);
}
