import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from './common';
import { AGENTS_FILE, getAgentDir, SKILLS_DIR } from './config';

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
  documentFiles: string[];
  sourceType: 'agent-local' | 'agent-inherited' | 'global';
  sourceAgentName?: string;
}

export interface SkillDocument {
  filePath: string;
  content: string;
}

type ParsedMarkdownMetadata = {
  metadata: SkillManifest;
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

type AgentMetadataSnapshot = {
  inherit?: string;
  [key: string]: any;
};

const NON_SKILL_DISCOVERY_DIRS = new Set([
  '.git',
  'assets',
  'build',
  'dist',
  'docs',
  'evals',
  'memory',
  'node_modules',
  'references',
  'scripts',
  'shared',
]);

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

async function readSkillManifest(skillDir: string): Promise<{ manifestPath: string; manifest: SkillManifest }> {
  const manifestPath = path.join(skillDir, 'skill.json');
  if (!await fs.pathExists(manifestPath)) {
    throw new Error(`Skill manifest not found in "${skillDir}".`);
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

async function resolveSkillMetadata(skillName: string, skillDir: string): Promise<{
  metadataPath: string;
  mainDocumentPath?: string;
  manifestPath?: string;
  manifest: SkillManifest;
}> {
  const markdownCandidates = [
    path.join(skillDir, 'SKILL.md'),
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
    const manifestInfo = await readSkillManifest(skillDir);
    manifestPath = manifestInfo.manifestPath;
    jsonManifest = manifestInfo.manifest;
  } catch (e: any) {
    if (!e.message?.includes('Skill manifest not found')) {
      throw e;
    }
  }

  if (!markdownPath && !manifestPath) {
    throw new Error(
      `Skill "${skillName}" not found. Expected one of: ${path.join(skillDir, 'SKILL.md')}, ${path.join(skillDir, 'skill.json')}.`
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

async function listSkillDocumentFiles(skillDir: string, mainDocumentPath?: string): Promise<string[]> {
  const files: string[] = [];

  if (mainDocumentPath) {
    files.push(path.relative(skillDir, mainDocumentPath));
  }

  return files;
}

async function getSkillInfoFromRoot(skillName: string, root: SkillSearchRoot): Promise<SkillInfo> {
  const dir = getSkillDirFromRoot(root.baseDir, skillName);

  if (!await fs.pathExists(dir)) {
    throw new Error(`Skill "${skillName}" not found in ${formatSkillSourceLabel({ sourceType: root.sourceType, sourceAgentName: root.agentName })}.`);
  }

  const { metadataPath, mainDocumentPath, manifestPath, manifest } = await resolveSkillMetadata(skillName, dir);
  const documentFiles = await listSkillDocumentFiles(dir, mainDocumentPath);

  return {
    name: skillName,
    description: manifest.description,
    dir,
    metadataPath,
    mainDocumentPath,
    manifestPath,
    documentFiles,
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
 * Recursively find all skill directories (containing SKILL.md or skill.json)
 */
async function findSkillDirectories(baseDir: string, relativePath: string = '', insideSkill: boolean = false): Promise<string[]> {
  const skillDirs: string[] = [];
  
  if (!await fs.pathExists(baseDir)) {
    return skillDirs;
  }

  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'memory') continue;
    // These are common companion/resource directories inside a skill. They may
    // contain examples or docs with SKILL.md files, but the current skill format
    // is SKILL.md-first: companion material must be linked explicitly from the
    // parent SKILL.md and is not auto-discovered as a nested skill.
    if (insideSkill && NON_SKILL_DISCOVERY_DIRS.has(entry.name)) continue;
    
    const entryPath = path.join(baseDir, entry.name);
    const skillName = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    
    // Check if this directory is a skill (has SKILL.md or skill.json)
    const hasSkillMd = await fs.pathExists(path.join(entryPath, 'SKILL.md'));
    const hasSkillJson = await fs.pathExists(path.join(entryPath, 'skill.json'));
    
    if (hasSkillMd || hasSkillJson) {
      skillDirs.push(skillName);
    }
    
    // Always recurse into subdirectories to find nested skills
    const nestedSkills = await findSkillDirectories(entryPath, skillName, insideSkill || hasSkillMd || hasSkillJson);
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
  const info = await getSkillInfo(skillName, options);
  const documents: SkillDocument[] = [];

  for (const file of info.documentFiles) {
    const filePath = path.join(info.dir, file);
    const content = await fs.readFile(filePath, 'utf8');
    documents.push({ filePath, content });
  }

  return { info, documents };
}
