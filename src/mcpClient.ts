import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import { MCP_CONFIG_PATH, STATE_DIR } from './config';

export type McpServerConfig = {
  url: string;
  token?: string;
  description?: string;
  enable?: boolean;
};

export type McpConfig = {
  servers: Record<string, McpServerConfig>;
};

async function loadConfig(): Promise<McpConfig> {
  try {
    const exists = await fs.pathExists(MCP_CONFIG_PATH);
    if (!exists) return { servers: {} };
    const raw = await fs.readFile(MCP_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { servers: parsed.servers || {} };
  } catch (e) {
    throw new Error(`Failed to load MCP config: ${e}`);
  }
}

async function saveConfig(config: McpConfig) {
  await fs.ensureDir(STATE_DIR);
  await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function getServerConfig(name?: string): Promise<{ name: string; config: McpServerConfig }> {
  const cfg = await loadConfig();
  const servers = cfg.servers || {};
  const fallbackName = name || 'default';
  const serverName = servers[fallbackName] ? fallbackName : Object.keys(servers)[0];
  if (!serverName) {
    throw new Error('No MCP servers configured. Use mcp_config to add one.');
  }
  const server = servers[serverName];
  if (server.enable === false) {
    throw new Error(`MCP server \"${serverName}\" is disabled.`);
  }
  return { name: serverName, config: server };
}

async function rpcCall(url: string, token: string | undefined, method: string, params?: any) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params
  };

  const resp = await axios.post(url, body, { headers });
  if (resp.data?.error) {
    throw new Error(`MCP error: ${resp.data.error.message || JSON.stringify(resp.data.error)}`);
  }
  return resp.data?.result;
}

export async function listTools(serverName?: string) {
  const { config } = await getServerConfig(serverName);
  return rpcCall(config.url, config.token, 'tools/list');
}

export async function callTool(serverName: string | undefined, tool: string, args?: Record<string, any>) {
  const { config } = await getServerConfig(serverName);
  return rpcCall(config.url, config.token, 'tools/call', { name: tool, arguments: args || {} });
}

export async function upsertServer(name: string, server: McpServerConfig) {
  const cfg = await loadConfig();
  cfg.servers = cfg.servers || {};
  cfg.servers[name] = { ...cfg.servers[name], ...server };
  await saveConfig(cfg);
}

export async function setServerEnabled(name: string, enable: boolean) {
  const cfg = await loadConfig();
  cfg.servers = cfg.servers || {};
  if (!cfg.servers[name]) {
    throw new Error(`MCP server \"${name}\" not found.`);
  }
  cfg.servers[name].enable = enable;
  await saveConfig(cfg);
}

export async function getServers() {
  const cfg = await loadConfig();
  return cfg.servers || {};
}
