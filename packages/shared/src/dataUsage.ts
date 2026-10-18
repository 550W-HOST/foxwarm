/** Display-only storage accounting. No path supplied by a browser becomes a scan root. */
export type DataCategory = 'runtime' | 'workspaces' | 'assets' | 'temporary';
export interface DataUsageItem { name: string; path: string; bytes: number }
export interface DataWorkspace extends DataUsageItem { children: DataUsageItem[] }
export interface DataUsageReport {
  measuredAt: number; totalBytes: number; files: number; partial: boolean; skipped: number;
  measurement: 'allocated' | 'logical' | 'mixed';
  categories: Record<DataCategory, number>; workspaces: DataWorkspace[];
}
export interface DataUsageState { status: 'ready' | 'scanning' | 'offline' | 'unsupported' | 'error'; report?: DataUsageReport }
export function parseDataUsageState(value: unknown): DataUsageState | undefined {
  const v = value as DataUsageState;
  if (!v || !['ready','scanning','offline','unsupported','error'].includes(v.status)) return;
  if (!v.report) return { status: v.status };
  const r = v.report, size = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  const item = (x: DataUsageItem) => x && typeof x.name === 'string' && x.name.length <= 256 && typeof x.path === 'string' && x.path.length <= 4096 && size(x.bytes);
  if (!size(r.totalBytes) || !size(r.measuredAt) || !size(r.files) || !size(r.skipped) || typeof r.partial !== 'boolean'
    || !['allocated','logical','mixed'].includes(r.measurement) || !r.categories || !['runtime','workspaces','assets','temporary'].every(k => size(r.categories[k as DataCategory]))
    || Object.values(r.categories).reduce((a,b)=>a+b,0) !== r.totalBytes || !Array.isArray(r.workspaces) || r.workspaces.length > 301
    || !r.workspaces.every(w => item(w) && Array.isArray(w.children) && w.children.length <= 41 && w.children.every(item) && w.children.reduce((n,c)=>n+c.bytes,0) === w.bytes) || r.workspaces.reduce((n,w)=>n+w.bytes,0) !== r.categories.workspaces) return;
  return { status: v.status, report: {measuredAt:r.measuredAt,totalBytes:r.totalBytes,files:r.files,partial:r.partial,skipped:r.skipped,measurement:r.measurement, categories: { runtime:r.categories.runtime, workspaces:r.categories.workspaces, assets:r.categories.assets, temporary:r.categories.temporary }, workspaces: r.workspaces.map(w=>({name:w.name,path:w.path,bytes:w.bytes,children:w.children.map(c=>({name:c.name,path:c.path,bytes:c.bytes}))})) } };
}
