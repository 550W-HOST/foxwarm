import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const code=await build({stdin:{contents:`export {buildArtifactGroups} from './src/artifacts/projection';export {validateArtifactDocument} from '../shared/src/artifacts/registry';export {assistantArtifactReferences,renderAssistantMarkdownSegmentsWithSanitizer} from './src/components/markdownRenderer';export {parseArtifactMarker} from '../shared/src/artifacts/marker'`,resolveDir:new URL('..',import.meta.url).pathname,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false})
const {buildArtifactGroups,validateArtifactDocument,assistantArtifactReferences,renderAssistantMarkdownSegmentsWithSanitizer,parseArtifactMarker}=await import(`data:text/javascript;base64,${Buffer.from(code.outputFiles[0].text).toString('base64')}`)
const receipt={protocolVersion:1,artifactId:`art_${'a'.repeat(32)}`,revision:1,sessionId:'a',type:'chart',title:'Metrics'}
const tool=(artifact,extra={})=>({role:'tool',parts:[{functionResponse:{name:'artifact',response:{artifact,...extra}}}]})
test('artifact projection is exact-target, revision-aware and success-only without parsing prose',()=>{
 const user={role:'user',parts:[{text:'Plot'}]},final={role:'model',parts:[{text:'Ready'}]}
 const first=buildArtifactGroups([user,tool(receipt),final],'a');assert.equal(first.length,1);assert.equal(first[0].endIndex,2)
 assert.equal(buildArtifactGroups([tool(receipt),tool(receipt)],'a')[0].artifacts.length,1)
 assert.equal(buildArtifactGroups([tool(receipt),tool({...receipt,revision:2})],'a')[0].artifacts.length,2)
 assert.equal(buildArtifactGroups([tool({...receipt,sessionId:'b'}),tool(receipt,{error:'failed'}),{role:'model',parts:[{text:JSON.stringify({artifact:receipt})}]}],'a').length,0)
 assert.equal(buildArtifactGroups([user,tool(receipt),final,user,tool({...receipt,revision:2})],'a').length,2)
 assert.equal(buildArtifactGroups([{role:'tool',parts:[{functionResponse:{name:'run_script',response:{result:{artifact:receipt}}}}]}],'a')[0].artifacts[0].artifactId,receipt.artifactId)
 assert.equal(buildArtifactGroups([{role:'tool',parts:[{functionResponse:{name:'read',response:{artifact:receipt}}}]}],'a').length,0)
})
test('unknown or hostile manifest types do not select prototype properties',()=>{
 for(const type of ['__proto__','constructor','prototype',{},null]) assert.throws(()=>validateArtifactDocument({type,schemaVersion:1,title:'x'}))
})

const marker=`<foxwarm-artifact id="${receipt.artifactId}" revision="1" />`
test('inline references are top-level Markdown nodes, not code, quotes, lists or arbitrary HTML',()=>{
 const text=`Before figure.\n\n${marker}\n\nAfter figure.`
 assert.deepEqual(assistantArtifactReferences(text),[{artifactId:receipt.artifactId,revision:1}])
 const segments=renderAssistantMarkdownSegmentsWithSanitizer(text,x=>x,{enabled:true})
 assert.deepEqual(segments.filter(x=>x.kind!=='html'||x.html.trim()).map(x=>x.kind),['html','artifact','html'])
 for(const source of ['```xml\n'+marker+'\n```','    '+marker,'> '+marker,'- '+marker,'`'+marker+'`','`before\n'+marker+'\nafter`','<!--\n'+marker+'\n-->','<pre>\n'+marker+'\n</pre>'])assert.equal(assistantArtifactReferences(source).length,0,source)
 assert.equal(renderAssistantMarkdownSegmentsWithSanitizer(text,x=>x).some(s=>s.kind==='artifact'),false)
 assert.equal(parseArtifactMarker(marker.replace('revision="1"','revision="1" onclick="bad"')),undefined)
 assert.equal(parseArtifactMarker(marker.replace('art_','../')),undefined)
 assert.equal(parseArtifactMarker(marker.replace('revision="1"','revision="0"')),undefined)
})
test('partial stream markers stay inert and complete refs keep their token identity as prose grows',()=>{
 const partial='Before.\n\n<foxwarm-artifact id="art_'
 const pending=renderAssistantMarkdownSegmentsWithSanitizer(partial,x=>x,{enabled:true,streaming:true})
 assert.equal(pending.some(s=>s.kind==='artifact'),false);assert.equal(pending.some(s=>s.html?.includes('foxwarm-artifact')),false)
 assert.equal(renderAssistantMarkdownSegmentsWithSanitizer(partial,x=>x,{enabled:true}).some(s=>s.html?.includes('foxwarm-artifact')),true)
 const a=renderAssistantMarkdownSegmentsWithSanitizer('Before.\n\n'+marker,x=>x,{enabled:true,streaming:true}).find(s=>s.kind==='artifact')
 const b=renderAssistantMarkdownSegmentsWithSanitizer('Before.\n\n'+marker+'\n\nAfter, with **emphasis**.',x=>x,{enabled:true}).find(s=>s.kind==='artifact')
 assert.equal(a.tokenIndex,b.tokenIndex)
})
test('prepare stays invisible until referenced; inline references suppress only their own reply-tail duplicate',()=>{
 const prepared={role:'tool',parts:[{functionResponse:{name:'artifact',response:{preparedArtifact:receipt,marker}}}]}
 assert.equal(buildArtifactGroups([prepared],'a').length,0)
 const body={role:'model',parts:[{text:'Before\n\n'+marker+'\n\nAfter'}]}
 assert.equal(buildArtifactGroups([tool(receipt),body],'a').length,0)
 assert.equal(buildArtifactGroups([tool(receipt),{role:'user',parts:[{text:'Next turn'}]},body],'a').length,1)
 assert.equal(buildArtifactGroups([tool(receipt),{role:'model',parts:[{text:'```\n'+marker+'\n```'}]}],'a').length,1)
})
