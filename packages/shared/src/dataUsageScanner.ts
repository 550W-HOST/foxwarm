import fs from 'node:fs/promises';
import path from 'node:path';
import type { DataCategory, DataUsageReport, DataUsageState, DataWorkspace } from './dataUsage';
export interface DataUsageRoots { state: string; agents: string; data?: string; singleAgent?: string }
const within = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
/** Async metadata-only walk: bounded work, no symlink traversal or external cwd discovery. */
export async function scanDataUsage(roots: DataUsageRoots, options: { maxEntries?: number; maxMs?: number } = {}): Promise<DataUsageReport> {
  const started = Date.now(), deadline = started + (options.maxMs ?? 40000), limit = options.maxEntries ?? 2000000;
  const report: DataUsageReport = { measuredAt: started, totalBytes:0, files:0, partial:false, skipped:0, measurement:'allocated', categories:{runtime:0,workspaces:0,assets:0,temporary:0},workspaces:[] };
  const normalize = async (p: string) => { try { return await fs.realpath(p); } catch { return path.resolve(p); } };
  const state = await normalize(roots.state), agents = await normalize(roots.agents), data = roots.data ? await normalize(roots.data) : undefined;
  const agentRoots = [...new Set([agents, ...(data && !roots.singleAgent ? [await normalize(path.join(data,'agents'))] : [])])].sort((a,b)=>b.length-a.length);
  const pending = [...new Set([...agentRoots,state,...(data?[data]:[])])].filter((p,_,a)=>!a.some(other=>other!==p && within(p,other)));
  const seen = new Set<string>(), workspaces = new Map<string, DataWorkspace>();
  let visited = 0, allocated = false, logical = false;
  while (pending.length) {
    if (visited >= limit || Date.now() >= deadline) { report.partial=true; break; }
    const current = pending.pop()!;
    try {
      const st = await fs.lstat(current); visited++;
      if (st.isSymbolicLink()) continue;
      const inode = `${st.dev}:${st.ino}`;
      if (st.ino && seen.has(inode)) continue;
      if (st.ino) seen.add(inode);
      if (st.isDirectory()) {
        const dir = await fs.opendir(current);
        try { for await (const entry of dir) { if (pending.length + visited >= limit || Date.now() >= deadline) { report.partial=true; break; } pending.push(path.join(current,entry.name)); } }
        finally { await dir.close().catch(()=>{}); }
        continue;
      }
      if (!st.isFile()) continue;
      const bytes = typeof st.blocks === 'number' && process.platform !== 'win32' ? st.blocks * 512 : st.size;
      if (typeof st.blocks === 'number' && process.platform !== 'win32') allocated=true; else logical=true;
      let category: DataCategory = 'runtime';
      const agentRoot = agentRoots.find(a=>within(current,a) && (!within(current,state) || a.length>state.length));
      const inAgents = !!agentRoot, relative = path.relative(agentRoot || (within(current,state)?state:data||state),current), parts = relative.split(path.sep);
      const ownedParts = inAgents ? parts.slice(roots.singleAgent ? 0 : 1) : parts;
      const asset = inAgents ? ownedParts[0] === '.temp' && ownedParts[1] === 'channel-files' : ['artifacts','image-blobs','sessions-blob','attachments'].includes(parts[0]);
      const temporary = ['.temp','tmp','.cache','cache'].includes(ownedParts[0]);
      category = asset ? 'assets' : temporary ? 'temporary' : inAgents && (roots.singleAgent || parts.length > 1 && !parts[0].startsWith('.')) ? 'workspaces' : 'runtime';
      report.totalBytes += bytes; report.files++; report.categories[category] += bytes;
      if (category === 'workspaces') {
        const name = roots.singleAgent || parts[0], workspacePath = roots.singleAgent ? agents : path.join(agentRoot!,name);
        const key = workspaces.size >= 300 && !workspaces.has(workspacePath) ? '(Other workspaces)' : workspacePath;
        let w = workspaces.get(key);
        if (!w) { w={name:key===workspacePath?name:key,path:key===workspacePath?workspacePath:agents,bytes:0,children:[]};workspaces.set(key,w); }
        w.bytes += bytes;
        const childName = parts[roots.singleAgent ? 0 : 1];
        const childKey = w.children.length >= 40 && !w.children.some(c=>c.name===childName) ? '(Other entries)' : childName;
        let child = w.children.find(c=>c.name===childKey);
        if (!child) { child={name:childKey,path:childKey===childName?path.join(workspacePath,childName):workspacePath,bytes:0};w.children.push(child); }
        child.bytes += bytes;
      }
    } catch (error: any) { if (error.code !== 'ENOENT') { report.skipped++;report.partial=true; } }
  }
  report.measuredAt=Date.now();report.measurement=allocated && logical?'mixed':logical?'logical':'allocated';
  report.workspaces=[...workspaces.values()].sort((a,b)=>b.bytes-a.bytes);
  for (const w of report.workspaces) w.children.sort((a,b)=>b.bytes-a.bytes);
  return report;
}
/** One scan at a time. Reads are cheap; refresh is throttled independently of UI polling. */
export class DataUsageSampler {
  private report?: DataUsageReport;
  private running = false;
  private failed = false;
  private lastAttempt = 0;
  constructor(private roots: DataUsageRoots, private scan = scanDataUsage) {}
  read(refresh=false): DataUsageState {
    if (!this.running && Date.now()-this.lastAttempt > (refresh?30000:300000)) {
      this.running=true;this.failed=false;this.lastAttempt=Date.now();
      void this.scan(this.roots).then(r=>{this.report=r;},()=>{this.failed=true;}).finally(()=>{this.running=false;});
    }
    return { status:this.running?'scanning':this.failed?'error':'ready', ...(this.report?{report:this.report}:{}) };
  }
}
