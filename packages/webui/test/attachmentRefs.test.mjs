import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result=await build({entryPoints:[new URL('../src/attachmentRefs.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false})
const {buildReferencedAttachmentParts,collectAttachmentRefs,splitGeneratedAttachmentName}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const attachments=[
 {ref:'attachment1',name:'attachment1_same_name.txt',mimeType:'text/plain',size:1,kind:'file'},
 {ref:'attachment2',name:'attachment2_same_name.txt',mimeType:'image/png',size:2,kind:'image'},
]
test('numeric attachment markers preserve duplicate filenames and append legacy-shaped descriptors',()=>{
 const text='a<attachment-ref ref="attachment2" />b<attachment-ref ref="attachment1" />c'
 assert.deepEqual(collectAttachmentRefs(text),['attachment2','attachment1'])
 const parts=buildReferencedAttachmentParts(text,attachments)
 assert.equal(parts[0].text,text)
 assert.match(parts[1].text,/^<foxwarm-file name="attachment1_same_name\.txt"/)
 assert.match(parts[2].text,/^<foxwarm-image name="attachment2_same_name\.txt"/)
 assert.doesNotMatch(JSON.stringify(parts.slice(1)),/attachmentRef|attachmentMeta|ref=/)
})
test('generated prefix stripping removes only the numeric UI prefix',()=>{
 assert.deepEqual(splitGeneratedAttachmentName('attachment12_original_name_with_underscores.txt'),{ref:'attachment12',originalName:'original_name_with_underscores.txt'})
 assert.equal(splitGeneratedAttachmentName('ordinary_name.txt'),null)
 assert.deepEqual(collectAttachmentRefs('<attachment-ref ref="opaque" />'),[])
})
