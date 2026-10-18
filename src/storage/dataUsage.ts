import type express from 'express';
import { STATE_DIR, AGENTS_DIR } from '../config';
import { DataUsageSampler } from '../../packages/shared/dist/dataUsageScanner';
import { parseDataUsageState, type DataUsageState } from '../../packages/shared/dist/dataUsage';
import { nodesManager } from '../nodes/manager';
const local = new DataUsageSampler({ state: STATE_DIR, agents: AGENTS_DIR });
const last = new Map<string, DataUsageState>();
const pending = new Map<string, Promise<DataUsageState>>();
export async function readNodeDataUsage(id: string, refresh=false): Promise<DataUsageState> {
  if (id === 'master') return local.read(refresh);
  const node = nodesManager.getNode(id);
  if (!node) return {status:'offline',report:last.get(id)?.report};
  if (!node.capabilities?.services?.['foxwarm-data']) return {status:'unsupported',report:last.get(id)?.report};
  if (pending.has(id)) return pending.get(id)!;
  const request = (async (): Promise<DataUsageState> => {
    try {
      const result = parseDataUsageState(await nodesManager.requestNodeService(id,'foxwarm-data','read',{refresh},10000));
      if (!result) throw new Error('Invalid data usage response');
      if (nodesManager.getNode(id) !== node) return {status:'offline',report:last.get(id)?.report};
      last.set(id,result);return result;
    } catch { return {status:'error',report:last.get(id)?.report}; }
    finally { pending.delete(id); }
  })();
  pending.set(id,request);return request;
}
export function registerDataUsageRoutes(server: { addRoute: (route: any)=>void }) {
  server.addRoute({method:'GET',path:'/api/nodes/:nodeId/data-usage',auth:'admin',handler:async(req:express.Request,res:express.Response)=>{
    const id=String(req.params.nodeId);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) return res.status(400).json({error:'Invalid Node'});
    res.setHeader('Cache-Control','private, no-store');
    res.json(await readNodeDataUsage(id,req.query.refresh==='true'));
  }});
}
