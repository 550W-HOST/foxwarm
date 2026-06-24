import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { applyUpdatePatch, buildAddedFileContent, parseApplyPatchInput } from './applyPatch';
import { getNodeAgentDir, resolveNodePath } from './nodeFileTransfer';
import { readFileToolPath, writeFileToolPath } from './fileToolCore';
import { PersistentExecManager, DEFAULT_EXEC_TIMEOUT_SECONDS, MIN_EXEC_TIMEOUT_SECONDS, MAX_EXEC_TIMEOUT_SECONDS, type ExecStatus, type RunningExecEntry } from './persistentExec';

export interface NodeToolContext {
  sessionId?: string;
  session?: { agent?: string; cwd?: string; currentNode?: string };
  runtimeNodeId?: string;
  broadcast?: (text: string) => Promise<void>;
  queueSystemEvent?: (message: string, type?: 'background' | 'trigger' | 'onboot') => Promise<void>;
}

type ToolArgs = Record<string, any>;
const INLINE_OUTPUT_LIMIT = 10_000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyExactReplacement(content: string, searchText: string, replaceText: string, label: string): string {
  if (!content.includes(searchText)) throw new Error(`Could not find ${label} in file. Make sure whitespace matches exactly.`);
  const regex = new RegExp(escapeRegExp(searchText), 'g');
  const matches = content.match(regex);
  if (matches && matches.length > 1) throw new Error(`Found ${matches.length} occurrences of ${label} in file. Edit tool only replaces once. Please make ${label} more specific to match exactly one location.`);
  return content.replace(regex, replaceText);
}

function resolveToolPath(filePath: string, ctx: NodeToolContext): string {
  return resolveNodePath(filePath, ctx.session?.agent || 'main', ctx.session?.cwd);
}

export async function read(args: ToolArgs, ctx: NodeToolContext = {}) {
  const { filePath, startLine, endLine } = args;
  return readFileToolPath(resolveToolPath(filePath, ctx), filePath, startLine, endLine);
}

export async function write(args: ToolArgs, ctx: NodeToolContext = {}) {
  const { filePath, content, overwrite } = args;
  if (typeof content !== 'string') throw new Error('write requires string content');
  const fullPath = resolveToolPath(filePath, ctx);
  await writeFileToolPath(fullPath, content, {
    overwrite: overwrite === true,
    existsMessage: `File already exists: ${filePath}. Use overwrite=true to overwrite, or use edit tool to modify existing file.`,
    createDirs: args.createDirs === true,
  });
  return 'File written successfully';
}

export async function edit(args: ToolArgs, ctx: NodeToolContext = {}) {
  const { filePath, oldText, newText } = args;
  if (typeof oldText !== 'string' || typeof newText !== 'string') throw new Error('Edit tool requires oldText and newText. Use apply_patch for patch-style edits.');
  const fullPath = resolveToolPath(filePath, ctx);
  const content = await fs.readFile(fullPath, 'utf8');
  await fs.writeFile(fullPath, applyExactReplacement(content, oldText, newText, 'oldText'));
  return 'File edited successfully';
}

