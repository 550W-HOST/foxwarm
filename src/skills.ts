import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import type { Dirent } from 'fs';
import { logger } from './common';
import { AGENTS_FILE, getAgentDir, SKILLS_DIR } from './config';

export interface SkillMetadata {
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
  documentFiles: string[];
  resourceFiles: string[];
  resourceFilesTruncated: boolean;
  sourceType: 'agent-local' | 'agent-inherited' | 'global';
  sourceAgentName?: string;
}

export interface SkillDocument {
  filePath: string;
  content: string;
}

type ParsedMarkdownMetadata = {
  metadata: SkillMetadata;
};

type SkillSourceType = SkillInfo['sourceType'];

type SkillSearchRoot = {
  baseDir: string;
  sourceType: SkillSourceType;
  agentName?: string;
};

type SkillResolveOptions = {
  agentName?: string;
};

type SkillInfoBuildOptions = {
  includeResources?: boolean;
};

type AgentMetadataSnapshot = {
  inherit?: string;
  [key: string]: any;
};

const SKILL_DISCOVERY_SKIP_DIRS = new Set([
  '.git',
  'build',
  'dist',
  'memory',
  'node_modules',
  '__pycache__',
]);

const SKILL_RESOURCE_SKIP_DIRS = new Set([
  '.git',
  'build',
  'dist',
  'memory',
  'node_modules',
  '__pycache__',
]);

const DEFAULT_MAX_SKILL_RESOURCE_FILES = 200;

export function validateSkillName(skillName: string): void {
  // Allow nested skills like "tencent/vision-analyzer"
  const parts = skillName.split('/');
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_-]+$/.test(part)) {
      throw new Error('Invalid skill name. Use only alphanumeric characters, hyphens, underscores, and forward slashes for nested skills.');
    }
  }
}

export function formatSkillSourceLabel(skill: Pick<SkillInfo, 'sourceType' | 'sourceAgentName'>): string {
  if (skill.sourceType === 'global') {
    return 'global';
  }

  if (skill.sourceType === 'agent-local') {
    return `agent:${skill.sourceAgentName || 'main'}`;
  }

  return `inherited:${skill.sourceAgentName || 'unknown'}`;
}

function getAgentSkillsDir(agentName: string): string {
  return path.join(getAgentDir(agentName), 'skills');
}

function getSkillDirFromRoot(baseDir: string, skillName: string): string {
  return path.join(baseDir, skillName);
}

async function readAgentMetadataSnapshot(): Promise<Record<string, AgentMetadataSnapshot>> {
  if (!await fs.pathExists(AGENTS_FILE)) {
    return {};
  }

  try {
    return await fs.readJson(AGENTS_FILE);
  } catch (e) {
    logger.warn({ err: e }, 'Failed to read agent metadata while resolving skills');
    return {};
  }
}

async function getAgentInheritanceChain(agentName: string): Promise<string[]> {
  const snapshot = await readAgentMetadataSnapshot();
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = agentName;

  while (current) {
    if (seen.has(current)) {
      logger.warn({ agentName, current, chain }, 'Circular agent inheritance detected while resolving skills');
      break;
    }

    seen.add(current);
    chain.unshift(current);
    current = snapshot[current]?.inherit;
  }

  return chain;
}

async function getSkillSearchRoots(agentName: string = 'main'): Promise<SkillSearchRoot[]> {
  const inheritanceChain = await getAgentInheritanceChain(agentName);
  const orderedAgentNames = inheritanceChain.length > 0 ? [...inheritanceChain].reverse() : [agentName];
  const roots: SkillSearchRoot[] = orderedAgentNames.map(name => ({
    baseDir: getAgentSkillsDir(name),
    sourceType: name === agentName ? 'agent-local' : 'agent-inherited',
    agentName: name,
  }));

  roots.push({
    baseDir: SKILLS_DIR,
    sourceType: 'global',
  });

  return roots;
}

function parseFrontMatter(content: string): { data: SkillMetadata; body: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return null;

  const data = yaml.load(match[1]);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { data: {}, body: content.slice(match[0].length) };
  }

  return {
    data: data as SkillMetadata,
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

async function resolveSkillMetadata(skillName: string, skillDir: string): Promise<{
  metadataPath: string;
  mainDocumentPath?: string;
  metadata: SkillMetadata;
}> {
  const markdownPath = path.join(skillDir, 'SKILL.md');
  if (!await fs.pathExists(markdownPath)) {
    throw new Error(
      `Skill "${skillName}" not found. Expected: ${markdownPath}.`
    );
  }

  const parsed = await readSkillMarkdownMetadata(markdownPath);

  return {
    metadataPath: markdownPath,
    mainDocumentPath: markdownPath,
    metadata: parsed.metadata,
  };
}

async function listSkillDocumentFiles(skillDir: string, mainDocumentPath?: string): Promise<string[]> {
  const files: string[] = [];

  if (mainDocumentPath) {
    files.push(path.relative(skillDir, mainDocumentPath));
  }

  return files;
}

async function listSkillResourceFiles(skillDir: string, documentFiles: string[], maxFiles: number = DEFAULT_MAX_SKILL_RESOURCE_FILES): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const excludedFiles = new Set(documentFiles);

  async function walk(currentDir: string, relativeDir: string = ''): Promise<void> {
    if (truncated) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (e) {
      logger.warn({ err: e, currentDir }, 'Failed to list skill resource directory');
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (truncated) return;
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (SKILL_RESOURCE_SKIP_DIRS.has(entry.name)) continue;
        await walk(absolutePath, relativePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (excludedFiles.has(relativePath)) continue;

      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(relativePath);
    }
  }

  await walk(skillDir);
  return { files, truncated };
}

async function isSkillDirectory(dir: string): Promise<boolean> {
  return await fs.pathExists(path.join(dir, 'SKILL.md'));
}

async function findParentSkillBoundary(baseDir: string, skillName: string): Promise<string | undefined> {
  const parts = skillName.split('/');
  let currentDir = baseDir;

  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = path.join(currentDir, parts[i]);
    if (await isSkillDirectory(currentDir)) {
      return parts.slice(0, i + 1).join('/');
    }
  }

  return undefined;
}

