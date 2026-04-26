import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';
import { applyUpdatePatch, buildAddedFileContent, parseApplyPatchInput } from './applyPatch';
import { detectTransferMimeType, resolveNodePath } from './nodeFileTransfer';

export interface NodeToolContext {
  sessionId?: string;
  session?: { agent?: string; cwd?: string; currentNode?: string };
  runtimeNodeId?: string;
  broadcast?: (text: string) => Promise<void>;
  queueSystemEvent?: (message: string, type?: 'background' | 'trigger' | 'onboot') => Promise<void>;
}

type ToolArgs = Record<string, any>;
const DEFAULT_EXEC_TIMEOUT_SECONDS = 15;
const MIN_EXEC_TIMEOUT_SECONDS = 1;
const MAX_EXEC_TIMEOUT_SECONDS = 60;
const INLINE_OUTPUT_LIMIT = 10_000;
const BACKGROUND_OUTPUT_LIMIT = 20_000;

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

async function readResolvedPath(fullPath: string, displayPath: string, startLine?: number, endLine?: number) {
  const ext = path.extname(fullPath).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  if (imageExts.includes(ext)) {
    const buffer = await fs.readFile(fullPath);
    const { mimeType } = detectTransferMimeType(fullPath);
    return { output: `[Image loaded: ${displayPath}]`, mimeType, sizeBytes: buffer.length, inlineData: { data: buffer.toString('base64'), mimeType } };
  }
  let content = await fs.readFile(fullPath, 'utf8');
  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split('\n');
    const start = startLine !== undefined ? Math.max(0, Number(startLine) - 1) : 0;
    const end = endLine !== undefined ? Math.min(lines.length, Number(endLine)) : lines.length;
    content = lines.slice(start, end).join('\n');
  }
  return content;
}

export async function read(args: ToolArgs, ctx: NodeToolContext = {}) {
  const { filePath, startLine, endLine } = args;
  return readResolvedPath(resolveToolPath(filePath, ctx), filePath, startLine, endLine);
}

export async function write(args: ToolArgs, ctx: NodeToolContext = {}) {
  const { filePath, content, overwrite } = args;
  if (typeof content !== 'string') throw new Error('write requires string content');
  const fullPath = resolveToolPath(filePath, ctx);
  const exists = await fs.pathExists(fullPath);
  if (exists && overwrite !== true) throw new Error(`File already exists: ${filePath}. Use overwrite=true to overwrite, or use edit tool to modify existing file.`);
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, content);
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
  for (const operation of operations) {
    const { fullPath, displayPath } = resolveOperationPath(operation.filePath);
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

function truncateOutput(output: string, limit: number): string {
  if (output.length <= limit) return output;
  const half = Math.floor(limit / 2);
  return `${output.slice(0, half)}\n\n[...truncated ${output.length - limit} chars...]\n\n${output.slice(-half)}`;
}

function formatExecResult(code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string): string {
  const sections: string[] = [];
  if (stdout) sections.push(stdout.trimEnd());
  if (stderr) sections.push(`[stderr]\n${stderr.trimEnd()}`);
  sections.push(`\n[exit ${code === null ? `signal ${signal || 'unknown'}` : code}]`);
  return truncateOutput(sections.filter(Boolean).join('\n'), INLINE_OUTPUT_LIMIT);
}

export async function exec(args: ToolArgs, ctx: NodeToolContext = {}) {
  const command = String(args.command || '');
  if (!command.trim()) throw new Error('exec requires command');
  const timeoutSeconds = resolveExecTimeoutSeconds(args.timeout);
  const cwd = typeof args.cwd === 'string' && args.cwd.trim()
    ? (path.isAbsolute(args.cwd.trim()) ? args.cwd.trim() : path.resolve(ctx.session?.cwd || process.cwd(), args.cwd.trim()))
    : (ctx.session?.cwd || process.cwd());
  const id = `exec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  return await new Promise<string>((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => {
      if (!settled) {
        settled = true;
        resolve(`[${id}] failed to start: ${err.message}`);
      }
    });
    child.on('close', (code, signal) => {
      const result = formatExecResult(code, signal, stdout, stderr);
      if (settled) {
        void ctx.queueSystemEvent?.(`[${id}] completed in background:\n${truncateOutput(result, BACKGROUND_OUTPUT_LIMIT)}`, 'background');
        return;
      }
      settled = true;
      resolve(result);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(`[Process running longer than ${timeoutSeconds}s] Switched to background. The system will send a notification message when done. STOP calling tools to check status. Wait for notification (unless working on other tasks in parallel).\nexecId: ${id}`);
    }, timeoutSeconds * 1000).unref?.();
  });
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

export const nodeTools = { read, write, edit, apply_patch, exec, browse_open, browse_list, browse_get, browse_close, browse_interact };
