export const VSCODE_GIT_COMMIT_SERVICE_VERSION = 2;
export const MAX_VSCODE_GIT_COMMIT_FILES = 5000;

export class VscodeGitCommitDetailsError extends Error {
  constructor(public readonly code: 'InvalidCommit' | 'PayloadTooLarge' | 'InvalidGitResponse', message: string) {
    super(message);
    this.name = 'VscodeGitCommitDetailsError';
  }
}

export type VscodeGitRunner = (cwd: string, args: string[], maxStdoutBytes: number) => Promise<Buffer>;

export type VscodeGitCommitFile = {
  status: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unknown';
  path: string;
  oldPath?: string;
  oldOid: string;
  newOid: string;
  oldMode: string;
  newMode: string;
  additions?: number;
  deletions?: number;
  binary: boolean;
  submodule: boolean;
};

export type VscodeGitCommitDetails = {
  workspace: string;
  commit: {
    oid: string;
    parents: string[];
    subject: string;
    message: string;
    author: { name: string; email: string };
    authoredAt: string;
    committedAt: string;
  };
  comparison: { parentOid: string | null; mode: 'first-parent' | 'empty-tree' };
  stats: { files: number; additions: number; deletions: number; binaryFiles: number };
  files: VscodeGitCommitFile[];
};

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_TREE_BYTES = 20 * 1024 * 1024;
const COMMIT_ID_RE = /^[0-9a-f]{7,64}$/i;
const FULL_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export function normalizeVscodeGitCommitId(value: unknown): string {
  if (typeof value !== 'string' || !COMMIT_ID_RE.test(value)) {
    throw new VscodeGitCommitDetailsError('InvalidCommit', 'commit id must contain 7 to 64 hexadecimal characters.');
  }
  return value.toLowerCase();
}

export function normalizeVscodeGitContentRef(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'HEAD';
  if (value === 'HEAD') return 'HEAD';
  if (typeof value !== 'string' || !FULL_OID_RE.test(value)) {
    throw new VscodeGitCommitDetailsError('InvalidCommit', 'Git content ref must be HEAD or a full 40/64-character object id.');
  }
  return value.toLowerCase();
}

function classifyStatus(status: string): VscodeGitCommitFile['kind'] {
  switch (status) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    default: return 'unknown';
  }
}

function parseRawFiles(raw: Buffer): VscodeGitCommitFile[] {
  const records = raw.toString('utf8').split('\0');
  const files: VscodeGitCommitFile[] = [];
  for (let index = 0; index < records.length;) {
    const header = records[index++];
    if (!header) continue;
    const match = header.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d*)$/i);
    if (!match) throw new VscodeGitCommitDetailsError('InvalidGitResponse', 'Git returned an invalid raw commit diff record.');
    const status = match[5].toUpperCase();
    const firstPath = records[index++];
    if (firstPath === undefined) throw new VscodeGitCommitDetailsError('InvalidGitResponse', 'Git raw commit diff is missing a path.');
    const renamed = status === 'R' || status === 'C';
    const secondPath = renamed ? records[index++] : undefined;
    if (renamed && secondPath === undefined) throw new VscodeGitCommitDetailsError('InvalidGitResponse', 'Git raw rename/copy record is missing its destination path.');
    const oldMode = match[1];
    const newMode = match[2];
    files.push({
      status,
      kind: classifyStatus(status),
      path: renamed ? secondPath! : firstPath,
      ...(renamed ? { oldPath: firstPath } : {}),
      oldOid: match[3].toLowerCase(),
      newOid: match[4].toLowerCase(),
      oldMode,
      newMode,
      binary: false,
      submodule: oldMode === '160000' || newMode === '160000',
    });
    if (files.length > MAX_VSCODE_GIT_COMMIT_FILES) {
      throw new VscodeGitCommitDetailsError('PayloadTooLarge', `Commit changes more than ${MAX_VSCODE_GIT_COMMIT_FILES} files.`);
    }
  }
  return files;
}

