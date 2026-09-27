import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints:[new URL('../src/attachmentSend.ts',import.meta.url).pathname], bundle:true, platform:'node', format:'esm', write:false })
const { uploadReferencedFiles, postReferencedMessage, buildAttachmentUploadName, toLegacyUploadedFiles } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

test('uploads use numeric prefixes while preserving duplicate original names and order', async()=>{
  const files=[{ref:'attachment1',file:new File(['a'],'same_name.txt',{type:'text/plain'})},{ref:'attachment2',file:new File(['b'],'same_name.txt',{type:'text/plain'})}]
  const multipartNames=[];let index=0
  const uploaded=await uploadReferencedFiles(files,'/upload',async(_url,init)=>{multipartNames.push(init.body.get('file').name);const filename=multipartNames.at(-1);return new Response(JSON.stringify({path:`/tmp/${++index}`,filename,mimeType:'text/plain',size:index}),{status:200,headers:{'content-type':'application/json'}})})
  assert.deepEqual(multipartNames,['attachment1_same_name.txt','attachment2_same_name.txt'])
  assert.deepEqual(uploaded.map(item=>({ref:item.ref,path:item.path,filename:item.filename})),[
    {ref:'attachment1',path:'/tmp/1',filename:'attachment1_same_name.txt'},
    {ref:'attachment2',path:'/tmp/2',filename:'attachment2_same_name.txt'},
  ])
  assert.equal(buildAttachmentUploadName('attachment12','original_name.txt'),'attachment12_original_name.txt')
  assert.deepEqual(toLegacyUploadedFiles(uploaded),[
    {path:'/tmp/1',filename:'attachment1_same_name.txt',mimeType:'text/plain'},
    {path:'/tmp/2',filename:'attachment2_same_name.txt',mimeType:'text/plain'},
  ])
})

test('upload and message HTTP failures reject instead of reporting accepted send', async()=>{
  await assert.rejects(()=>uploadReferencedFiles([{ref:'attachment1',file:new File(['a'],'failed.txt')}],'/upload',async()=>new Response('{}',{status:500})),/Failed to upload failed\.txt/)
  await assert.rejects(()=>postReferencedMessage('/message',{parts:[]},async()=>new Response('{}',{status:400})),/Failed to send message \(400\)/)
})
