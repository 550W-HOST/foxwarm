import type express from 'express';
import type { ArtifactStore } from './store';
import { artifactStore } from './tool';
/** Every read rechecks the owning Session scope; the ID is not an authorization token. */
export function registerArtifactRoutes(server: { app: express.Application }, requireAccess: (req: express.Request, res: express.Response, id: string) => Promise<unknown>, store: ArtifactStore = artifactStore) {
  server.app.get('/api/sessions/:sessionId/artifacts/:artifactId/:revision/resources/:resource', async (req, res) => {
    const sessionId = String(req.params.sessionId);
    if (!await requireAccess(req, res, sessionId)) return;
    try {
      const resource = await store.resource(String(req.params.artifactId), Number(req.params.revision), sessionId, String(req.params.resource));
      if (!['image/png','image/jpeg','image/gif','image/webp'].includes(resource.mimeType)) throw new Error('Unsupported resource');
      res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.type(resource.mimeType).send(resource.bytes);
    } catch { res.status(404).json({ error: 'Resource unavailable' }); }
  });
  server.app.get('/api/sessions/:sessionId/artifacts/:artifactId/:revision', async (req, res) => {
    const sessionId = String(req.params.sessionId);
    if (!await requireAccess(req, res, sessionId)) return;
    try {
      const artifact = await store.read(String(req.params.artifactId), Number(req.params.revision), sessionId);
      res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.json(artifact);
    } catch { res.status(404).json({ error: 'Artifact unavailable' }); }
  });
}
