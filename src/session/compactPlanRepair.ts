import { constants } from 'node:fs';
import { open, mkdir, mkdtemp, realpath, lstat, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir } from '../config';
import { checkToolPermissionForSession } from '../isolatedCheck';
import { applyUpdatePatch, parseApplyPatchInput } from '../../packages/shared/dist/applyPatch';
import { applyExactReplacement } from '../tools/helpers';
import type { FunctionCall, Session } from '../types';

/** Private to one planning invocation; never stored on Session or in persisted operation state. */
export class CompactPlanRepairFile {
  private constructor(
    readonly filePath: string,
    private readonly directory: string,
    private readonly file: FileHandle,
    private readonly session: Session,
    private readonly operation: object,
    private readonly inode: { dev: number; ino: number; uid: number },
    readonly structuredFallback: boolean,
  ) {}

  static async create(call: FunctionCall, session: Session, operation: object): Promise<CompactPlanRepairFile> {
    // Parse failures must retain the provider's text, never the empty parsed-args placeholder.
    let text: string;
    const structuredFallback = typeof call.rawArgsText !== 'string';
    if (!structuredFallback) text = call.rawArgsText!;
    else {
      if (call.argsParseError || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
        throw new Error('Raw compact arguments are unavailable; submit corrected direct plan fields.');
      }
      text = JSON.stringify(call.args, null, 2);
    }
    const agentDirectory = await realpath(getAgentDir(session.agent || 'main'));
    const root = path.join(agentDirectory, '.temp');
    await mkdir(root, { recursive: true });
    // Canonicalize the root before generating a private operation directory; do not accept a model path.
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) {
      throw new Error('The compact repair directory must be inside the current agent directory.');
    }
    const directory = await mkdtemp(path.join(root, 'compact-plan-'));
    const filePath = path.join(directory, 'plan.json');
    let file: FileHandle | undefined;
    try {
      file = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const inode = await file.stat();
      const repair = new CompactPlanRepairFile(filePath, directory, file, session, operation, inode, structuredFallback);
      await repair.assertOwned(filePath, session, operation);
      await file.writeFile(text, 'utf8');
      await repair.assertOwned(filePath, session, operation);
      return repair;
    } catch (error) {
      await file?.close().catch(() => {});
      await unlink(filePath).catch(() => {});
      await rmdir(directory).catch(() => {});
      throw error;
    }
  }

  private closed = false;

  private async assertOwned(filePath: unknown, session: Session, operation: object): Promise<void> {
    if (this.closed || session !== this.session || operation !== this.operation || filePath !== this.filePath) {
      throw new Error('Only the pending repair file for this compact operation may be used.');
    }
    const [named, held, canonical, directory] = await Promise.all([
      lstat(this.filePath), this.file.stat(), realpath(this.filePath), lstat(this.directory),
    ]);
    if (canonical !== this.filePath || !named.isFile() || named.isSymbolicLink()
      || named.dev !== this.inode.dev || named.ino !== this.inode.ino
      || held.dev !== this.inode.dev || held.ino !== this.inode.ino
      || named.nlink !== 1 || held.nlink !== 1 || named.uid !== this.inode.uid
      || !directory.isDirectory() || directory.isSymbolicLink()
      || directory.uid !== this.inode.uid || (directory.mode & 0o777) !== 0o700
      || (named.mode & 0o777) !== 0o600) {
      throw new Error('The pending compact repair file was replaced or its permissions changed.');
    }
  }

  async read(filePath: unknown, session: Session, operation: object): Promise<string> {
    await this.assertOwned(filePath, session, operation);
    // Explicit offsets avoid sharing readFile's advancing descriptor position across submissions.
    const chunks: Buffer[] = [];
    let offset = 0;
    while (true) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await this.file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await this.assertOwned(filePath, session, operation);
    return Buffer.concat(chunks).toString('utf8');
  }

  async preview(session: Session, operation: object): Promise<string> {
    const text = await this.read(this.filePath, session, operation);
    const budget = 1000;
    if (text.length <= budget) return `Current file (complete):\n\`\`\`json\n${text}\n\`\`\``;
    return [
      `Beginning of current file:\n\`\`\`json\n${text.slice(0, budget / 2)}\n\`\`\``,
      '[Middle of current file omitted.]',
      `End of current file:\n\`\`\`json\n${text.slice(-budget / 2)}\n\`\`\``,
    ].join('\n');
  }

  async edit(call: FunctionCall, session: Session, operation: object): Promise<void> {
    if (call.argsParseError) throw new Error('Repair tool arguments must be valid JSON.');
    const args = call.args || {};
    let target: unknown;
    let transform: (content: string) => string;
    if (call.name === 'edit') {
      if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
        throw new Error('edit requires oldText and newText strings.');
      }
      target = args.filePath;
      transform = content => applyExactReplacement(content, args.oldText, args.newText, 'oldText');
    } else if (call.name === 'apply_patch') {
      if (typeof args.input !== 'string') throw new Error('apply_patch requires input string.');
      const patches = parseApplyPatchInput(args.input);
      if (patches.length !== 1 || patches[0].action !== 'update') {
        throw new Error('Repair patches must update only the pending compact repair file.');
      }
      const patch = patches[0];
      target = patch.filePath;
      transform = content => applyUpdatePatch(content, patch.lines, this.filePath);
    } else throw new Error('Only edit or apply_patch may repair compact arguments.');

    await this.assertOwned(target, session, operation);
    // The exact parsed patch target is also supplied to the ordinary master-file permission policy.
    await checkToolPermissionForSession(session, { source: 'node', node: 'master', tool: call.name }, 'master', { ...args, filePath: target });
    const updated = Buffer.from(transform(await this.read(target, session, operation)), 'utf8');
    await this.assertOwned(target, session, operation);
    // Descriptor writes cannot follow a path replaced with a symlink after the check.
    let offset = 0;
    while (offset < updated.length) {
      const { bytesWritten } = await this.file.write(updated, offset, updated.length - offset, offset);
      offset += bytesWritten;
    }
    await this.file.truncate(updated.length);
    await this.assertOwned(target, session, operation);
  }

  async cleanup(): Promise<void> {
    this.closed = true;
    await this.file.close().catch(() => {});
    // Unlink only our literal entry, never follow a replacement or recursively traverse a directory.
    await unlink(this.filePath).catch(() => {});
    await rmdir(this.directory).catch(() => {});
  }
}

/** Submission forms are checked before loading or validating any plan. */
export function compactPlanSubmissionUsesFile(args: Record<string, any>): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Compact plan arguments must be an object.');
  if (!Object.prototype.hasOwnProperty.call(args, 'argsFilePath')) return false;
  if (Object.keys(args).length !== 1 || typeof args.argsFilePath !== 'string' || !args.argsFilePath) {
    throw new Error('Supply argsFilePath alone, or direct plan fields without argsFilePath.');
  }
  return true;
}
