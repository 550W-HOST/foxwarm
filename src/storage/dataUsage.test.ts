import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanDataUsage, DataUsageSampler } from '../../packages/shared/dist/dataUsageScanner';
import { parseDataUsageState } from '../../packages/shared/dist/dataUsage';
import { readNodeDataUsage, registerDataUsageRoutes } from './dataUsage';
test('data usage separates owned categories and workspaces without scanning external links', async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fw-data-usage-'));
 try {
  for(const file of ['state/logs/log','state/artifacts/art/1.json','agents/main/memory/note','agents/main/.temp/exec/log','agents/main/.temp/channel-files/image','agents/research/project/data']){
   const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'x'.repeat(6000));
  }
  await fs.mkdir(path.join(root,'external'));await fs.writeFile(path.join(root,'external/large'),'x'.repeat(100000));await fs.symlink(path.join(root,'external'),path.join(root,'agents/main/outside'));
  await fs.link(path.join(root,'agents/research/project/data'),path.join(root,'agents/research/project/alias'));
  const report=await scanDataUsage({state:path.join(root,'state'),agents:path.join(root,'agents')});
  assert.equal(report.files,6);assert.equal(report.partial,false);assert.equal(report.workspaces.length,2);
  assert.equal(report.workspaces.reduce((n,w)=>n+w.bytes,0),report.categories.workspaces);
  assert.ok(report.categories.assets>0 && report.categories.temporary>0 && report.categories.runtime>0);
  assert.deepEqual(parseDataUsageState({status:'ready',report})?.report,report);
  assert.equal(parseDataUsageState({status:'ready',report:{...report,totalBytes:-1}}),undefined);
  assert.equal(parseDataUsageState({status:'ready',report:{...report,workspaces:[]}}),undefined);
  const bounded=await scanDataUsage({state:path.join(root,'state'),agents:path.join(root,'agents')},{maxEntries:2});assert.equal(bounded.partial,true);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('sampler coalesces scans and refresh cannot create unbounded work',async()=>{
 let count=0,finish:any;const sampler=new DataUsageSampler({state:'a',agents:'b'},async()=>{count++;return await new Promise(r=>finish=r)});
 assert.equal(sampler.read().status,'scanning');sampler.read(true);sampler.read();assert.equal(count,1);
 finish({measuredAt:Date.now(),totalBytes:0,files:0,partial:false,skipped:0,measurement:'allocated',categories:{runtime:0,workspaces:0,assets:0,temporary:0},workspaces:[]});
 await new Promise(r=>setTimeout(r,0));assert.equal(sampler.read().status,'ready');sampler.read(true);assert.equal(count,1);
});
test('storage route is administrator-only and unknown/offline Nodes do not execute tools',async()=>{
 let route:any;registerDataUsageRoutes({addRoute:r=>route=r});assert.equal(route.auth,'admin');assert.equal(route.method,'GET');
 assert.equal((await readNodeDataUsage('not-a-node')).status,'offline');
 let status=0;await route.handler({params:{nodeId:'../master'},query:{}},{status:(s:number)=>{status=s;return{json:()=>{}}}});assert.equal(status,400);
});
test('standard CLI data roots include logs and retained workspaces without counting program installation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fw-node-layout-'));
 try{
  for(const file of ['data/state/config','data/logs/log','data/agents/main/note','program/agents/main/note','program/packages/client.js']){
   const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'x'.repeat(6000));
  }
  const report=await scanDataUsage({state:path.join(root,'data/state'),data:path.join(root,'data'),agents:path.join(root,'program/agents')});
  assert.equal(report.files,4);assert.equal(report.workspaces.length,2);assert.equal(new Set(report.workspaces.map(w=>w.path)).size,2);
  assert.equal(report.partial,false);assert.ok(parseDataUsageState({status:'ready',report}));
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
