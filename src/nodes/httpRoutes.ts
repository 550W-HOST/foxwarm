import { spawn } from 'child_process';
import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { logger } from '../common';
import { BASE_DIR } from '../config';
import { HttpServer } from '../httpServer';

const NODE_TEMPLATE_DIR = path.join(BASE_DIR, 'templates', 'node');
const NODE_RUN_SH_PATH = path.join(NODE_TEMPLATE_DIR, 'run.sh');
const NODE_RUN_DOCKER_SH_PATH = path.join(NODE_TEMPLATE_DIR, 'run-docker.sh');
const NODE_RUN_INTERACTIVE_SH_PATH = path.join(NODE_TEMPLATE_DIR, 'run-interactive.sh');
const NODE_RUN_PS1_PATH = path.join(NODE_TEMPLATE_DIR, 'run.ps1');
const NODE_DOCKER_COMPOSE_PATH = path.join(NODE_TEMPLATE_DIR, 'docker-compose.yaml');
export const NODE_TEMPLATE_BASE_URL_PLACEHOLDER = '__FOXWARM_DEFAULT_BASE_URL__';

export const NODE_SOURCE_FILES = [
  'packages/shared',
  'packages/cli-node',
  'packages/cli-node-runtime',
  'scripts/start-sandbox-node.sh',
];

const NODE_SOURCE_TAR_EXCLUDES = [
  'packages/shared/node_modules',
  'packages/cli-node/node_modules',
  'packages/cli-node-runtime/node_modules',
];

async function ensureNodeTemplateFiles(): Promise<void> {
  for (const filePath of [NODE_RUN_SH_PATH, NODE_RUN_DOCKER_SH_PATH, NODE_RUN_INTERACTIVE_SH_PATH, NODE_RUN_PS1_PATH, NODE_DOCKER_COMPOSE_PATH]) {
    if (!await fs.pathExists(filePath)) {
      throw new Error(`Missing node template file: ${path.relative(BASE_DIR, filePath)}`);
    }
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const candidate = raw.split(',')[0]?.trim();
  return candidate || undefined;
}

function sanitizeBootstrapProto(value: string | undefined): 'http' | 'https' | undefined {
  if (!value) return undefined;
  const candidate = value.trim().toLowerCase();
  if (candidate === 'http' || candidate === 'https') return candidate;
  return undefined;
}

function sanitizeBootstrapHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.trim();
  if (!candidate) return undefined;
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(candidate)) return undefined;
  return candidate;
}

export function inferNodeBootstrapBaseUrl(req: Pick<express.Request, 'headers' | 'protocol'>): string | undefined {
  const host = sanitizeBootstrapHost(
    firstHeaderValue(req.headers['x-forwarded-host']) || firstHeaderValue(req.headers.host),
  );
  if (!host) return undefined;

  const proto =
    sanitizeBootstrapProto(firstHeaderValue(req.headers['x-forwarded-proto'])) ||
    sanitizeBootstrapProto(req.protocol) ||
    'http';

  return `${proto}://${host}`;
}

export function renderNodeTemplateText(templateText: string, req: Pick<express.Request, 'headers' | 'protocol'>): string {
  const defaultBaseUrl = inferNodeBootstrapBaseUrl(req) || '';
  return templateText.split(NODE_TEMPLATE_BASE_URL_PLACEHOLDER).join(defaultBaseUrl);
}

function addTextRoute(httpServer: HttpServer, routePath: string, filePath: string, contentType: string): void {
  httpServer.addRoute({
    path: routePath,
    method: 'GET',
    noAuth: true,
    handler: async (req: express.Request, res: express.Response) => {
      await ensureNodeTemplateFiles();
      res.setHeader('Content-Type', contentType);
      const templateText = await fs.readFile(filePath, 'utf8');
      res.send(renderNodeTemplateText(templateText, req));
    },
  });
}

export function registerNodeHttpRoutes(httpServer: HttpServer): void {
  addTextRoute(httpServer, '/node/run.sh', NODE_RUN_SH_PATH, 'text/x-shellscript; charset=utf-8');
  addTextRoute(httpServer, '/node/run-docker.sh', NODE_RUN_DOCKER_SH_PATH, 'text/x-shellscript; charset=utf-8');
  addTextRoute(httpServer, '/node/run-cli-node.sh', NODE_RUN_INTERACTIVE_SH_PATH, 'text/x-shellscript; charset=utf-8');
  addTextRoute(httpServer, '/node/run-interactive.sh', NODE_RUN_INTERACTIVE_SH_PATH, 'text/x-shellscript; charset=utf-8');
  addTextRoute(httpServer, '/node/run.ps1', NODE_RUN_PS1_PATH, 'text/plain; charset=utf-8');
  addTextRoute(httpServer, '/node/docker-compose.yaml', NODE_DOCKER_COMPOSE_PATH, 'text/yaml; charset=utf-8');

  httpServer.addRoute({
    path: '/node/source.tar.gz',
    method: 'GET',
    noAuth: true,
    handler: async (_req: express.Request, res: express.Response) => {
      await ensureNodeTemplateFiles();

      for (const relPath of NODE_SOURCE_FILES) {
        if (!await fs.pathExists(path.join(BASE_DIR, relPath))) {
          throw new Error(`Missing node source artifact: ${relPath}`);
        }
      }

      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', 'attachment; filename="foxwarm-node-source.tar.gz"');

      const tar = spawn('tar', ['-czf', '-', ...NODE_SOURCE_TAR_EXCLUDES.map(relPath => `--exclude=${relPath}`), ...NODE_SOURCE_FILES], {
        cwd: BASE_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      tar.stderr.on('data', chunk => {
        logger.warn({ chunk: chunk.toString() }, 'node source tar stderr');
      });

      tar.on('error', err => {
        logger.error({ err }, 'Failed to spawn tar for node source route');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to generate node source archive' });
        } else {
          res.end();
        }
      });

      tar.on('close', code => {
        if (code !== 0) {
          logger.error({ code }, 'tar exited with non-zero code for node source route');
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to generate node source archive' });
          }
        }
      });

      tar.stdout.pipe(res);
    },
  });
}