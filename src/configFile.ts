import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Replace one complete validated document; readers see the old or the new file. */
export function replaceConfigFile(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let replaced = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    replaced = true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!replaced) fs.rmSync(temporary, { force: true });
  }
}