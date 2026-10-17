import type express from 'express';
import fs from 'fs-extra';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HttpServer } from '../httpServer';
import { logger } from '../common';
import { getSafeRasterMimeType, resolveImageBlobPath } from '../imageBlobs';

const DOWNLOAD_LIFETIME_SECONDS = 15 * 60;

type DownloadResource = { path: string; filename?: string; preview?: string };

function resourceFromInput(input: Record<string, unknown>): DownloadResource {
  return {
    path: typeof input.path === 'string' ? input.path : '',
    ...(typeof input.filename === 'string' ? { filename: input.filename } : {}),
    ...(typeof input.preview === 'string' ? { preview: input.preview } : {}),
  };
}

function pathError(resource: DownloadResource): string | null {
  if (!resource.path) return 'Missing path parameter';
  if (!path.isAbsolute(resource.path)) return 'Path must be absolute';
  return null;
}

type DownloadTarget = { kind: 'path'; path: string } | { kind: 'blob'; blobId: string; sessionId?: string };
type DownloadOptions = Pick<DownloadResource, 'filename' | 'preview'>;
type DownloadServer = Pick<HttpServer, 'addRoute' | 'checkToken' | 'getAuthContext'>;

function createDownloadSignatures(instanceToken: string, now: () => number) {
  // Domain separation keeps this deterministic across restarts without reusing
  // the instance token itself as a download MAC key or exposing it in URLs.
  const key = createHmac('sha256', instanceToken).update('foxwarm/webui-download-key/v1').digest();
  const mac = (target: DownloadTarget, options: DownloadOptions, expires: string) => createHmac('sha256', key)
    .update(JSON.stringify(['download-v1', target.kind,
      target.kind === 'path' ? target.path : target.blobId,
      target.kind === 'blob' ? target.sessionId ?? null : null,
      options.filename ?? null, options.preview ?? null, expires]))
    .digest();
  return {
    issue(target: DownloadTarget, options: DownloadOptions) {
      const expires = String(Math.floor(now() / 1000) + DOWNLOAD_LIFETIME_SECONDS);
      const params = new URLSearchParams(options);
      params.set('expires', expires);
      params.set('signature', mac(target, options, expires).toString('hex'));
      return { params, expiresAt: Number(expires) };
    },
    verify(target: DownloadTarget, query: Record<string, unknown>) {
      const { expires, signature } = query;
      if (typeof expires !== 'string' || !/^[1-9]\d{0,12}$/.test(expires)
        || Number(expires) <= Math.floor(now() / 1000)
        || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
      return timingSafeEqual(mac(target, resourceFromInput(query), expires), Buffer.from(signature, 'hex'));
    },
  };
}

type DownloadSignatures = ReturnType<typeof createDownloadSignatures>;

/** Download capabilities supplement, but never replace, the resource's existing authority. */
export function registerWebUiFileDownloads(server: DownloadServer, instanceToken: string, now: () => number = Date.now) {
  const signatures = createDownloadSignatures(instanceToken, now);
  // The normal administrator middleware also protects issuance: a scoped WebUI
  // identity or another download capability cannot mint arbitrary path grants.
  server.addRoute({ path: '/api/download/sign', method: 'POST', handler: async (req, res) => {
    const resource = resourceFromInput(req.body || {});
    const error = pathError(resource);
    if (error) { res.status(400).json({ error }); return; }
    const stat = await fs.stat(resource.path).catch((): null => null);
    if (!stat?.isFile()) { res.status(404).json({ error: 'File not found' }); return; }
    const { path: filePath, ...options } = resource;
    const { params, expiresAt } = signatures.issue({ kind: 'path', path: filePath }, options);
    params.set('path', filePath);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ url: `download?${params}`, expiresAt });
  } });

  // Bypass the generic token-only middleware so a cookie-less GET/HEAD can
  // reach this OR gate. A bad signature must not veto valid credentials.
  server.addRoute({ path: '/download', method: 'GET', noAuth: true, handler: async (req, res) => {
    const resource = resourceFromInput(req.query);
    if (!server.checkToken(req) && !signatures.verify({ kind: 'path', path: resource.path }, req.query)) {
      const auth = await server.getAuthContext(req);
      res.status(auth ? 403 : 401).json({ error: auth ? 'Forbidden' : 'Unauthorized' }); return;
    }
    const error = pathError(resource);
    if (error) { res.status(400).json({ error }); return; }
    const filePath = resource.path;
    try {
      const stat = await fs.stat(filePath).catch((): null => null);
      if (!stat?.isFile()) { res.status(404).json({ error: 'File not found' }); return; }
      const fileName = resource.filename !== undefined
        ? resource.filename.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 255) || path.basename(filePath)
        : path.basename(filePath);
      const rasterMime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[path.extname(filePath).toLowerCase()];
      const preview = resource.preview === '1' && !!rasterMime;
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
  return signatures;
}

/** Global and Session blobs share the same byte/MIME delivery, not their issuance permissions. */
export function registerWebUiBlobDownloads(
  server: DownloadServer,
  signatures: DownloadSignatures,
  authorizeSessionBlob: (req: express.Request, res: express.Response, sessionId: string, blobId: string) => Promise<boolean>,
) {
  const authorize = async (req: express.Request, res: express.Response, target: Extract<DownloadTarget, { kind: 'blob' }>) => {
    if (target.sessionId !== undefined) return authorizeSessionBlob(req, res, target.sessionId, target.blobId);
    if (server.checkToken(req)) return true;
    const auth = await server.getAuthContext(req);
    res.status(auth ? 403 : 401).json({ error: auth ? 'Forbidden' : 'Unauthorized' });
    return false;
  };
  const handleError = (err: any, res: express.Response) => {
    if (err?.code === 'ENOENT') return res.status(404).json({ error: 'Image blob not found' });
    if (err?.message === 'Invalid image blob id.') return res.status(400).json({ error: err.message });
    logger.error({ err }, 'Failed to serve image blob');
    if (!res.headersSent) res.status(500).json({ error: 'Failed to serve image blob' });
    else res.destroy();
  };
  for (const scoped of [false, true]) {
    const routePath = scoped ? '/api/sessions/:sessionId/blobs/:blobId' : '/api/blobs/:blobId';
    const targetFromRequest = (req: express.Request): Extract<DownloadTarget, { kind: 'blob' }> => ({
      kind: 'blob', blobId: req.params.blobId as string,
      ...(scoped ? { sessionId: req.params.sessionId as string } : {}),
    });
    server.addRoute({ path: `${routePath}/download`, method: 'POST', auth: scoped ? 'webui' : 'admin', handler: async (req, res) => {
      const target = targetFromRequest(req);
      if (!await authorize(req, res, target)) return;
      try {
        const stat = await fs.stat(resolveImageBlobPath(target.blobId));
        if (!stat.isFile()) { res.status(404).json({ error: 'Image blob not found' }); return; }
        const { filename, preview } = resourceFromInput(req.body || {});
        const options = { ...(filename !== undefined ? { filename } : {}), ...(preview !== undefined ? { preview } : {}) };
        const { params, expiresAt } = signatures.issue(target, options);
        res.setHeader('Cache-Control', 'no-store');
        // Relative to the original blob URL, preserving its deployment and Session route.
        res.json({ url: `${encodeURIComponent(target.blobId)}?${params}`, expiresAt });
      } catch (err) { handleError(err, res); }
    } });
    server.addRoute({ path: routePath, method: 'GET', noAuth: true, handler: async (req, res) => {
      const target = targetFromRequest(req);
      if (!signatures.verify(target, req.query) && !await authorize(req, res, target)) return;
      try {
        const blobPath = resolveImageBlobPath(target.blobId);
        const stat = await fs.stat(blobPath);
        if (!stat.isFile()) { res.status(404).json({ error: 'Image blob not found' }); return; }
        const safeMimeType = getSafeRasterMimeType(target.blobId);
        if (req.query.preview === '0' || !safeMimeType) {
          const fileName = typeof req.query.filename === 'string'
            ? req.query.filename.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 255) || target.blobId : target.blobId;
          res.attachment(fileName);
        }
        res.setHeader('Content-Type', safeMimeType || 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('ETag', `"${target.blobId}"`);
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method === 'HEAD') { res.end(); return; }
        await new Promise<void>((resolve, reject) => {
          const stream = fs.createReadStream(blobPath);
          stream.on('error', reject);
          res.on('finish', resolve);
          res.on('close', () => { stream.destroy(); resolve(); });
          stream.pipe(res);
        });
      } catch (err) { handleError(err, res); }
    } });
  }
}
