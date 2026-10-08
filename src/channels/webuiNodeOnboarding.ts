import { HttpServer } from '../httpServer';
import { PUBLIC_BASE_URL, normalizePublicUrl } from '../config';
import { buildNodeBootstrapCommands, ensureNodePairingToken } from '../nodes/bootstrapInfo';
import { approvePendingPairing, createApprovedNode, listPendingPairings } from '../nodes/registry';
import { nodesManager } from '../nodes/manager';
import type { Request, Response } from 'express';

class OnboardingInputError extends Error {}

function objectBody(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new OnboardingInputError('Invalid request.');
  return req.body;
}

function stringField(value: unknown, fallback: string, name: string, max = 4096): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new OnboardingInputError(`Enter a valid ${name}.`);
  return value.trim();
}

function commandInput(req: Request) {
  const body = objectBody(req);
  const rawUrl = body.baseUrl === undefined ? (PUBLIC_BASE_URL || body.fallbackUrl) : body.baseUrl;
  let baseUrl: string | undefined;
  try { baseUrl = normalizePublicUrl(rawUrl); }
  catch { throw new OnboardingInputError('Enter an HTTP or HTTPS address without a username, password, query, or fragment.'); }
  if (!baseUrl) throw new OnboardingInputError('Enter an address reachable from the new Node.');
  const nodeId = stringField(body.nodeId, 'my-node', 'Node name', 48);
  if (!/^[a-zA-Z0-9_-]+$/.test(nodeId)) throw new OnboardingInputError('Node names use letters, numbers, hyphens and underscores.');
  return { baseUrl, nodeId, installDir: stringField(body.installDir, '/opt/foxwarm-node', 'installation directory') };
}

/** Main-authenticated onboarding actions; never attach secrets to ordinary Node summaries. */
export function registerWebUiNodeOnboardingRoutes(server: HttpServer): void {
  const route = (method: 'GET' | 'POST', path: string, handler: (req: Request, res: Response) => Promise<void>) => {
    server.addRoute({ method, path: `/api/nodes/onboarding${path}`, handler: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try { await handler(req, res); }
      catch (error) {
        if (!res.headersSent) res.status(error instanceof OnboardingInputError ? 400 : 500).json({
          error: error instanceof OnboardingInputError ? error.message : 'The request could not be completed. Refresh Nodes before trying again.',
        });
      }
    } });
  };

  route('POST', '/commands', async (req, res) => {
    const input = commandInput(req);
    const pairingToken = await ensureNodePairingToken();
    res.json({ baseUrl: input.baseUrl, commands: buildNodeBootstrapCommands({ ...input, pairingToken }) });
  });

  route('GET', '/pending', async (req, res) => {
    const entries = (await listPendingPairings()).filter(entry => !entry.approvedNodeId);
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new OnboardingInputError('Invalid pending page.');
    const items = entries.slice(offset, offset + 50).map(entry => ({
      id: entry.id, requestedName: entry.requestedName || '', nodeType: entry.nodeType,
      requestedAt: entry.requestedAt, connected: entry.connected,
    }));
    res.json({ items, total: entries.length, nextOffset: offset + items.length < entries.length ? offset + items.length : null });
  });

  route('POST', '/approve', async (req, res) => {
    const body = objectBody(req);
    const pendingId = stringField(body.pendingId, '', 'pending request', 128);
    const nodeId = body.nodeId === undefined || body.nodeId === '' ? undefined : stringField(body.nodeId, '', 'Node name', 48);
    const pending = (await listPendingPairings()).find(entry => entry.id === pendingId && !entry.approvedNodeId);
    if (!pending) { res.status(409).json({ error: 'This request is no longer awaiting approval. Refresh the list.' }); return; }
    try {
      const approved = await approvePendingPairing(pendingId, nodeId);
      res.json({ nodeId: approved.nodeId, deliveredLive: approved.deliveredLive });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/not found|no longer awaiting|already exists/.test(message)) {
        res.status(409).json({ error: 'The request changed or the Node name is already in use. Refresh the list or choose another name.' });
      } else if (/Node id/.test(message)) res.status(400).json({ error: 'Choose a valid, non-reserved Node name.' });
      else throw error;
    }
  });

  route('POST', '/create-shell', async (req, res) => {
    const input = commandInput(req);
    if (nodesManager.getNode(input.nodeId)) { res.status(409).json({ error: 'This Node name is already online. Choose another name.' }); return; }
    try {
      const created = await createApprovedNode(input.nodeId);
      const command = buildNodeBootstrapCommands({ ...input, pairingToken: '', authToken: created.authToken }).shell;
      res.json({ nodeId: created.nodeId, command });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/already exists/.test(message)) res.status(409).json({ error: 'This Node name is already in use. Choose another name.' });
      else if (/Node id/.test(message)) res.status(400).json({ error: 'Choose a valid, non-reserved Node name.' });
      else throw error;
    }
  });
}
