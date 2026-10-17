import type express from 'express';
import fs from 'fs-extra';
import path from 'node:path';
import type { HttpServer } from '../httpServer';
import { logger } from '../common';

/** Retains the existing download token gate; receipts never grant filesystem access. */
export function registerWebUiFileDownloads(server: Pick<HttpServer, 'addRoute'>, checkToken: (req: express.Request) => boolean) {
  server.addRoute({ path: '/download', method: 'GET', handler: async (req, res) => {
    if (!checkToken(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const filePath = req.query.path;
    if (typeof filePath !== 'string' || !filePath) { res.status(400).json({ error: 'Missing path parameter' }); return; }
    if (!path.isAbsolute(filePath)) { res.status(400).json({ error: 'Path must be absolute' }); return; }
    try {
      const stat = await fs.stat(filePath).catch((): null => null);
      if (!stat?.isFile()) { res.status(404).json({ error: 'File not found' }); return; }
      const fileName = typeof req.query.filename === 'string'
        ? req.query.filename.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 255) || path.basename(filePath)
        : path.basename(filePath);
      const rasterMime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[path.extname(filePath).toLowerCase()];
      const preview = req.query.preview === '1' && !!rasterMime;
      res.attachment(fileName);
      res.setHeader('Content-Type', preview ? rasterMime : 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'private, no-cache');
      if (preview) res.setHeader('Content-Disposition', String(res.getHeader('Content-Disposition')).replace(/^attachment/, 'inline'));
      if (req.method === 'HEAD') { res.end(); return; }
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        res.on('close', () => { if (!res.writableEnded) stream.destroy(); resolve(); });
        res.on('finish', resolve);
        stream.pipe(res);
      });
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to send file download');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to send download' });
      else res.destroy();
    }
  } });
}
