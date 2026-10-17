import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../common';
import { getAgentMemoryDir, MAIN_AGENT_MEMORY_DIR, getAgentDir, AGENTS_SYSTEM_PROMPT_PATH, resolveModelConfig, isVirtualModelConfigEntry, getModelIdForMetadata, type ModelsConfig } from '../config';
import type { Session } from '../types';
import { buildCurrentModelSnapshot, filterConditionalMemorySource, readCurrentModelSnapshotId } from '../conditionalMemory';
import { listSkills } from '../skills';
import { expandHomePath } from '../utils/pathResolve';
import { checkPathAccess } from '../utils/agentPathAccess';
import { getAgentInheritanceChain, isAgentIsolated } from './agentMetadata';

/**
 * Resolves a truthful concrete snapshot identity without selecting a virtual
 * route. Virtual sessions without a recorded generation identity defer until
 * an actual provider attempt selects a leaf.
 */
export function resolveSessionSnapshotModelId(session: Pick<Session, 'model' | 'persistentMemorySnapshot'>): string | undefined {
    const recordedModelId = readCurrentModelSnapshotId(session.persistentMemorySnapshot || '');
    if (recordedModelId) return recordedModelId;

    return resolveConcreteModelIdForSnapshot(session.model);
}

export function resolveConcreteModelIdForSnapshot(model?: string, modelsConfigOverride?: ModelsConfig): string | undefined {
    const resolved = modelsConfigOverride
        ? (() => {
            const currentKey = model && modelsConfigOverride.models[model] ? model : modelsConfigOverride.default;
            return { currentKey, modelEntry: modelsConfigOverride.models[currentKey] };
        })()
        : resolveModelConfig(model);
    if (!resolved.modelEntry || isVirtualModelConfigEntry(resolved.modelEntry)) return undefined;
    return getModelIdForMetadata(resolved.modelEntry, resolved.currentKey);
}

export async function buildSessionSystemPromptSnapshotForSession(
    session: Pick<Session, 'agent' | 'id' | 'model' | 'persistentMemorySnapshot' | 'systemPromptFiles'>,
): Promise<string | undefined> {
    const modelId = resolveSessionSnapshotModelId(session);
    if (!modelId) return undefined;
    return buildSessionSystemPromptSnapshot({
        agentName: session.agent || 'main',
        sessionId: session.id,
        systemPromptFiles: session.systemPromptFiles,
        modelId,
    });
}

function formatMemoryBlock(filePath: string, agentName: string, kind: 'self' | 'inherited', content: string): string {
    return `\n<memory_file agent=${agentName}; ownership=${kind}; path=${filePath}>\n${content}\n</memory_file>`;
}

function escapeXmlText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function normalizeSystemPromptFiles(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        const normalized = value
            .filter((entry): entry is string => typeof entry === 'string')
            .map(entry => entry.trim())
            .filter(entry => entry.length > 0);
        return normalized;
    }

    if (typeof value === 'string') {
        const normalized = value
            .split(/[,\n]/)
            .map(entry => entry.trim())
            .filter(entry => entry.length > 0 && !entry.startsWith('#'));
        return normalized;
    }

    return undefined;
}

function resolveSystemPromptFilePath(agentName: string, fileReference: string): string {
    const expandedPath = expandHomePath(fileReference);
    if (path.isAbsolute(expandedPath)) {
        return path.resolve(expandedPath);
    }

    return path.resolve(getAgentDir(agentName), expandedPath);
}

type MemoryFileFrontMatter = Record<string, unknown>;

function parseMemoryFileFrontMatter(content: string, filePath: string): { metadata: MemoryFileFrontMatter; body: string } {
    const match = content.match(/^---[ \t]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---[ \t]*(?:\r?\n|$)/);
    if (!match) {
        return { metadata: {}, body: content };
    }

    const body = content.slice(match[0].length);
    try {
        const parsed = yaml.load(match[1]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { metadata: {}, body };
        }
        return { metadata: parsed as MemoryFileFrontMatter, body };
    } catch (err) {
        logger.warn({ err, filePath }, 'Failed to parse memory file frontmatter; ignoring metadata and injecting body');
        return { metadata: {}, body };
    }
}

