import { spawn } from 'child_process';
import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import { logger } from '../common';
import { BASE_DIR } from '../config';
import { HttpServer } from '../httpServer';

const NODE_TEMPLATE_DIR = path.join(BASE_DIR, 'templates', 'node');
const NODE_RUN_SH_PATH = path.join(NODE_TEMPLATE_DIR, 'run.sh');
const NODE_DOCKER_COMPOSE_PATH = path.join(NODE_TEMPLATE_DIR, 'docker-compose.yaml');
const NODE_SOURCE_FILES = [
  'Dockerfile.node',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'src',
  'templates',
  'scripts/start-sandbox-node.sh',
];

async function ensureNodeTemplateFiles(): Promise<void> {
  for (const filePath of [NODE_RUN_SH_PATH, NODE_DOCKER_COMPOSE_PATH]) {
    if (!await fs.pathExists(filePath)) {
      throw new Error(`Missing node template file: ${path.relative(BASE_DIR, filePath)}`);
    }
  }
}

function addTextRoute(httpServer: HttpServer, routePath: string, filePath: string, contentType: string): void {
  httpServer.addRoute({
    path: routePath,
    method: 'GET',
    noAuth: true,
    handler: async (_req: express.Request, res: express.Response) => {
      await ensureNodeTemplateFiles();
      res.setHeader('Content-Type', contentType);
      res.send(await fs.readFile(filePath, 'utf8'));
    },
  });
}

export function registerNodeHttpRoutes(httpServer: HttpServer): void {
  addTextRoute(httpServer, '/node/run.sh', NODE_RUN_SH_PATH, 'text/x-shellscript; charset=utf-8');
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

      const tar = spawn('tar', ['-czf', '-', ...NODE_SOURCE_FILES], {
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