function parseNumstat(raw: Buffer): Map<string, { additions?: number; deletions?: number; binary: boolean }> {
  const records = raw.toString('utf8').split('\0');
  const stats = new Map<string, { additions?: number; deletions?: number; binary: boolean }>();
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record) continue;
    const match = record.match(/^([^\t]+)\t([^\t]+)\t(.*)$/s);
    if (!match) throw new VscodeGitCommitDetailsError('InvalidGitResponse', 'Git returned an invalid numstat record.');
    let targetPath = match[3];
    if (!targetPath) {
      const _oldPath = records[index++];
      const newPath = records[index++];
      if (_oldPath === undefined || newPath === undefined) throw new VscodeGitCommitDetailsError('InvalidGitResponse', 'Git numstat rename/copy record is incomplete.');
      targetPath = newPath;
    }
    const binary = match[1] === '-' || match[2] === '-';
    stats.set(targetPath, binary ? { binary: true } : {
      additions: Number(match[1]),
      deletions: Number(match[2]),
      binary: false,
    });
  }
  return stats;
}

export async function readVscodeGitCommitDetails(workspace: string, id: unknown, runGit: VscodeGitRunner): Promise<VscodeGitCommitDetails> {
  const requestedId = normalizeVscodeGitCommitId(id);
  const topLevel = (await runGit(workspace, ['rev-parse', '--show-toplevel'], 1024 * 1024)).toString('utf8').trim();
  const objectType = (await runGit(topLevel, ['cat-file', '-t', requestedId], 1024 * 1024)).toString('utf8').trim();
  if (objectType !== 'commit') throw new VscodeGitCommitDetailsError('InvalidCommit', 'The supplied object id does not name a commit directly.');
  const oid = (await runGit(topLevel, ['rev-parse', '--verify', requestedId], 1024 * 1024)).toString('utf8').trim().toLowerCase();
  if (!FULL_OID_RE.test(oid)) throw new VscodeGitCommitDetailsError('InvalidGitResponse', 'Git resolved the commit to an invalid object id.');

  const metadata = (await runGit(topLevel, [
    'show', '-s', '--no-show-signature', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%B', oid,
  ], MAX_METADATA_BYTES)).toString('utf8');
  const fields = metadata.split('\0');
  if (fields.length < 8 || fields[0].trim().toLowerCase() !== oid) throw new VscodeGitCommitDetailsError('InvalidGitResponse', 'Git returned invalid commit metadata.');
  const parents = fields[1].trim() ? fields[1].trim().toLowerCase().split(/\s+/) : [];
  const parentOid = parents[0] || null;
  const comparisonArgs = parentOid ? [parentOid, oid] : [oid];
  const commonArgs = parentOid ? [] : ['--root'];
  const rawFiles = await runGit(topLevel, [
    'diff-tree', ...commonArgs, '--no-commit-id', '-r', '-z', '--raw', '--full-index', '-M', ...comparisonArgs, '--',
  ], MAX_DIFF_TREE_BYTES);
  const rawNumstat = await runGit(topLevel, [
    'diff-tree', ...commonArgs, '--no-commit-id', '-r', '-z', '--numstat', '-M', ...comparisonArgs, '--',
  ], MAX_DIFF_TREE_BYTES);
  const files = parseRawFiles(rawFiles);
  const numstat = parseNumstat(rawNumstat);
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (const file of files) {
    const stat = numstat.get(file.path);
    if (!stat) continue;
    file.binary = stat.binary;
    if (stat.binary) binaryFiles += 1;
    else {
      file.additions = stat.additions;
      file.deletions = stat.deletions;
      additions += stat.additions || 0;
      deletions += stat.deletions || 0;
    }
  }

  return {
    workspace: topLevel,
    commit: {
      oid,
      parents,
      author: { name: fields[2], email: fields[3] },
      authoredAt: fields[4],
      committedAt: fields[5],
      subject: fields[6],
      message: fields.slice(7).join('\0').replace(/\n$/, ''),
    },
    comparison: { parentOid, mode: parentOid ? 'first-parent' : 'empty-tree' },
    stats: { files: files.length, additions, deletions, binaryFiles },
    files,
  };
}
