import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeClient } from './client';
test('optional storage service has fixed operations and cannot accept a scan path',async()=>{
 const calls:boolean[]=[];
 const client={dataUsage:{read:(refresh:boolean)=>{calls.push(refresh);return{status:'scanning'}}}};
 const execute=(NodeClient.prototype as any).executeNodeService;
 assert.deepEqual(await execute.call(client,'foxwarm-data','read',{}),{status:'scanning'});
 await execute.call(client,'foxwarm-data','read',{refresh:true});assert.deepEqual(calls,[false,true]);
 const invalidArgs: unknown[] = [{path:'/outside'},{refresh:'true'},[],null];
 for(const args of invalidArgs)await assert.rejects(execute.call(client,'foxwarm-data','read',args),/Invalid/);
 await assert.rejects(execute.call(client,'foxwarm-data','delete',{}),/Invalid/);
});