function normalizeSessionGlobList(value: unknown, key: string, filePath: string): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value === 'string') {
        return value.trim() ? [value.trim()] : [];
    }

    if (Array.isArray(value)) {
        const patterns: string[] = [];
        for (const entry of value) {
            if (typeof entry !== 'string') {
                logger.warn({ filePath, key }, 'Invalid memory file frontmatter session glob entry; ignoring metadata key');
                return undefined;
            }
            const trimmed = entry.trim();
            if (trimmed) {
                patterns.push(trimmed);
            }
        }
        return patterns;
    }

    logger.warn({ filePath, key }, 'Invalid memory file frontmatter session glob value; ignoring metadata key');
    return undefined;
}

function escapeRegExpChar(ch: string): string {
    return /[\\^$+?.()|{}\[\]]/.test(ch) ? `\\${ch}` : ch;
}

function globMatchesSessionId(pattern: string, sessionId?: string): boolean {
    if (!sessionId) {
        return false;
    }

    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                while (pattern[i + 1] === '*') i++;
                regex += '.*';
            } else {
                regex += '[^/]*';
            }
        } else if (ch === '?') {
            regex += '[^/]';
        } else {
            regex += escapeRegExpChar(ch);
        }
    }
    regex += '$';
    return new RegExp(regex).test(sessionId);
}

function shouldInjectMemoryFileForSession(metadata: MemoryFileFrontMatter, filePath: string, sessionId?: string): boolean {
    const includeSession = normalizeSessionGlobList(metadata['include-session'], 'include-session', filePath);
    const excludeSession = normalizeSessionGlobList(metadata['exclude-session'], 'exclude-session', filePath);

    if (excludeSession?.some(pattern => globMatchesSessionId(pattern, sessionId))) {
        return false;
    }

    if (includeSession !== undefined) {
        return includeSession.some(pattern => globMatchesSessionId(pattern, sessionId));
    }

    return true;
}

async function readSessionFilteredMemoryFile(filePath: string, sessionId: string | undefined, modelId: string): Promise<string | null> {
    const content = await fs.readFile(filePath, 'utf8');
    const { metadata, body } = parseMemoryFileFrontMatter(content, filePath);
    return shouldInjectMemoryFileForSession(metadata, filePath, sessionId)
        ? filterConditionalMemorySource(body, modelId)
        : null;
}

async function appendConfiguredMemoryFiles(agentName: string, systemPromptFiles: string[], modelId: string, sessionId?: string): Promise<string> {
    let combined = '';
    const restrictToAgentDir = isAgentIsolated(agentName);

    for (const fileReference of systemPromptFiles) {
        const filePath = resolveSystemPromptFilePath(agentName, fileReference);
        if (restrictToAgentDir) {
            checkPathAccess(filePath, agentName);
        }
        if (!await fs.pathExists(filePath)) {
            throw new Error(`systemPromptFiles entry \`${fileReference}\` not found for agent \`${agentName}\`.`);
        }

        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
            throw new Error(`systemPromptFiles entry \`${fileReference}\` is not a file.`);
        }

        const content = await readSessionFilteredMemoryFile(filePath, sessionId, modelId);
        if (content !== null) {
            combined += formatMemoryBlock(filePath, agentName, 'self', content);
        }
    }

    return combined;
}

async function appendSkillCatalogForAgent(agentName: string): Promise<string> {
    const visibleSkills = await listSkills({ agentName });
    if (visibleSkills.length === 0) {
        return '';
    }

    let combined = '';
    combined += 'The following skills provide specialized instructions for specific tasks.\n';
    combined += 'When a task matches a skill\'s description, call skill with action="load"\n';
    combined += 'and the skill\'s name to load its full instructions and resource list.\n';
    combined += 'Read listed resources only when the loaded skill or current task needs them:\n';
    combined += '<available_skills>\n';

    for (const skill of visibleSkills) {
        combined += '  <skill>';
        combined += `<name>${escapeXmlText(skill.name)}</name>`;
        combined += `<description>${escapeXmlText(skill.description || '')}</description>`;
        combined += `<source>${escapeXmlText(skill.sourceType)}</source>`;
        combined += '</skill>\n';
    }

    combined += '</available_skills>\n';
    return combined;
}