async function applyPatchOperations(input: string, resolveOperationPath: (filePath: string) => { fullPath: string; displayPath: string }): Promise<string> {
  const operations = parseApplyPatchInput(input);
  const summaries: string[] = [];
  for (let idx = 0; idx < operations.length; idx++) {
    const operation = operations[idx];
    const { fullPath, displayPath } = resolveOperationPath(operation.filePath);
    try {
      if (operation.action === 'update') {
        if (!await fs.pathExists(fullPath)) throw new Error(`Cannot update missing file: ${displayPath}`);
        const content = await fs.readFile(fullPath, 'utf8');
        await fs.writeFile(fullPath, applyUpdatePatch(content, operation.lines, displayPath));
        summaries.push(`Updated ${displayPath}`);
      } else if (operation.action === 'add') {
        if (await fs.pathExists(fullPath)) throw new Error(`Cannot add file that already exists: ${displayPath}`);
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, buildAddedFileContent(operation.lines));
        summaries.push(`Added ${displayPath}`);
      } else {
        if (!await fs.pathExists(fullPath)) throw new Error(`Cannot delete missing file: ${displayPath}`);
        await fs.remove(fullPath);
        summaries.push(`Deleted ${displayPath}`);
      }
    } catch (err) {
      const succeeded = summaries.length > 0
        ? `\nOperations already applied (these changes are already on disk):\n${summaries.map(line => `- ${line}`).join('\n')}\n`
        : '';
      const remaining = operations.length - idx - 1;
      const remainingHint = remaining > 0 ? `\n${remaining} remaining operation(s) were not applied.` : '';
      throw new Error(`${(err as Error).message}${succeeded}${remainingHint}`);
    }
  }
  return `Patch applied successfully.\n${summaries.map(line => `- ${line}`).join('\n')}`;
}

export async function apply_patch(args: ToolArgs, ctx: NodeToolContext = {}) {
  if (!args.input || typeof args.input !== 'string') throw new Error('apply_patch requires input string.');
  return applyPatchOperations(args.input, filePath => ({ fullPath: resolveToolPath(filePath, ctx), displayPath: filePath }));
}

