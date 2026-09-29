'use strict';
const icons={grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',server:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h7M11 17.5h7"/>',queue:'<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',flask:'<path d="M9 3h6m-5 0v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 14h8"/>',chip:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',activity:'<path d="M2 12h4l3-8 5 16 3-8h5"/>',play:'<path d="m9 5 11 7-11 7V5Z"/>',thermometer:'<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0Z"/><path d="M12 10v8"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.grid}</svg>`;
function mountIcons(root=document){root.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Display aliases only: collection identifiers and Slurm node keys stay unchanged.
const nodeDisplayNames=Object.freeze({devbox:'Server1',server2:'Server2',ubuntu:'Server3',server4:'Server4'});
const nodeDisplayOrder=Object.keys(nodeDisplayNames);
const nodeOrder=id=>{const index=nodeDisplayOrder.indexOf(id);return index<0?nodeDisplayOrder.length:index;};
const displayNodeName=name=>Object.hasOwn(nodeDisplayNames,name)?nodeDisplayNames[name]:name;
const displayNodeList=value=>String(value).replace(/(^|[,\s])([A-Za-z0-9_.-]+)(?=$|[,\s])/g,(_,separator,name)=>separator+displayNodeName(name));
let partitionMeta={accelerated:{model:'NVIDIA H100',label:'H100 · 80 GB'},compute:{model:'NVIDIA A100',label:'A100 · 80 GB'},interactive:{model:'NVIDIA RTX 4090',label:'RTX 4090 · 24 GB'}};
const nodeSpecs=[['gpu-01','accelerated',8,8,'ALLOCATED',[96,94,93,92,91,93,89,88],68,128,128],['gpu-02','accelerated',8,6,'MIXED',[93,91,89,91,90,90,0,0],65,128,96],['gpu-03','compute',4,4,'ALLOCATED',[83,82,81,78],62,64,64],['gpu-04','compute',4,2,'MIXED',[76,60,0,0],57,64,32],['gpu-05','interactive',4,2,'MIXED',[10,14,0,0],43,32,16],['gpu-06','interactive',4,0,'DRAINED',[null,null,null,null],null,32,0]];
let nodes=nodeSpecs.map(([id,partition,total,allocated,state,utils,temp,cpu,cpuAllocated])=>({id,partition,total,allocated,state,cpu,cpuAllocated,reason:state==='DRAINED'?'GPU driver maintenance':null,gpus:utils.map((util,index)=>({index,util,allocated:index<allocated,memory:partition==='interactive'?24:80,memoryUsed:util===null?null:index<allocated?Math.round((partition==='interactive'?24:80)*(.65+(index%3)*.08)):0,temp:temp===null?null:temp-index%3}))}));
const jobSpecs=[['48217','llama3-70b-sft','minji','RUNNING','accelerated',8,'03:42:18','gpu-01',[0,1,2,3,4,5,6,7]],['48231','multimodal-pretrain','jiwon','RUNNING','accelerated',4,'01:28:05','gpu-02',[0,1,2,3]],['48236','retrieval-ablation','hyunwoo','RUNNING','accelerated',2,'00:46:12','gpu-02',[4,5]],['48222','diffusion-train','seoyeon','RUNNING','compute',4,'02:53:40','gpu-03',[0,1,2,3]],['48240','embedding-train','yujin','RUNNING','compute',1,'00:31:09','gpu-04',[0]],['48241','reranker-eval','junho','RUNNING','compute',1,'00:24:16','gpu-04',[1]],['48245','data-validation','doyun','RUNNING','interactive',1,'00:12:24','gpu-05',[0]],['48246','tokenizer-benchmark','harin','RUNNING','interactive',1,'00:10:03','gpu-05',[1]],['48248','llama-full-ft','doyun','PENDING','accelerated',8,'00:38:12','Resources',[]],['48250','reward-model','harin','PENDING','accelerated',2,'00:22:45','Priority',[]],['48253','eval-after-sft','minji','PENDING','interactive',1,'00:14:06','Dependency',[]],['48254','diffusion-sweep','seoyeon','PENDING','compute',4,'00:08:32','QOSMaxGRESPerUser',[]]];
let jobs=jobSpecs.map(([id,name,user,state,partition,gpus,elapsed,target,indices])=>({id,name,user,state,partition,gpus,elapsed,target,indices}));
const reasons={Resources:'Insufficient resources',Priority:'Waiting for priority',Dependency:'Waiting for dependency',QOSMaxGRESPerUser:'User GPU limit'};
const state={jobState:'all',search:'',user:'',server:''};
const $=selector=>document.querySelector(selector);
const currentNodes=()=>nodes;
const currentJobs=()=>jobs;
const average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const percent=v=>v===null?'—':`${Math.round(v)}%`;
function getMetrics(){const ns=currentNodes(),js=currentJobs(),gpu=ns.flatMap(n=>n.gpus),known=gpu.filter(g=>g.util!==null);return{total:gpu.length,allocated:gpu.filter(g=>g.allocated).length,idle:ns.filter(n=>!n.state.includes('DRAIN')).reduce((sum,n)=>sum+n.total-n.allocated,0),unavailable:gpu.length-known.length,util:average(known.map(g=>g.util)),running:js.filter(j=>j.state==='RUNNING').length,pending:js.filter(j=>j.state==='PENDING').length,normal:ns.filter(n=>!n.state.includes('DRAIN')).length,nodes:ns.length};}
function renderNodes(){const ns=currentNodes();$('#node-count').textContent=ns.length;$('#node-grid').innerHTML=ns.map(n=>{const util=average(n.gpus.map(g=>g.util).filter(v=>v!==null)),mem=n.gpus.some(g=>g.memoryUsed===null)?null:n.gpus.reduce((s,g)=>s+g.memoryUsed,0),memTotal=n.gpus.reduce((s,g)=>s+g.memory,0),temp=n.gpus[0].temp;return`<button class="node ${n.state==='DRAINED'?'drain-node':''}" data-node="${n.id}" aria-label="${esc(displayNodeName(n.id))} details, ${n.state}, ${n.allocated} of ${n.total} GPUs allocated"><div class="node-header"><div class="node-title">${icon('server')}<span class="node-name">${esc(displayNodeName(n.id))}</span></div><span class="state-badge ${n.state==='MIXED'?'mixed':n.state==='DRAINED'?'drain':''}">${n.state}</span></div><div class="node-model">${partitionMeta[n.partition].model} <span>× ${n.total}</span></div><div class="gpu-blocks" aria-hidden="true">${n.gpus.map(g=>`<span class="gpu-slot ${g.allocated?'occupied':g.util===null?'unavailable':''}">${g.index}</span>`).join('')}</div><div class="node-stats"><span>Compute <strong>${percent(util)}</strong></span><span>VRAM <strong>${mem===null?'—':Math.round(mem/memTotal*100)+'%'}</strong></span><span class="temperature">${icon('thermometer')}<strong>${temp===null?'—':temp+'°C'}</strong></span></div><div class="node-detail-line"><span>${n.reason||`${n.allocated} / ${n.total} GPUs allocated`}</span><span>${n.partition}</span></div></button>`;}).join('');}
// Match a collected Slurm hostlist against one known node. Numeric ranges are
// tested in place, so even a very large range never expands into an array.
function hostlistContains(hostlist, hostname) {
  const tokens = [];
  let token = '', depth = 0;
  for (const char of String(hostlist || '')) {
    if (char === '[') depth++;
    if (char === ']') depth--;
    if (depth < 0 || depth > 1) return false;
    if (!depth && /[,\s]/.test(char)) {if (token) tokens.push(token); token = '';}
    else token += char;
  }
  if (depth) return false;
  if (token) tokens.push(token);
  return tokens.some(pattern => {
    if (!pattern.includes('[')) return pattern === hostname;
    const parts = pattern.split(/(\[[^\[\]]+\])/).filter(Boolean);
    if (parts.some(part => !/^\[[^\[\]]+\]$/.test(part) && /[\[\]]/.test(part))) return false;
    const seen = new Set();
    function matches(index, offset) {
      const key = `${index}:${offset}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (index === parts.length) return offset === hostname.length;
      const part = parts[index];
      if (!part.startsWith('[')) return hostname.startsWith(part, offset) && matches(index + 1, offset + part.length);
      const choices = part.slice(1, -1).split(',');
      for (let end = offset + 1; end <= hostname.length && /^\d+$/.test(hostname.slice(offset, end)); end++) {
        const candidate = hostname.slice(offset, end);
        const included = choices.some(choice => {
          if (/^\d+$/.test(choice)) return candidate === choice;
          const range = /^(\d+)-(\d+)$/.exec(choice);
          if (!range) return false;
          const [, first, last] = range, padded = /^0\d/.test(first) || /^0\d/.test(last);
          if (padded ? candidate.length !== Math.max(first.length, last.length) : /^0\d/.test(candidate)) return false;
          return BigInt(candidate) >= BigInt(first) && BigInt(candidate) <= BigInt(last);
        });
        if (included && matches(index + 1, end)) return true;
      }
      return false;
    }
    return matches(0, 0);
  });
}
function jobIsPending(job) {
  return ['PD', 'PENDING'].includes(job.state) || ['PD', 'PENDING'].includes(job.raw?.job_state);
}
function requestedNodeList(job) {
  const value = job.raw?.req_node_list;
  if (typeof value !== 'string') return '';
  const list = value.trim();
  return /^(?:|—|n\/a|none|null|\(none\)|\(null\))$/i.test(list) ? '' : list;
}
function jobIsUnassigned(job) {
  return jobIsPending(job)
    || ['', '—', '(null)', 'null', 'None', 'N/A'].includes(String(job.target || '').trim());
}
function jobMatchesServer(job, server) {
  if (!server) return true;
  if (server === '@unassigned') return jobIsUnassigned(job);
  // Pending reasons and batch hosts are not allocations. Match only the
  // explicit requested-node list already reported by the Slurm collector.
  if (jobIsPending(job)) return hostlistContains(requestedNodeList(job), server);
  return !jobIsUnassigned(job) && hostlistContains(job.target, server);
}
function jobTargetMarkup(job) {
  if (!jobIsPending(job)) return `<span title="${esc(displayNodeList(job.target))}">${esc(displayNodeList(job.target))}</span>`;
  const requested = requestedNodeList(job), label = requested ? `Requested: ${displayNodeList(requested)}` : 'Server not specified';
  const reason = reasons[job.target.replace(/^\(|\)$/g, '')] || job.target;
  return `<span class="job-requested-nodes" title="${esc(label)}">${esc(label)}</span><span title="${esc(job.target)}">${esc(reason)}</span>`;
}
function jobFilterUsers() {return [...new Set(jobs.map(job => job.user))].sort((a, b) => a.localeCompare(b));}
function jobFilterServers() {
  const known = nodes.filter(node => !node.isCloud).map(node => node.id);
  const ids = typeof liveState !== 'undefined' && liveState.mode === 'demo' ? known : [...nodeDisplayOrder, ...known];
  return [...new Set(ids)].sort((a, b) => nodeOrder(a) - nodeOrder(b) || displayNodeName(a).localeCompare(displayNodeName(b)));
}
const jobFilterMarkup = new WeakMap();
function renderFilterSelect(selector, value, entries) {
  if (!entries.some(([id]) => id === value)) entries.push([value, `${selector === '#job-server-filter' ? displayNodeName(value) : value} · No current jobs`]);
  const select = $(selector), html = entries.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
  if (jobFilterMarkup.get(select) !== html) {select.innerHTML = html; jobFilterMarkup.set(select, html);}
  select.value = value;
}
function renderJobFilters() {
  const users = jobFilterUsers(), servers = jobFilterServers();
  const options = [
    ['#job-user-filter', state.user, [['', 'All users'], ...users.map(user => [user, user])]],
    ['#job-server-filter', state.server, [['', 'All servers'], ...servers.map(id => [id, displayNodeName(id)]), ['@unassigned', 'Unassigned / pending']]]
  ];
  for (const [selector, value, entries] of options) renderFilterSelect(selector, value, entries);
  $('#reset-job-filters').disabled = !state.user && !state.server && !state.search && state.jobState === 'all';
}
function jobsForFilterCounts() {
  const q = state.search.toLowerCase();
  return currentJobs().filter(job => (!state.user || job.user === state.user) && jobMatchesServer(job, state.server)
    && [job.name, job.user, job.id, job.target, jobIsPending(job) ? requestedNodeList(job) : displayNodeList(job.target), jobIsPending(job) ? displayNodeList(requestedNodeList(job)) : '']
      .some(value => String(value ?? '').toLowerCase().includes(q)));
}
function filteredJobs(){return jobsForFilterCounts().filter(job => state.jobState === 'all' || job.state === state.jobState);}
function resetJobPage() {if (typeof liveState !== 'undefined') liveState.page = 1;}
function resetJobFilters() {
  Object.assign(state, {jobState: 'all', search: '', user: '', server: ''});
  $('#job-search').value = '';
  resetJobPage(); render();
}
function jobStatusClass(status) {
  const badge = {RUNNING: 'running', PENDING: 'pending', SUSPENDED: 'pending',
    COMPLETING: 'completing', CONFIGURING: 'completing', COMPLETED: 'completed',
    FAILED: 'down', CANCELLED: 'down', TIMEOUT: 'down'}[status] || 'idle';
  return `badge badge-${badge}${status === 'PENDING' ? ' pending' : ''}`;
}
function renderJobs(){renderJobFilters();const all=jobsForFilterCounts(),rows=filteredJobs();$('#job-count').textContent=all.length;$('#total-jobs').textContent=all.length;$('#running-jobs').textContent=all.filter(j=>j.state==='RUNNING').length;$('#pending-jobs').textContent=all.filter(j=>j.state==='PENDING').length;$('#job-rows').innerHTML=rows.length?rows.map((j,i)=>`<tr><td class="mono">${j.id}</td><td class="job-name-cell"><button class="job-name" data-job="${j.id}" title="${esc(j.name)}">${esc(j.name)}</button></td><td><span class="job-user"><span class="user-dot ${i%3===0?'lilac':i%3===1?'blue':''}" aria-hidden="true">${j.user.slice(0,1).toUpperCase()}</span>${esc(j.user)}</span></td><td><span class="job-status ${jobStatusClass(j.state)}">${j.state==='RUNNING'?'Running':'Pending'}</span></td><td class="mono">${j.gpus}</td><td class="job-target-cell ${j.state==='PENDING'?'pending-reason':'mono'}">${jobTargetMarkup(j)}</td><td><button class="table-arrow" data-job="${j.id}" aria-label="Job ${j.id} details">${icon('arrow')}</button></td></tr>`).join(''):'<tr><td colspan="7" class="empty-state">No matching jobs. Try another search or filter.</td></tr>';$('#result-count').textContent=`Showing ${rows.length} of ${all.length} jobs`;document.querySelectorAll('[data-state]').forEach(b=>{b.classList.toggle('active',b.dataset.state===state.jobState);b.setAttribute('aria-pressed',String(b.dataset.state===state.jobState));});}
function render(){renderNodes();renderJobs();}
function openDialog(html,eyebrow){$('#dialog-content').innerHTML=html;$('#dialog-eyebrow').textContent=eyebrow;$('#detail-dialog').showModal();}
const detailItem=(label,value)=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
function showNode(id){const n=nodes.find(n=>n.id===id);if(!n)return;const assigned=jobs.filter(j=>j.target===id);openDialog(`<h2 id="dialog-title">${esc(displayNodeName(n.id))}</h2><p class="dialog-subtitle">${partitionMeta[n.partition].model} × ${n.total} · ${n.partition}</p><dl class="detail-grid">${detailItem('Slurm state',n.state)}${detailItem('Allocated GPUs',`${n.allocated} / ${n.total}`)}${detailItem('Allocated CPUs',`${n.cpuAllocated} / ${n.cpu}`)}${detailItem('Collected at','Sep 22, 2026, 10:40 KST · Sample')}</dl><div class="dialog-gpus">${n.gpus.map(g=>`<div class="dialog-gpu ${g.util===null?'gpu-offline':''}"><strong>GPU ${g.index}</strong>${g.util===null?'No metrics':g.allocated?'Allocated':'Idle'}<span>Compute ${percent(g.util)}</span><span>${g.memoryUsed===null?'—':g.memoryUsed+' / '+g.memory+' GB'}</span><span>${g.temp===null?'—':g.temp+' °C'}</span></div>`).join('')}</div><p class="dialog-note">${n.reason?'Maintenance: '+n.reason+'. This node is not accepting new jobs.':'Dark GPU blocks indicate job allocations. An allocated GPU can have low utilization while loading data or waiting for I/O.'}</p>${assigned.length?`<p class="dialog-jobs" style="margin-top:16px">Running jobs: ${assigned.map(j=>`${j.id} · ${j.name}`).join('<br>')}</p>`:''}`,'GPU NODE · SAMPLE DATA');}
function showJob(id){const j=jobs.find(j=>j.id===id);if(!j)return;openDialog(`<h2 id="dialog-title">${esc(j.name)}</h2><p class="dialog-subtitle">Job ${j.id} · ${esc(j.user)}</p><dl class="detail-grid">${detailItem('State',j.state)}${detailItem('Partition',j.partition)}${detailItem(j.state==='RUNNING'?'Allocated GPUs':'Requested GPUs',`${j.gpus}`)}${detailItem(j.state==='RUNNING'?'Elapsed':'Time pending',j.elapsed)}${detailItem(j.state==='RUNNING'?'Assigned node':'Pending reason',j.state==='RUNNING'?displayNodeList(j.target):j.target)}${detailItem(j.state==='RUNNING'?'GPU indices':'Assigned node',j.state==='RUNNING'?j.indices.join(', '):'Not yet allocated')}</dl><p class="dialog-note">${j.state==='RUNNING'?'This job has been allocated resources and is running. GPU allocation and utilization are separate metrics.':j.target==='Dependency'?'Waiting for job 48217 to complete successfully.':j.target==='QOSMaxGRESPerUser'?'In this sample, the user has a limit of 4 GPUs, all currently allocated to diffusion-train.':j.target==='Priority'?'Waiting for higher-priority jobs in this partition to be scheduled.':`This job requests ${j.gpus} GPUs on one node, but sufficient matching resources are not available.`}</p>`,'SLURM JOB · SAMPLE DATA');}
function showDataInfo(){openDialog('<h2 id="dialog-title">Sample data</h2><p class="dialog-subtitle">This view uses a sample cluster snapshot.</p><div class="dialog-copy"><p>Node reports use <code>POST /api/report/node</code> and Slurm reports use <code>POST /api/report/slurm</code>.</p><p>The live dashboard displays reports received from the configured collectors. Sample data is provided separately for previewing the interface.</p><p>All nodes, job names, users, and metrics in this sample are fictional.</p></div>','DATA SOURCE');}
$('#job-search').addEventListener('input',e=>{state.search=e.target.value;resetJobPage();renderJobs();});
$('#job-user-filter').addEventListener('change',e=>{state.user=e.target.value;resetJobPage();renderJobs();});
$('#job-server-filter').addEventListener('change',e=>{state.server=e.target.value;resetJobPage();renderJobs();});
$('#reset-job-filters').addEventListener('click',resetJobFilters);
document.querySelectorAll('[data-state]').forEach(b=>b.addEventListener('click',()=>{state.jobState=b.dataset.state;resetJobPage();renderJobs();}));
document.addEventListener('click',e=>{const node=e.target.closest('[data-node]'),job=e.target.closest('[data-job]');if(node)showNode(node.dataset.node);if(job)showJob(job.dataset.job);});
$('#close-dialog').addEventListener('click',()=>$('#detail-dialog').close());
$('#detail-dialog').addEventListener('click',e=>{if(e.target===$('#detail-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('#sample-details').addEventListener('click',showDataInfo);
document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('#detail-dialog').open){e.preventDefault();$('#job-search').focus();$('#jobs').scrollIntoView({behavior:'smooth'});}});
mountIcons();
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), {once: true});
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'filter_cluster_dashboard', title: 'Filter cluster dashboard',
      description: 'Filter Slurm jobs by exact user, assigned server (or explicitly requested server for pending jobs), status, or search term. Filters combine; empty user/server clears that filter.',
      inputSchema: {type: 'object', properties: {
        jobState: {type: 'string', enum: ['all', 'RUNNING', 'PENDING']},
        search: {type: 'string', maxLength: 100},
        user: {type: 'string', maxLength: 128, description: 'Exact username, or an empty string for all users.'},
        server: {type: 'string', maxLength: 128, description: 'Node ID (devbox, server2, ubuntu, server4) matches assigned nodes or explicitly requested nodes for pending jobs. @unassigned includes all pending/unassigned jobs; an empty string includes all servers.'}
      }, additionalProperties: false},
      annotations: {readOnlyHint: false, untrustedContentHint: false},
      execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['jobState', 'search', 'user', 'server'].includes(key))
          || (input.jobState !== undefined && !['all', 'RUNNING', 'PENDING'].includes(input.jobState))
          || (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 100))
          || (input.user !== undefined && (typeof input.user !== 'string' || input.user.length > 128))
          || (input.server !== undefined && (typeof input.server !== 'string' || input.server.length > 128
            || !['', '@unassigned', state.server, ...jobFilterServers()].includes(input.server)))) throw new Error('Unsupported filter.');
        Object.assign(state, input); resetJobPage();
        $('#job-search').value = state.search;
        render();
        return {isSample: typeof liveState === 'undefined' || liveState.mode === 'demo', filters: {...state}, metrics: getMetrics(), visibleJobIds: filteredJobs().map(job => job.id)};
      }
    }, {signal: lifecycle.signal})).catch(() => {});
  } catch {}
}
