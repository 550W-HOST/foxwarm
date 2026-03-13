import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
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
  metadataPath: string;
  mainDocumentPath?: string;
  manifestPath?: string;
  memoryDir: string;
  documentFiles: string[];
}

export interface SkillDocument {
  filePath: string;
  content: string;
}

type ParsedMarkdownMetadata = {
  metadata: SkillManifest;
};

export function validateSkillName(skillName: string): void {
  // Allow nested skills like "tencent/vision-analyzer"
  const parts = skillName.split('/');
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_-]+$/.test(part)) {
      throw new Error('Invalid skill name. Use only alphanumeric characters, hyphens, underscores, and forward slashes for nested skills.');
    }
  }
}

async function readSkillManifest(skillName: string): Promise<{ manifestPath: string; manifest: SkillManifest }> {
  const manifestPath = path.join(getSkillDir(skillName), 'skill.json');
  if (!await fs.pathExists(manifestPath)) {
    throw new Error(`Skill manifest not found for "${skillName}".`);
  }

  const manifest = await fs.readJson(manifestPath);
  return { manifestPath, manifest };
}

function parseFrontMatter(content: string): { data: SkillManifest; body: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return null;

  const data = yaml.load(match[1]);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { data: {}, body: content.slice(match[0].length) };
  }

  return {
    data: data as SkillManifest,
    body: content.slice(match[0].length),
  };
}

function extractHeadingName(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || undefined;
}

function extractDescriptionParagraph(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const maxLines = Math.min(lines.length, 40);
  const paragraph: string[] = [];
  let inCodeFence = false;

  for (let i = 0; i < maxLines; i++) {
    const line = lines[i].trim();

    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence;
      if (paragraph.length > 0) break;
      continue;
    }

    if (inCodeFence) continue;
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith('<!--')) continue;
    if (line.startsWith('#')) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^[-*+]\s/.test(line)) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith('>')) {
      if (paragraph.length > 0) break;
      continue;
    }

    paragraph.push(line);
  }

  return paragraph.length > 0 ? paragraph.join(' ') : undefined;
}

function parseSkillMarkdownMetadata(content: string): ParsedMarkdownMetadata {
  const frontMatter = parseFrontMatter(content);
  const metadata = { ...(frontMatter?.data || {}) };
  const body = frontMatter?.body || content;

  if (!metadata.name) {
    metadata.name = extractHeadingName(body);
  }

  if (!metadata.description) {
    metadata.description = extractDescriptionParagraph(body);
  }

  return {
    metadata,
  };
}

async function readSkillMarkdownMetadata(markdownPath: string): Promise<ParsedMarkdownMetadata> {
  const content = await fs.readFile(markdownPath, 'utf8');
  return parseSkillMarkdownMetadata(content);
}

async function resolveSkillMetadata(skillName: string): Promise<{
  metadataPath: string;
  mainDocumentPath?: string;
  manifestPath?: string;
  manifest: SkillManifest;
}> {
  const skillDir = getSkillDir(skillName);
  const markdownCandidates = [
    path.join(skillDir, 'SKILL.md'),
    path.join(getSkillMemoryDir(skillName), 'SKILL.md'),
  ];

  let markdownPath: string | undefined;
  let markdownManifest: SkillManifest = {};

  for (const candidate of markdownCandidates) {
    if (!await fs.pathExists(candidate)) continue;

    markdownPath = candidate;
    const parsed = await readSkillMarkdownMetadata(candidate);
    markdownManifest = parsed.metadata;
    break;
  }

  let manifestPath: string | undefined;
  let jsonManifest: SkillManifest = {};

  try {
    const manifestInfo = await readSkillManifest(skillName);
    manifestPath = manifestInfo.manifestPath;
    jsonManifest = manifestInfo.manifest;
  } catch (e: any) {
    if (!e.message?.includes('Skill manifest not found')) {
      throw e;
    }
  }

  if (!markdownPath && !manifestPath) {
    throw new Error(
      `Skill "${skillName}" not found. Expected one of: skills/${skillName}/SKILL.md, skills/${skillName}/memory/SKILL.md, skills/${skillName}/skill.json.`
    );
  }

  return {
    metadataPath: markdownPath || manifestPath!,
    mainDocumentPath: markdownPath,
    manifestPath,
    manifest: {
      ...jsonManifest,
      ...markdownManifest,
    },
  };
}

