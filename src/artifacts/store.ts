import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { validateArtifactDocument } from '../../packages/shared/dist/artifacts/registry';
import { parseArtifactReceipt, type StoredArtifact } from '../../packages/shared/dist/artifacts/types';
import { prepareArtifact } from './prepare';
/** Immutable revision files, serialized per artifact within the one Main owner. */
export class ArtifactStore {
  private pending = new Map<string, Promise<unknown>>();
  constructor(private root: string, private prepare = prepareArtifact) {}
  private file(id: string, revision: number) {
    if (!/^art_[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid artifact reference');
    return path.join(this.root, id, `${revision}.json`);
  }
  async read(id: string, revision: number, sessionId: string): Promise<StoredArtifact> {
    const result: StoredArtifact = JSON.parse(await fs.readFile(this.file(id, revision), 'utf8'));
    if (!parseArtifactReceipt(result.receipt) || result.receipt.sessionId !== sessionId || result.receipt.artifactId !== id || result.receipt.revision !== revision) throw new Error('Artifact unavailable');
    return result;
  }
  async resource(id: string, revision: number, sessionId: string, name: string) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Resource unavailable');
    const record = await this.read(id, revision, sessionId), descriptor = record.resources?.[name];
    if (!descriptor || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error('Resource unavailable');
    const bytes = await fs.readFile(path.join(this.root, id, 'resources', descriptor.sha256));
    if (bytes.length !== descriptor.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('Resource unavailable');
    return { bytes, mimeType: descriptor.mimeType };
  }
  async latestRevision(id: string, sessionId: string): Promise<number> {
    await this.read(id, 1, sessionId);
    const entries = await fs.readdir(path.join(this.root, id));
    return Math.max(...entries.filter(x => /^\d+\.json$/.test(x)).map(x => Number(x.split('.')[0])));
  }
  async publish(sessionId: string, value: unknown, artifactId?: string, expectedRevision?: number, sourceResources?: Record<string, Buffer>): Promise<StoredArtifact> {
    const document = validateArtifactDocument(value);
    const id = artifactId || `art_${randomBytes(16).toString('hex')}`;
    this.file(id, 1);
    const previous = this.pending.get(id) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      let revision = 1;
      if (artifactId) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Updating requires expectedRevision');
        const old = await this.read(id, expectedRevision, sessionId);
        if (old.receipt.type !== document.type) throw new Error('An artifact cannot change type');
        const entries = await fs.readdir(path.join(this.root, id));
        const latest = Math.max(...entries.filter(x => /^\d+\.json$/.test(x)).map(x => Number(x.split('.')[0])));
        if (latest !== expectedRevision) throw new Error('Revision conflict: inspect the latest publication before updating');
        revision = latest + 1;
      } else if (expectedRevision !== undefined) throw new Error('expectedRevision requires artifactId');
      const prepared = await this.prepare(document, sourceResources);
      if (prepared.resources) prepared.resources = Object.fromEntries(Object.entries(prepared.resources).map(([name, resource]) => [name, { ...resource, bytes: Buffer.from(resource.bytes) }]));
      const record: StoredArtifact = { receipt: { protocolVersion: 1, artifactId: id, revision, sessionId, type: document.type, title: document.title }, document, createdAt: new Date().toISOString(), ...(prepared.compiled ? { compiled: prepared.compiled } : {}), ...(prepared.resources ? { resources: Object.fromEntries(Object.entries(prepared.resources).map(([name, resource]) => [name, { mimeType: resource.mimeType, sizeBytes: resource.bytes.length, sha256: createHash('sha256').update(resource.bytes).digest('hex') }])) } : {}) };
      const target = this.file(id, revision); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        if (prepared.resources) {
          const resourceDir = path.join(path.dirname(target), 'resources');
          await fs.mkdir(resourceDir, { recursive: true, mode: 0o700 });
          for (const [name, resource] of Object.entries(prepared.resources)) {
            if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid resource name');
            const resourceTarget = path.join(resourceDir, record.resources![name].sha256);
            const staging = `${resourceTarget}.${randomBytes(8).toString('hex')}.tmp`;
            try {
              await fs.writeFile(staging, resource.bytes, { flag: 'wx', mode: 0o600 });
              try { await fs.link(staging, resourceTarget); }
              catch (error: any) { if (error.code !== 'EEXIST') throw error; }
            } finally { await fs.rm(staging, { force: true }); }
          }
        }
        // Blobs are complete before the revision becomes visible. An interrupted
        // publish can leave unreferenced blobs but cannot poison the next revision.
        await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await fs.link(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
      return record;
    });
    this.pending.set(id, job);
    try { return await job; } finally { if (this.pending.get(id) === job) this.pending.delete(id); }
  }
}