function resolveExecTimeoutSeconds(timeoutValue: unknown): number {
  if (timeoutValue === undefined || timeoutValue === null) return DEFAULT_EXEC_TIMEOUT_SECONDS;
  if (typeof timeoutValue !== 'number' || !Number.isFinite(timeoutValue) || timeoutValue < MIN_EXEC_TIMEOUT_SECONDS || timeoutValue > MAX_EXEC_TIMEOUT_SECONDS) {
    throw new Error(`timeout must be a number between ${MIN_EXEC_TIMEOUT_SECONDS} and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutValue;
}

const sessionEventDispatchers = new Map<string, NonNullable<NodeToolContext['queueSystemEvent']>>();
const execManagers = new Map<string, PersistentExecManager>();

function getExecManager(agentName: string): PersistentExecManager {
  const existing = execManagers.get(agentName);
  if (existing) return existing;
  const execTempDir = path.join(getNodeAgentDir(agentName), '.temp', 'exec');
  const manager = new PersistentExecManager({
    getDefaultCwd: () => process.cwd(),
    getExecTempDir: () => execTempDir,
    registryPath: path.join(execTempDir, 'running-exec.json'),
    nodeId: process.env.FOXWARM_NODE_ID || 'remote-node',
    completionDispatcher: async (entry: RunningExecEntry, _status: ExecStatus, message: string) => {
      const dispatcher = entry.sessionId ? sessionEventDispatchers.get(entry.sessionId) : undefined;
      if (dispatcher) await dispatcher(message, 'background');
    },
  });
  execManagers.set(agentName, manager);
  return manager;
}

export async function get_default_cwd() {
  return process.cwd();
}

export async function exec(args: ToolArgs, ctx: NodeToolContext = {}) {
  const command = String(args.command || '');
  if (!command.trim()) throw new Error('exec requires command');
  const timeoutSeconds = resolveExecTimeoutSeconds(args.timeout);
  const agentName = ctx.session?.agent || 'main';
  if (ctx.sessionId && ctx.queueSystemEvent) sessionEventDispatchers.set(ctx.sessionId, ctx.queueSystemEvent);
  const manager = getExecManager(agentName);
  await manager.initialize();
  const entry = await manager.startPersistentExec({
    command,
    sessionId: ctx.sessionId,
    agentName,
    nodeId: ctx.runtimeNodeId || ctx.session?.currentNode || process.env.FOXWARM_NODE_ID || 'remote-node',
    cwd: args.cwd,
    sessionCwd: ctx.session?.cwd,
  });
  const status = await manager.waitForExecCompletion(entry.id, timeoutSeconds * 1000);
  if (status) {
    try {
      return await manager.buildForegroundExecResult(entry, status);
    } finally {
      await manager.finalizeForegroundExec(entry.id);
    }
  }
  await manager.markExecForBackgroundNotification(entry.id);
  return await manager.buildBackgroundTimeoutResult(entry, timeoutSeconds);
}

class SharedBrowserManager {
  private browser: any = null;
  private tabs = new Map<string, { page: any; url: string; title: string }>();

  private async ensureBrowser() {
    if (this.browser) return this.browser;
    const puppeteer = await import('puppeteer-core');
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '/usr/bin/chromium-browser';
    this.browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    return this.browser;
  }

  async open(url: string) {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const id = `tab_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const title = await page.title();
    this.tabs.set(id, { page, url, title });
    return { tabId: id, url, title };
  }

  async list() { return Array.from(this.tabs.entries()).map(([id, tab]) => ({ id, url: tab.url, title: tab.title })); }

  async get(id: string, screenshot?: boolean | string) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Tab ${id} not found`);
    tab.url = tab.page.url();
    tab.title = await tab.page.title();
    if (screenshot) {
      const buffer = await tab.page.screenshot({ fullPage: screenshot === 'full' });
      return { id, url: tab.url, title: tab.title, screenshot: buffer.toString('base64'), mimeType: 'image/png' };
    }
    return { id, url: tab.url, title: tab.title, content: await tab.page.content() };
  }

  async close(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Tab ${id} not found`);
    await tab.page.close();
    this.tabs.delete(id);
    return `Tab ${id} closed`;
  }

  async interact(id: string, action: string, params: any = {}) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Tab ${id} not found`);
    switch (action) {
      case 'click': await tab.page.click(params.selector); await tab.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {}); return `Clicked: ${params.selector}`;
      case 'type': await tab.page.type(params.selector, params.text); return `Typed into ${params.selector}`;
      case 'fill': await tab.page.evaluate((selector: string, text: string) => { const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null; if (!el) throw new Error(`Selector not found: ${selector}`); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }, params.selector, params.text); return `Filled ${params.selector}`;
      case 'press': await tab.page.keyboard.press(params.key); return `Pressed key: ${params.key}`;
      case 'scroll': await tab.page.evaluate((y: number) => window.scrollBy(0, y), params.y || 0); return `Scrolled by ${params.y || 0}px`;
      case 'wait': await tab.page.waitForSelector(params.selector, { timeout: params.timeout || 5000 }); return `Waited for: ${params.selector}`;
      case 'evaluate': return `Evaluated: ${JSON.stringify(await tab.page.evaluate(params.code))}`;
      case 'goto': await tab.page.goto(params.url, { waitUntil: 'networkidle2', timeout: 30000 }); tab.url = params.url; tab.title = await tab.page.title(); return `Navigated to: ${params.url}\nTitle: ${tab.title}`;
      case 'back': await tab.page.goBack({ waitUntil: 'networkidle2' }); return 'Navigated back';
      case 'forward': await tab.page.goForward({ waitUntil: 'networkidle2' }); return 'Navigated forward';
      case 'reload': await tab.page.reload({ waitUntil: 'networkidle2' }); return 'Page reloaded';
      default: throw new Error(`Unknown action: ${action}`);
    }
  }
}

const browser = new SharedBrowserManager();
export async function browse_open(args: ToolArgs) { return browser.open(String(args.url || '')); }
export async function browse_list() { return browser.list(); }
export async function browse_get(args: ToolArgs) { return browser.get(String(args.tabId || ''), args.screenshot); }
export async function browse_close(args: ToolArgs) { return browser.close(String(args.tabId || '')); }
export async function browse_interact(args: ToolArgs) { return browser.interact(String(args.tabId || ''), String(args.action || ''), args.params || {}); }

export const nodeTools = { read, write, edit, apply_patch, exec, get_default_cwd, browse_open, browse_list, browse_get, browse_close, browse_interact };