async function appendDefaultMemoryFiles(agentName: string, modelId: string, sessionId?: string): Promise<string> {
    const mainMemoryDir = MAIN_AGENT_MEMORY_DIR;
    let combined = '';

    if (await fs.pathExists(AGENTS_SYSTEM_PROMPT_PATH)) {
        const content = filterConditionalMemorySource(await fs.readFile(AGENTS_SYSTEM_PROMPT_PATH, 'utf8'), modelId);
        combined += formatMemoryBlock(AGENTS_SYSTEM_PROMPT_PATH, 'framework', 'inherited', content);
    } else {
        const mainSystemPath = path.join(mainMemoryDir, '00_SYSTEM.md');
        if (await fs.pathExists(mainSystemPath)) {
            const content = filterConditionalMemorySource(await fs.readFile(mainSystemPath, 'utf8'), modelId);
            const kind = agentName === 'main' ? 'self' : 'inherited';
            combined += formatMemoryBlock(mainSystemPath, 'main', kind, content);
        }
    }

    const inheritChain = getAgentInheritanceChain(agentName);
    for (const inheritedAgentName of inheritChain) {
        const kind = inheritedAgentName === agentName ? 'self' : 'inherited';
        combined += await appendMemoryFilesForAgent(inheritedAgentName, kind, modelId, sessionId);
    }

    return combined;
}

export async function buildSessionSystemPromptSnapshot(options: {
    agentName?: string;
    sessionId?: string;
    systemPromptFiles?: string[] | string;
    modelId: string;
}): Promise<string> {
    const agentName = options.agentName || 'main';
    const sessionId = options.sessionId;
    const normalizedSystemPromptFiles = normalizeSystemPromptFiles(options.systemPromptFiles);
    const hasCustomMemorySources = options.systemPromptFiles !== undefined;

    const memoryBlocks = hasCustomMemorySources
        ? await appendConfiguredMemoryFiles(agentName, normalizedSystemPromptFiles || [], options.modelId, sessionId)
        : await appendDefaultMemoryFiles(agentName, options.modelId, sessionId);
    const skillCatalog = await appendSkillCatalogForAgent(agentName);
    const dirInfo = '\n\n--- DIRECTORIES ---\n- agent_folder: ' + getAgentDir(agentName) + '\n';
    const archiveInfo = [
        '',
        '',
        '--- EARLIER CONTEXT RECALL ---',
        '- Long sessions use layered context: older conversation is archived and may be compacted into CTX-BLOCK summaries to keep the active prompt small.',
        '- Compaction is system-initiated: Foxwarm forks a temporary compact thread to generate summary blocks, then the main session gets a `<foxwarm-system kind="session-boundary" event="compact-completed" ... />` identity notice and continues the agent task.',
        '- Block levels are hierarchical: lower/newer blocks are closer to raw messages; higher/older blocks are coarser summaries. Drill down step by step with `recall`.',
        '- Use `recall({"target":"overview"})` for archived ranges/examples, and `recall({"target":"B#123"})` for a CTX-BLOCK; use `msg:B#123` or `msg#100-120` only when you need raw detail.',
        '- Compaction/recall preserves traceable session history; it is not agent memory. Do not write routine process notes, temporary progress, or completed details to memory just to preserve context.',
        '- Use memory files only for long-lived stable rules, preferences, environment facts, and confirmed design decisions.',
        '- If you need lower-level archive helpers, use `search_tools(...)` and then `call_tool(...)`.',
        '',
    ].join('\n');
    const body = [memoryBlocks.trim(), skillCatalog.trim(), `${dirInfo}${archiveInfo}`.trim()]
        .filter(Boolean)
        .join('\n\n');
    return buildCurrentModelSnapshot(options.modelId, body);
}

async function appendMemoryFilesForAgent(agentName: string, kind: 'self' | 'inherited', modelId: string, sessionId?: string): Promise<string> {
    const agentMemoryDir = getAgentMemoryDir(agentName);
    if (!await fs.pathExists(agentMemoryDir)) {
        return '';
    }

    const files = await fs.readdir(agentMemoryDir);
    const mdFiles = files.sort().filter(f => f.endsWith('.md') && f !== '00_SYSTEM.md');
    let combined = '';

    for (const file of mdFiles) {
        // ONBOOT.md is a retired startup trigger. Keep legacy files out of
        // model memory so deleting its producer does not change old installs.
        if (file.toLowerCase() === 'onboot.md') continue;
        const filePath = path.join(agentMemoryDir, file);
        const content = await readSessionFilteredMemoryFile(filePath, sessionId, modelId);
        if (content !== null) {
            combined += formatMemoryBlock(filePath, agentName, kind, content);
        }
    }

    return combined;
}