async function listSkillDocumentFiles(skillName: string, mainDocumentPath?: string): Promise<string[]> {
  const skillDir = getSkillDir(skillName);
  const memoryDir = getSkillMemoryDir(skillName);
  const files: string[] = [];

  if (mainDocumentPath) {
    files.push(path.relative(skillDir, mainDocumentPath));
  }

  if (await fs.pathExists(memoryDir)) {
    const memoryEntries = await fs.readdir(memoryDir);
    const memoryFiles = memoryEntries
      .sort()
      .filter(file => file.endsWith('.md'))
      .map(file => path.join('memory', file));

    for (const file of memoryFiles) {
      if (!files.includes(file)) {
        files.push(file);
      }
    }
  }

  return files;
}

export async function getSkillInfo(skillName: string): Promise<SkillInfo> {
  validateSkillName(skillName);

  const dir = getSkillDir(skillName);
  if (!await fs.pathExists(dir)) {
    throw new Error(`Skill "${skillName}" not found.`);
  }

  const { metadataPath, mainDocumentPath, manifestPath, manifest } = await resolveSkillMetadata(skillName);
  const memoryDir = getSkillMemoryDir(skillName);
  const documentFiles = await listSkillDocumentFiles(skillName, mainDocumentPath);

  return {
    name: skillName,
    description: manifest.description,
    dir,
    metadataPath,
    mainDocumentPath,
    manifestPath,
    memoryDir,
    documentFiles,
  };
}

/**
 * Recursively find all skill directories (containing SKILL.md or skill.json)
 */
async function findSkillDirectories(baseDir: string, relativePath: string = ''): Promise<string[]> {
  const skillDirs: string[] = [];
  
  if (!await fs.pathExists(baseDir)) {
    return skillDirs;
  }

  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const entryPath = path.join(baseDir, entry.name);
    const skillName = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    
    // Check if this directory is a skill (has SKILL.md or skill.json)
    const hasSkillMd = await fs.pathExists(path.join(entryPath, 'SKILL.md'));
    const hasSkillJson = await fs.pathExists(path.join(entryPath, 'skill.json'));
    
    if (hasSkillMd || hasSkillJson) {
      skillDirs.push(skillName);
    }
    
    // Always recurse into subdirectories to find nested skills
    const nestedSkills = await findSkillDirectories(entryPath, skillName);
    skillDirs.push(...nestedSkills);
  }
  
  return skillDirs;
}

export async function listSkills(): Promise<SkillInfo[]> {
  if (!await fs.pathExists(SKILLS_DIR)) {
    return [];
  }

  const skillNames = await findSkillDirectories(SKILLS_DIR);
  skillNames.sort((a, b) => a.localeCompare(b));
  
  const skills: SkillInfo[] = [];

  for (const skillName of skillNames) {
    try {
      skills.push(await getSkillInfo(skillName));
    } catch (e) {
      logger.warn({ err: e, skillName }, 'Skipping invalid skill directory');
    }
  }

  return skills;
}

export async function loadSkillDocuments(skillName: string): Promise<{ info: SkillInfo; documents: SkillDocument[] }> {
  const info = await getSkillInfo(skillName);
  const documents: SkillDocument[] = [];

  for (const file of info.documentFiles) {
    const filePath = path.join(info.dir, file);
    const content = await fs.readFile(filePath, 'utf8');
    documents.push({ filePath, content });
  }

  return { info, documents };
}