async function getSkillInfoFromRoot(skillName: string, root: SkillSearchRoot, options: SkillInfoBuildOptions = {}): Promise<SkillInfo> {
  const dir = getSkillDirFromRoot(root.baseDir, skillName);

  if (!await fs.pathExists(dir)) {
    throw new Error(`Skill "${skillName}" not found in ${formatSkillSourceLabel({ sourceType: root.sourceType, sourceAgentName: root.agentName })}.`);
  }

  const parentSkill = await findParentSkillBoundary(root.baseDir, skillName);
  if (parentSkill) {
    throw new Error(`Skill "${skillName}" is inside skill "${parentSkill}" and is treated as a bundled resource, not an independently loadable skill. Load "${parentSkill}" first, then read the referenced resource file if needed.`);
  }

  const { metadataPath, mainDocumentPath, metadata } = await resolveSkillMetadata(skillName, dir);
  const documentFiles = await listSkillDocumentFiles(dir, mainDocumentPath);
  const resources = options.includeResources
    ? await listSkillResourceFiles(dir, documentFiles)
    : { files: [], truncated: false };

  return {
    name: skillName,
    description: metadata.description,
    dir,
    metadataPath,
    mainDocumentPath,
    documentFiles,
    resourceFiles: resources.files,
    resourceFilesTruncated: resources.truncated,
    sourceType: root.sourceType,
    sourceAgentName: root.agentName,
  };
}

export async function getSkillInfo(skillName: string, options: SkillResolveOptions = {}): Promise<SkillInfo> {
  validateSkillName(skillName);

  const searchRoots = await getSkillSearchRoots(options.agentName || 'main');
  let lastError: Error | undefined;

  for (const root of searchRoots) {
    const dir = getSkillDirFromRoot(root.baseDir, skillName);
    if (!await fs.pathExists(dir)) {
      continue;
    }

    try {
      return await getSkillInfoFromRoot(skillName, root);
    } catch (e: any) {
      lastError = e;
      logger.warn({ err: e, skillName, sourceType: root.sourceType, sourceAgentName: root.agentName }, 'Skipping invalid skill during resolution');
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(
    `Skill "${skillName}" not found. Searched agent-local, inherited-agent, and global skill directories${options.agentName ? ` for agent "${options.agentName}"` : ''}.`
  );
}

/**
 * Recursively find all skill directories (containing SKILL.md).
 * A discovered skill directory is a boundary: nested SKILL.md files inside it
 * are treated as bundled resources of the parent skill, not independent skills.
 */
async function findSkillDirectories(baseDir: string, relativePath: string = ''): Promise<string[]> {
  const skillDirs: string[] = [];
  
  if (!await fs.pathExists(baseDir)) {
    return skillDirs;
  }

  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKILL_DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
    
    const entryPath = path.join(baseDir, entry.name);
    const skillName = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    
    // Check if this directory is a skill (has SKILL.md)
    if (await isSkillDirectory(entryPath)) {
      skillDirs.push(skillName);
      continue;
    }
    
    const nestedSkills = await findSkillDirectories(entryPath, skillName);
    skillDirs.push(...nestedSkills);
  }
  
  return skillDirs;
}

export async function listSkills(options: SkillResolveOptions = {}): Promise<SkillInfo[]> {
  const searchRoots = await getSkillSearchRoots(options.agentName || 'main');
  const skillsByName = new Map<string, SkillInfo>();

  for (const root of searchRoots) {
    const skillNames = await findSkillDirectories(root.baseDir);
    skillNames.sort((a, b) => a.localeCompare(b));

    for (const skillName of skillNames) {
      if (skillsByName.has(skillName)) {
        continue;
      }

      try {
        skillsByName.set(skillName, await getSkillInfoFromRoot(skillName, root));
      } catch (e) {
        logger.warn({ err: e, skillName, sourceType: root.sourceType, sourceAgentName: root.agentName }, 'Skipping invalid skill directory');
      }
    }
  }

  return [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSkillDocuments(skillName: string, options: SkillResolveOptions = {}): Promise<{ info: SkillInfo; documents: SkillDocument[] }> {
  validateSkillName(skillName);

  const searchRoots = await getSkillSearchRoots(options.agentName || 'main');
  let lastError: Error | undefined;

  let info: SkillInfo | undefined;
  for (const root of searchRoots) {
    const dir = getSkillDirFromRoot(root.baseDir, skillName);
    if (!await fs.pathExists(dir)) {
      continue;
    }

    try {
      info = await getSkillInfoFromRoot(skillName, root, { includeResources: true });
      break;
    } catch (e: any) {
      lastError = e;
      logger.warn({ err: e, skillName, sourceType: root.sourceType, sourceAgentName: root.agentName }, 'Skipping invalid skill during document loading');
    }
  }

  if (!info) {
    if (lastError) {
      throw lastError;
    }
    throw new Error(
      `Skill "${skillName}" not found. Searched agent-local, inherited-agent, and global skill directories${options.agentName ? ` for agent "${options.agentName}"` : ''}.`
    );
  }

  const documents: SkillDocument[] = [];

  for (const file of info.documentFiles) {
    const filePath = path.join(info.dir, file);
    const content = await fs.readFile(filePath, 'utf8');
    documents.push({ filePath, content });
  }

  return { info, documents };
}
