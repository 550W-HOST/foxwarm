import fs from 'fs-extra';
import path from 'path';
import { logger } from './common';
import { getSkillDir, getSkillMemoryDir, SKILLS_DIR } from './config';

export interface SkillManifest {
  name?: string;
  description?: string;
  [key: string]: any;
}

export interface SkillInfo {
  name: string;
  description?: string;
  dir: string;
  manifestPath: string;
  memoryDir: string;
  memoryFiles: string[];
}

export interface SkillDocument {
  filePath: string;
  content: string;
}

export function validateSkillName(skillName: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
    throw new Error('Invalid skill name. Use only alphanumeric characters, hyphens, and underscores.');
  }
}

async function readSkillManifest(skillName: string): Promise<{ manifestPath: string; manifest: SkillManifest }> {
  const manifestPath = path.join(getSkillDir(skillName), 'skill.json');
  if (!await fs.pathExists(manifestPath)) {
    throw new Error(`Skill "${skillName}" not found.`);
  }

  const manifest = await fs.readJson(manifestPath);
  return { manifestPath, manifest };
}

export async function getSkillInfo(skillName: string): Promise<SkillInfo> {
  validateSkillName(skillName);

  const dir = getSkillDir(skillName);
  if (!await fs.pathExists(dir)) {
    throw new Error(`Skill "${skillName}" not found.`);
  }

  const { manifestPath, manifest } = await readSkillManifest(skillName);
  const memoryDir = getSkillMemoryDir(skillName);
  let memoryFiles: string[] = [];

  if (await fs.pathExists(memoryDir)) {
    const files = await fs.readdir(memoryDir);
    memoryFiles = files.sort().filter(file => file.endsWith('.md'));
  }

  return {
    name: skillName,
    description: manifest.description,
    dir,
    manifestPath,
    memoryDir,
    memoryFiles,
  };
}

export async function listSkills(): Promise<SkillInfo[]> {
  if (!await fs.pathExists(SKILLS_DIR)) {
    return [];
  }

  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const skills: SkillInfo[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    try {
      skills.push(await getSkillInfo(entry.name));
    } catch (e) {
      logger.warn({ err: e, skillName: entry.name }, 'Skipping invalid skill directory');
    }
  }

  return skills;
}

export async function loadSkillDocuments(skillName: string): Promise<{ info: SkillInfo; documents: SkillDocument[] }> {
  const info = await getSkillInfo(skillName);
  const documents: SkillDocument[] = [];

  for (const file of info.memoryFiles) {
    const filePath = path.join(info.memoryDir, file);
    const content = await fs.readFile(filePath, 'utf8');
    documents.push({ filePath, content });
  }

  return { info, documents };
}
