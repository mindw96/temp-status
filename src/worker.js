// Site assets are embedded by scripts/build.mjs. Reports remain in D1.
const MAX_BODY=8*1024*1024;
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const text=(v,max=250)=>typeof v==='string'?v.slice(0,max):typeof v==='number'?String(v):'';
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const fields=(obj,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(obj,k)).map(k=>[k,obj[k]]));
function storageFailure(error) {
  const message = [error?.message, error?.cause?.message].filter(v => typeof v === 'string').join(' ');
  const dailyRows = /\bdaily\s+row\s+(?:reads?|writes?)\s+limit\b/i;
  const accountRows = /\bmaximum\s+account\s+(?:reads|writes)\s+limit\b/i;
  if (/\bD1(?:_ERROR)?\b/i.test(message) && /\bexceeded\b/i.test(message)
    && (dailyRows.test(message) || accountRows.test(message))) {
    const now = Date.now(), retryAt = (Math.floor(now / 86400000) + 1) * 86400000;
    const response = json({error: 'storage_quota_exceeded', retry_at: retryAt}, 503);
    response.headers.set('Retry-After', String(Math.ceil((retryAt - now) / 1000)));
    return response;
  }
  return json({error: 'storage_unavailable'}, 503);
}
async function authorized(request,expected){if(!expected)return false;const actual=request.headers.get('X-Status-Token')||'';if(!actual||actual.length>1024)return false;const a=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(actual))),b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(expected)));let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;}
function validate(payload,type){if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('JSON object required');if(type==='node'){if(typeof payload.server_name!=='string'||!payload.server_name.trim()||payload.server_name.length>128||!Array.isArray(payload.gpus)||payload.gpus.length>256)throw new Error('server_name and gpus are required');const clean={server_name:payload.server_name.trim()};for(const key of ['cpu_percent','ram_percent','ram_total_gb','ram_used_gb','total_disk_gb','used_disk_gb','free_disk_gb','disk_percent','total_subdisk_gb','used_subdisk_gb','free_subdisk_gb','subdisk_percent'])clean[key]=number(payload[key]);clean.gpus=payload.gpus.map(g=>{if(!g||typeof g!=='object'||(!Number.isInteger(g.id)&&typeof g.id!=='string'))throw new Error('Invalid GPU');const out={id:g.id,uuid:text(g.uuid),gpu_name:text(g.gpu_name),collection_error:text(g.collection_error),processes:[]};for(const k of ['minor_number','vram_total_used_mb','vram_total_mb','vram_process_used_mb','gpu_utilization','vram_utilization'])out[k]=number(g[k]);out.processes=(Array.isArray(g.processes)?g.processes:[]).slice(0,2048).filter(p=>p&&typeof p==='object').map(p=>({username:text(p.username,80),pid:number(p.pid),used_mb:number(p.used_mb),slurm_job_id:text(p.slurm_job_id,128),slurm_job_name:text(p.slurm_job_name,500),slurm_job_ids:(Array.isArray(p.slurm_job_ids)?p.slurm_job_ids:[]).slice(0,50).map(v=>text(v,128))}));return out;});return clean;}
if(!Array.isArray(payload.sinfo)||!Array.isArray(payload.squeue)||payload.sinfo.length>10000||payload.squeue.length>20000)throw new Error('sinfo and squeue arrays are required');const sinfo=payload.sinfo.map(n=>{if(!n||typeof n!=='object'||!text(n.name||n.hostname,128))throw new Error('Invalid Slurm node');return {name:text(n.name||n.hostname,128),hostname:text(n.hostname||n.name,128),state:text(n.state,100),cpus:number(n.cpus),alloc_cpus:number(n.alloc_cpus),idle_cpus:number(n.idle_cpus),cpus_state:text(n.cpus_state,100),cpus_total:number(n.cpus_total),cpus_allocated:number(n.cpus_allocated)};});const squeue=payload.squeue.map(j=>{if(!j||typeof j!=='object'||!text(j.job_id,128))throw new Error('Invalid Slurm job');const out={};for(const key of ['job_id','partition','user','name','job_state','time','nodes','node_list_or_reason','gpu_index','batch_host','req_node_list','reason','req_cpus','req_mem','req_gpus'])out[key]=text(j[key],key==='node_list_or_reason'?4096:500);out.job_id_aliases=(Array.isArray(j.job_id_aliases)?j.job_id_aliases:[]).slice(0,64).map(v=>text(v,128));return out;});return{sinfo,squeue};}
// Cloud collectors report a different envelope; normalize it into an isolated
// node record without importing commands or unrelated scheduler identities.
function validateCloudNode(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.server || typeof payload.server !== 'object' || Array.isArray(payload.server)
    || !payload.system || typeof payload.system !== 'object' || Array.isArray(payload.system)
    || !Array.isArray(payload.gpus) || payload.gpus.length > 256) {
    throw new Error('server, system, and gpus are required');
  }
  const indices = new Set();
  const gpus = payload.gpus.map(g => {
    if (!g || typeof g !== 'object' || Array.isArray(g)
      || !Number.isInteger(g.index) || g.index < 0 || indices.has(g.index)) {
      throw new Error('Each cloud GPU must have a unique non-negative index');
    }
    indices.add(g.index);
    return {
      id: g.index, uuid: g.uuid, gpu_name: g.name,
      gpu_utilization: g.utilization_gpu,
      vram_total_used_mb: g.memory_used, vram_total_mb: g.memory_total,
      processes: (Array.isArray(g.processes) ? g.processes : []).slice(0, 2048)
        .filter(p => p && typeof p === 'object' && !Array.isArray(p))
        .map(p => ({pid: p.pid, username: p.username, used_mb: p.gpu_memory_usage}))
    };
  });
  const clean = validate({
    server_name: payload.server.name, gpus,
    ...fields(payload.system, ['cpu_percent', 'ram_percent', 'ram_total_gb',
      'ram_used_gb', 'total_disk_gb', 'used_disk_gb', 'disk_percent'])
  }, 'node');
  clean.source_type = 'cloud';
  clean.cpu_count = Number.isInteger(payload.system.cpu_count)
    && payload.system.cpu_count >= 1 && payload.system.cpu_count <= 65536
    ? payload.system.cpu_count : null;
  // A standalone cloud report cannot claim an association with the lab queue.
  for (const gpu of clean.gpus) {
    gpu.processes = gpu.processes.map(p => ({pid: p.pid, username: p.username, used_mb: p.used_mb}));
  }
  return clean;
}
async function bodyJSON(request){if(Number(request.headers.get('Content-Length')||0)>MAX_BODY)throw new RangeError('Payload too large');const reader=request.body?.getReader();if(!reader)throw new Error('Missing body');const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BODY){await reader.cancel();throw new RangeError('Payload too large');}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));}
export default {async fetch(request,env,ctx){const url=new URL(request.url);const route=url.pathname;
if(route==='/api/report/node'||route==='/api/report/slurm'||route==='/api/report/cloud-gpu'){
if(request.method!=='POST')return json({error:'method_not_allowed'},405);
if(!await authorized(request,env.STATUS_REPORT_TOKEN))return json({error:'unauthorized'},401);
if(!env.DB)return json({error:'storage_unavailable'},503);
let payload;const type=route.endsWith('/slurm')?'slurm':'node';try{const raw=await bodyJSON(request);payload=route.endsWith('/cloud-gpu')?validateCloudNode(raw):validate(raw,type);}catch(error){return json({error:error instanceof RangeError?'payload_too_large':'invalid_payload',message:error.message},error instanceof RangeError?413:400);}
const serialized=JSON.stringify(payload);if(new TextEncoder().encode(serialized).length>1800000)return json({error:'normalized_payload_too_large'},413);
const now=Date.now(),key=type==='node'?`node:${payload.server_name}`:'slurm';
// Only latest reports are needed by the dashboard. Existing history is retained without querying it.
try{await env.DB.prepare('INSERT INTO reports (key,payload,received_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at').bind(key,serialized,now).run();return json({ok:true,received_at:now,...(type==='slurm'?{accounting_status:'not_enabled'}:{})});}catch(error){console.error('report storage failed',error.message);return storageFailure(error);}}
if(route==='/api/snapshot'){
if(request.method!=='GET')return json({error:'method_not_allowed'},405);
// Public read access is explicit; collection endpoints always require their separate token.
const mode=env.SNAPSHOT_AUTH_MODE||'sites';
if(mode!=='public'&&mode!=='sites')return json({error:'access_not_configured'},503);
// Only the Sites deployment has a trusted dispatch gateway that supplies this identity.
if(mode==='sites'&&!request.headers.get('oai-authenticated-user-id'))return json({error:'sign_in_required'},401);
try{const reports=await env.DB.prepare('SELECT key,payload,received_at FROM reports ORDER BY key').all();const data={serverTime:Date.now(),slurm:null,nodes:[],history:[]};for(const row of reports.results){const item={receivedAt:row.received_at,data:JSON.parse(row.payload)};if(row.key==='slurm')data.slurm=item;else if(row.key.startsWith('node:'))data.nodes.push(item);}return json(data);}catch(error){console.error('snapshot unavailable',error.message);return storageFailure(error);}}
if(route.startsWith('/api/'))return json({error:'not_found'},404);
if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
const asset=ASSETS[route==='/'?'/index.html':route];if(!asset)return new Response('Not found',{status:404});return new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com"}});
}};
