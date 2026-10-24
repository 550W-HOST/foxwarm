// Source and candidate CLI browser tools through the real owned protocol and local pages.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import sharp from 'sharp'
import { until } from './experimentHostFixture.mjs'
const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const modes = ['source', 'candidate']
const sharedOnly = process.argv.includes('--shared-only')
const evaluateOnly = sharedOnly || process.argv.includes('--evaluate-only')
const servers = [], sockets = new Map(), replies = [], children = [], evidence = {}
const site = createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { location: '/one' }); res.end(); return }
  if (req.url === '/page-stringify' || req.url === '/page-prototype') {
    const hook = req.url === '/page-stringify'
      ? 'window.savedStringify=JSON.stringify;JSON.stringify=()=>"page-overrode-stringify"'
      : 'Object.prototype.toJSON=()=>"page-prototype-hook"'
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><title>Page hooks</title><script>${hook}</script>`)
    return
  }
  const title = req.url === '/two' ? 'Two' : 'One'
  res.setHeader('content-type', 'text/html')
  res.end(`<!doctype html><html><head><title>${title}</title></head><body style="margin:0;min-height:1800px"><h1>${title}</h1><input id="entry" value="seed"><button id="button" onclick="window.clicked++">Click</button><div><button onclick="window.item=1">Item</button><button onclick="window.item=2">Item</button></div><a id="link" href="/two">Next</a><div hidden id="hidden">hidden</div><script>window.clicked=0;window.inputs=0;window.changes=0;document.querySelector('#entry').addEventListener('input',()=>inputs++);document.querySelector('#entry').addEventListener('change',()=>changes++);setTimeout(()=>{const x=document.createElement('div');x.id='later';document.body.append(x)},100);</script></body></html>`)
})
site.listen(0,'127.0.0.1'); await once(site,'listening'); servers.push(site)
const origin = `http://127.0.0.1:${site.address().port}`
const http = createServer(), ws = new WebSocketServer({server:http}); http.listen(0,'127.0.0.1'); await once(http,'listening'); servers.push(http)
ws.on('connection',(socket,request)=>{
  const id=new URL(request.url,'http://owned').searchParams.get('id')
  socket.on('error',()=>{})
  socket.on('message',bytes=>{
    const frame=JSON.parse(bytes)
    if(frame.type==='node_register') { evidence[id] ??= {capabilities:frame.capabilities}; sockets.set(id,socket); socket.send(JSON.stringify({type:'registered',nodeId:id,nodeProtocol:{negotiated:3,master:{min:1,max:3}}})) }
    else replies.push(frame)
  })
})
let serial=0
async function tool(mode,name,args){
  const callId=String(++serial)
  sockets.get(mode).send(JSON.stringify({type:'tool_call',callId,tool:name,args,sessionId:'main/browser-fixture',agentName:'main'}))
  return until(()=>{const i=replies.findIndex(r=>r.callId===callId);if(i<0)return null;const r=replies.splice(i,1)[0];delete r.callId;return r},name,40000)
}
async function launch(mode){
  const cwd=join(root,mode);await mkdir(join(cwd,'home'),{recursive:true});await mkdir(join(cwd,'config'),{recursive:true});await mkdir(join(cwd,'cache'),{recursive:true})
  const executable=mode==='candidate' && process.env.FOXWARM_CLI_EXECUTABLE
  const command=mode==='source'?process.execPath:executable || join(process.env.DOTNET_ROOT,'dotnet')
  const entry=mode==='source'?[resolve('packages/cli-node/dist/client.js')]:executable?[]:[resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]
  const child=spawn(command,[...entry,'--host',`http://127.0.0.1:${http.address().port}`,'--no-local-trigger','--id',mode,'--auth-token',mode+'-owned','--credentials-file',join(cwd,'credentials.json')],{cwd,env:{...isolatedApplicationEnv(join(cwd,'data')),PUPPETEER_EXECUTABLE_PATH:process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium',HOME:join(cwd,'home'),XDG_CONFIG_HOME:join(cwd,'config'),XDG_CACHE_HOME:join(cwd,'cache')},stdio:['ignore','pipe','pipe']})
  const item={mode,child,output:''};children.push(item)
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>item.output+=bytes)
  await until(()=>sockets.get(mode),mode+' registration',15000);return item
}
async function ownedProcesses(pid){
  const result=[], pending=[pid]
  while(pending.length){
    const current=pending.pop()
    try{
      result.push({pid:current,command:(await readFile(`/proc/${current}/cmdline`,'utf8')).replaceAll('\0',' ').trim()})
      const children=(await readFile(`/proc/${current}/task/${current}/children`,'utf8')).trim()
      if(children)pending.push(...children.split(/\s+/).map(Number))
    }catch(error){if(error.code!=='ENOENT')throw error}
  }
  return result
}
async function corpus(mode){
  const rows=[], item=await launch(mode);evidence[mode].rows=rows
  const take=async(name,args)=>{const r=await tool(mode,name,args);rows.push({name,args,result:r});return r}
  const success=async(name,args)=>{const r=await take(name,args);assert.equal(r.type,'tool_call_response',JSON.stringify(r));return r.result}
  assert.deepEqual(await success('browse_list',{}),[])
  const opened=await success('browse_open',{url:origin+'/redirect'}),tabId=opened.tabId
  assert.equal(opened.url,origin+'/redirect');assert.equal(opened.title,'One')
  const act=async(action,params={})=>success('browse_interact',{tabId,action,params})
  const evalJS=async(code)=>act('evaluate',{code})
  assert.equal((await success('browse_list',{}))[0].url,origin+'/redirect')
  const html=await success('browse_get',{tabId});assert(html.content.startsWith('<!DOCTYPE html>'));assert(html.content.includes('<input'));assert.equal(html.url,origin+'/one')
  evidence[mode].activeGroupProcesses=await ownedProcesses(item.child.pid)
  for(const [code,expected] of [['42','42'],['"hi\\nworld"','"hi\\nworld"'],['true','true'],['null','null'],['undefined','undefined'],['NaN','null'],['Infinity','null'],['-Infinity','null'],['-0','0'],['({a:1,b:[true,null,"x"]})','{"a":1,"b":[true,null,"x"]}']]) assert.equal((await evalJS(code)).output,'Evaluated: '+expected)
  // Retain evidence for less ordinary clone/stringification consequences too.
  for(const [code,expected] of [['new Date(0)','{}'],['({date:new Date(0),nan:NaN,missing:undefined})','{"date":{},"nan":null}'],['(()=>{const x={};x.self=x;return x})()','undefined']])assert.equal((await evalJS(code)).output,'Evaluated: '+expected)
  const err=await take('browse_interact',{tabId,action:'evaluate',params:{code:'(()=>{throw new Error("owned-js-error")})()'}});assert.equal(err.type,'tool_call_error')
  // These strings exercise the host writer, including escaped UTF-16 units in keys.
  for(const value of ['"\\/\b\f\n\r\t\u0000\u0001<>&é\u2028\u2029', '\ud800', '\udfff', '\ud83d\ude00', '\\ud800']) {
    assert.equal((await evalJS(JSON.stringify(value))).output, 'Evaluated: '+JSON.stringify(value))
  }
  const keyed = {'\ud800':'high','\udfff':'low','😀':'pair','\\ud800':'literal'}
  assert.equal((await evalJS('('+JSON.stringify(keyed)+')')).output,'Evaluated: '+JSON.stringify(keyed))
  const numbers = [1e-7,1e-6,1e20,1e21,1000000000000000128,Number.MIN_VALUE,Number.MAX_VALUE,-0]
  assert.equal((await evalJS('['+numbers.map(String).join(',')+']')).output,'Evaluated: '+JSON.stringify(numbers))
  assert.equal((await evalJS('(()=>{const x={b:1,"10":10,"2":2,"01":3,"4294967295":4,"4294967294":5};Object.defineProperty(x,"__proto__",{value:{safe:true},enumerable:true});x.constructor="own";return x})()')).output,'Evaluated: {"2":2,"10":10,"4294967294":5,"b":1,"01":3,"4294967295":4,"__proto__":{"safe":true},"constructor":"own"}')
  assert.equal((await evalJS('[undefined,NaN,Infinity,-Infinity,-0,new Date(0)]')).output,'Evaluated: [null,null,null,null,0,{}]')
  const bigint=await take('browse_interact',{tabId,action:'evaluate',params:{code:'1n'}});assert.equal(bigint.type,'tool_call_error');assert.match(bigint.error.message,/BigInt/)
  // The loaded page, not the caller expression, installs each hook.
  assert.equal((await evalJS('({a:1})')).output,'Evaluated: {"a":1}')
  for(const hook of ['stringify','prototype']) {
    const hooked=await success('browse_open',{url:origin+'/page-'+hook})
    const evaluate=code=>success('browse_interact',{tabId:hooked.tabId,action:'evaluate',params:{code}})
    assert.equal((await evaluate('({a:1})')).output,'Evaluated: {"a":1}')
    const hookCall=hook==='stringify'?'JSON.stringify({})':'({}).toJSON()'
    const hookResult=hook==='stringify'?'page-overrode-stringify':'page-prototype-hook'
    assert.equal((await evaluate(hookCall)).output,'Evaluated: '+JSON.stringify(hookResult))
    const restore=hook==='stringify'?'JSON.stringify=window.savedStringify':'delete Object.prototype.toJSON'
    assert.equal((await evaluate('(()=>{'+restore+';return 42})()')).output,'Evaluated: 42')
    assert.equal((await evaluate('({a:1})')).output,'Evaluated: {"a":1}')
    await success('browse_close',{tabId:hooked.tabId})
  }
  // Also retain the original mutable-page reproductions and restored controls.
  for(const code of [
    '(()=>{window.savedStringify=JSON.stringify;JSON.stringify=()=>"page-overrode-stringify";return {a:1}})()',
    '(()=>{JSON.stringify=window.savedStringify;return {a:1}})()',
    '(()=>{Object.prototype.toJSON=()=>"page-prototype-hook";return {a:1}})()',
    '(()=>{delete Object.prototype.toJSON;return {a:1}})()'
  ]) assert.equal((await evalJS(code)).output,'Evaluated: {"a":1}')
  if(sharedOnly) {
    await act('wait',{selector:'aria/Click'})
    await act('wait',{selector:'::-p-aria(Item):nth-of-type(2)'})
    await act('click',{selector:'::-p-aria(Item):nth-of-type(2)'})
    assert.equal((await evalJS('window.item')).output,'Evaluated: 2')
  }
  if(evaluateOnly) await success('browse_close',{tabId})
  else {
    await act('fill',{selector:'#entry',text:'replacement'});assert.equal((await evalJS('({value:document.querySelector("#entry").value,inputs,changes})')).output,'Evaluated: {"value":"replacement","inputs":1,"changes":0}')
    await act('type',{selector:'#entry',text:'APPEND'});assert.equal((await evalJS('document.querySelector("#entry").value')).output,'Evaluated: "replacementAPPEND"')
    await act('press',{key:'End'});await act('press',{key:'X'});assert.equal((await evalJS('document.querySelector("#entry").value')).output,'Evaluated: "replacementAPPENDX"')
    const clickAt=Date.now();await act('click',{selector:'#button'});assert(Date.now()-clickAt>=4800);assert.equal((await evalJS('clicked')).output,'Evaluated: 1')
    await act('scroll',{y:350});assert.equal((await evalJS('window.scrollY')).output,'Evaluated: 350');await act('scroll',{y:0})
    await act('wait',{selector:'#later'});await act('wait',{selector:'#hidden',timeout:0});await act('wait',{selector:'aria/Click'})
    // This compound selector invokes the distinct built-in ARIA query-all binding.
    await act('wait',{selector:'::-p-aria(Item):nth-of-type(2)'})
    await act('click',{selector:'::-p-aria(Item):nth-of-type(2)'})
    assert.equal((await evalJS('window.item')).output,'Evaluated: 2')
    const fullHeight=Number((await evalJS('Math.max(document.documentElement.scrollHeight,document.body.scrollHeight)')).output.slice('Evaluated: '.length))
    for(const screenshot of [true,'full',join(root,mode,'must-not-write.png')]){
      const image=await success('browse_get',{tabId,screenshot}),bytes=Buffer.from(image.inlineData.data,'base64'),meta=await sharp(bytes).metadata()
      assert.equal(image.mimeType,'image/png');assert.equal(image.sizeBytes,bytes.length);assert.equal(meta.width,800);assert.equal(meta.height,screenshot==='full'?fullHeight:600)
      rows.at(-1).dimensions={width:meta.width,height:meta.height};delete image.inlineData.data
      await assert.rejects(access(join(root,mode,'must-not-write.png')))
    }
    await evalJS('document.title="Changed"');assert.equal((await success('browse_list',{}))[0].title,'One');assert.equal((await success('browse_get',{tabId})).title,'Changed')
    await act('goto',{url:origin+'/two'});await act('back');assert.equal((await success('browse_list',{}))[0].url,origin+'/two');assert.equal((await success('browse_get',{tabId})).url,origin+'/one')
    await act('forward');assert.equal((await success('browse_list',{}))[0].url,origin+'/one');await act('reload');assert.equal((await success('browse_get',{tabId})).url,origin+'/two')
    const original=sockets.get(mode);original.terminate();await until(()=>sockets.get(mode)!==original,mode+' same-process reconnect',12000);assert.equal((await success('browse_list',{}))[0].id,tabId)
    const second=await success('browse_open',{url:origin+'/one'});assert.deepEqual((await success('browse_list',{})).map(t=>t.id),[tabId,second.tabId])
    for(const name of ['browse_get','browse_close','browse_interact'])assert.equal((await take(name,{tabId:'missing',action:'reload'})).type,'tool_call_error')
    await success('browse_close',{tabId});await success('browse_close',{tabId:second.tabId});assert.deepEqual(await success('browse_list',{}),[])
    const reopened=await success('browse_open',{url:origin+'/one'});await success('browse_close',{tabId:reopened.tabId})
  }
  if(evaluateOnly) await writeFile(join(root,mode+'-evaluate-results.json'),JSON.stringify(rows,null,2))
  const maps=await readFile(`/proc/${item.child.pid}/maps`,'utf8')
  if(mode==='candidate' && process.env.FOXWARM_CLI_EXECUTABLE)assert(!/libcoreclr|libhostfxr/.test(maps),'actual native process has no CLR mapping')
  const processes=await ownedProcesses(item.child.pid)
  await writeFile(join(root,mode+'-maps.txt'),maps)
  await writeFile(join(root,mode+'-processes.json'),JSON.stringify({active:evidence[mode].activeGroupProcesses,afterLastTab:processes},null,2))
  const exited=once(item.child,'exit');item.child.kill('SIGTERM');await exited
  console.log(JSON.stringify({mode,operations:rows.length,evaluateOnly,hostCloneSerialization:true,allElevenActions:!evaluateOnly,ariaSingleAndQueryAll:sharedOnly || !evaluateOnly,pngAndMetadata:!evaluateOnly,reconnect:!evaluateOnly,native:!!process.env.FOXWARM_CLI_EXECUTABLE && mode==='candidate',noClr:!/libcoreclr|libhostfxr/.test(maps),browser:execFileSync(process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium',['--version'],{encoding:'utf8'}).trim(),processes:processes.map(p=>({pid:p.pid,kind:p.command.match(/--type=([^ ]+)/)?.[1] || (p.command.includes('chromium')?'browser':'cli')}))}))
}
try { for(const mode of modes) await corpus(mode) }
catch(error){evidence.error=error.stack;throw error}
finally{
  for(const item of children){
    if(item.child.exitCode===null&&item.child.signalCode===null){
      const stopped=once(item.child,'exit'), force=setTimeout(()=>item.child.kill('SIGKILL'),5000);force.unref()
      item.child.kill('SIGTERM');await stopped;clearTimeout(force)
    }
    if(evidence.error)console.error(item.mode,item.output)
  }
  for(const socket of ws.clients)socket.terminate();await new Promise(r=>ws.close(r));for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r))}
}
