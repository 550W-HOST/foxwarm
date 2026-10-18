import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HardDrive, RefreshCw, X, Copy, Search } from 'lucide-react'
import { makeApiUrl } from '../config'
import { parseDataUsageState, type DataUsageState, type DataCategory } from '../../../shared/src/dataUsage'
import { copyTextToClipboard } from '../components/chatShared'
const cache = new Map<string, DataUsageState>()
const pending = new Map<string, Promise<DataUsageState>>()
async function readUsage(id: string, refresh=false) {
  if (pending.has(id)) { if (!refresh) return pending.get(id)!; await pending.get(id) }
  const request = (async (): Promise<DataUsageState> => {
    try {
      const response=await fetch(makeApiUrl(`/nodes/${encodeURIComponent(id)}/data-usage${refresh?'?refresh=true':''}`))
      if (!response.ok) throw new Error('Unavailable')
      const result=parseDataUsageState(await response.json());if(!result)throw new Error('Invalid response')
      if(cache.size>128) cache.delete(cache.keys().next().value!)
      cache.set(id,result);return result
    } catch { return {status:'error',report:cache.get(id)?.report} }
    finally {pending.delete(id)}
  })()
  pending.set(id,request);return request
}
export function dataSize(bytes: number) {
  if(bytes<1024)return `${bytes} B`
  const unit=Math.min(4,Math.floor(Math.log(bytes)/Math.log(1024)))
  return `${(bytes/1024**unit).toLocaleString(undefined,{maximumFractionDigits:1})} ${['B','KiB','MiB','GiB','TiB'][unit]}`
}
const categories: {key:DataCategory;label:string;color:string}[]=[
  {key:'runtime',label:'Runtime data',color:'var(--foxwarm-color-accent)'},
  {key:'workspaces',label:'Agent workspaces',color:'var(--foxwarm-color-special)'},
  {key:'assets',label:'Attachments & artifacts',color:'var(--foxwarm-color-success)'},
  {key:'temporary',label:'Cache & temporary files',color:'var(--foxwarm-color-warning)'},
]
function Details({ nodeId, name, state, refreshing, refresh, close }: {nodeId:string;name:string;state?:DataUsageState;refreshing:boolean;refresh:()=>void;close:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null), [search,setSearch]=useState(''), [copyState,setCopyState]=useState('')
  useLayoutEffect(()=>{const dialog=ref.current!;const focused=document.activeElement as HTMLElement|null;dialog.showModal();const old=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{dialog.close();document.body.style.overflow=old;focused?.focus({preventScroll:true})}},[])
  const report=state?.report
  const workspaces=report?.workspaces.filter(w=>(w.name+' '+w.path).toLowerCase().includes(search.toLowerCase()))||[]
  return createPortal(<dialog ref={ref} data-node-data-drawer className="node-data-drawer" aria-label={`${name} storage`} onCancel={e=>{e.preventDefault();close()}} onClick={e=>{if(e.target===e.currentTarget && e.clientX < e.currentTarget.getBoundingClientRect().left)close()}}>
    <header><div><h2>{name} <span>· Storage</span></h2><p>{nodeId}</p></div><button onClick={close} aria-label="Close storage details"><X size={18}/></button></header>
    <div className="node-data-body">
      <div className="node-data-total"><div><span>Foxwarm data</span><strong>{report?`${report.partial?'≥ ':''}${dataSize(report.totalBytes)}`:'—'}</strong></div><button onClick={refresh} disabled={refreshing||state?.status==='scanning'||state?.status==='offline'||state?.status==='unsupported'} aria-label="Refresh storage usage"><RefreshCw size={16} className={refreshing||state?.status==='scanning'?'node-data-scanning':''}/></button></div>
      <div className="node-data-meta">{state?.status==='scanning'?'Measuring…':state?.status==='unsupported'?'Not supported by this Node':state?.status==='offline'?'Node offline':state?.status==='error'?'Storage unavailable':!state?'Loading…':report?.partial?'Partial scan':report?.measurement==='logical'?'File size':'Allocated file size'}{report&&<time dateTime={new Date(report.measuredAt).toISOString()}>Updated {new Date(report.measuredAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time>}</div>
      {report&&<>
        <div className="node-data-bar" aria-hidden="true">{categories.map(c=><span key={c.key} style={{width:`${report.totalBytes?report.categories[c.key]/report.totalBytes*100:0}%`,background:c.color}}/>)}</div>
        <dl className="node-data-categories">{categories.map(c=><div key={c.key}><dt><i style={{background:c.color}}/>{c.label}</dt><dd>{dataSize(report.categories[c.key])}</dd></div>)}</dl>
        <section className="node-data-workspaces"><h3>Workspaces <span>{report.workspaces.length}</span></h3>
          {report.workspaces.length>6&&<label className="node-data-search"><Search size={15}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search workspaces…" aria-label="Search workspaces"/></label>}
          {workspaces.map(w=><details key={w.path+w.name}><summary><span>{w.name}</span><strong>{dataSize(w.bytes)}</strong></summary><div className="node-data-path"><code>{w.path}</code><button aria-label={`Copy path for ${w.name}`} onClick={()=>{void copyTextToClipboard(w.path).then(()=>setCopyState('Path copied'),()=>setCopyState('Could not copy path'))}}><Copy size={14}/></button></div><dl>{w.children.map(c=><div key={c.name}><dt title={c.path}>{c.name}</dt><dd>{dataSize(c.bytes)}</dd></div>)}</dl></details>)}
          {!workspaces.length&&<p className="node-data-meta">{search?'No matching workspaces':'No workspace files'}</p>}
          <span className="node-data-meta" role="status">{copyState}</span>
        </section>
      </>}
    </div>
  </dialog>,document.body)
}
export default function NodeDataUsage({nodeId,name}:{nodeId:string;name?:string}) {
  const [state,setState]=useState<DataUsageState|undefined>(()=>cache.get(nodeId)),[open,setOpen]=useState(false),[visible,setVisible]=useState(false),[refreshing,setRefreshing]=useState(false),[refreshEpoch,setRefreshEpoch]=useState(0)
  const root=useRef<HTMLButtonElement>(null),generation=useRef(0)
  useEffect(()=>{setVisible(false);setState(cache.get(nodeId));const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)));if(root.current)observer.observe(root.current);return()=>observer.disconnect()},[nodeId])
  useEffect(()=>{
    if(!visible&&!open)return
    let active=true,timer:ReturnType<typeof setTimeout>|undefined
    const poll=async()=>{if(document.hidden)return;const version=++generation.current;const result=await readUsage(nodeId);if(!active||version!==generation.current)return;setState(result);timer=setTimeout(()=>void poll(),result.status==='scanning'?2000:60000)}
    const visibility=()=>{clearTimeout(timer);if(!document.hidden)void poll()}
    document.addEventListener('visibilitychange',visibility);void poll()
    return()=>{active=false;generation.current++;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility)}
  },[nodeId,visible,open,refreshEpoch])
  const refresh=async()=>{setRefreshing(true);const version=++generation.current;const result=await readUsage(nodeId,true);if(version===generation.current)setState(result);setRefreshing(false);setRefreshEpoch(n=>n+1)}
  const label=state?.report?`${state.report.partial?'≥ ':''}${dataSize(state.report.totalBytes)}`:state?.status==='scanning'?'Measuring…':'—'
  return <><button ref={root} data-node-data-trigger={nodeId} className="node-data-trigger" aria-label={`${name||nodeId} data usage`} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(true)} title="Foxwarm data"><HardDrive size={14}/><span>Data</span><strong>{label}</strong></button>{open&&<Details nodeId={nodeId} name={name||nodeId} state={state} refreshing={refreshing} refresh={()=>void refresh()} close={()=>setOpen(false)}/>}</>
}
