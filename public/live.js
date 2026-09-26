'use strict';
const demoData = {nodes: structuredClone(nodes), jobs: structuredClone(jobs), partitions: structuredClone(partitionMeta)};
const demoRender = {nodes: renderNodes, node: showNode, job: showJob, dataInfo: showDataInfo};
const REFRESH_INTERVAL_MS = 30000, ERROR_RETRY_BASE_MS = 120000, FRESHNESS_MS = 180000, QUOTA_RETRY_MS = 300000, MANUAL_COOLDOWN_MS = 5000;
const liveState = {mode: 'live', snapshot: null, error: null, errorKind: null, retryAt: null, loading: false, page: 1, lastRead: 0, lastAttemptAt: null, nextAttemptAt: 0, failureCount: 0};
let refreshTimer, refreshControlTimer, activeRequest;
const fresh = at => !liveState.error && Number.isFinite(at) && Date.now() - at < FRESHNESS_MS;
const validNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const stateNames = {R: 'RUNNING', PD: 'PENDING', CG: 'COMPLETING', S: 'SUSPENDED', CF: 'CONFIGURING', CD: 'COMPLETED', F: 'FAILED', CA: 'CANCELLED', TO: 'TIMEOUT'};
const stateLabels = {RUNNING: 'Running', PENDING: 'Pending', COMPLETING: 'Completing', SUSPENDED: 'Suspended', CONFIGURING: 'Configuring', COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled', TIMEOUT: 'Timed out'};
Object.assign(reasons, {ReqNodeNotAvail: 'Requested node unavailable', QOSMaxGRESPerUser: 'User GPU limit', JobHeldUser: 'Held by user', DependencyNeverSatisfied: 'Dependency cannot be satisfied', BeginTime: 'Waiting for scheduled start'});
const clockText = at => Number.isFinite(at) ? new Intl.DateTimeFormat('en-GB', {month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Seoul'}).format(at) + ' KST' : 'Not received';
function ageText(at) {
  if (!Number.isFinite(at)) return 'Not received';
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}
function normalizeSnapshot(snapshot) {
  jobs = (snapshot.slurm?.data.squeue || []).map(j => ({id: String(j.job_id), name: j.name || 'Unnamed job', user: j.user || 'Unknown', state: stateNames[j.job_state] || j.job_state || 'UNKNOWN', partition: j.partition || 'Unknown', gpus: j.req_gpus || '—', elapsed: j.time || '—', target: j.node_list_or_reason || j.reason || '—', indices: [], raw: j}));
  partitionMeta = Object.fromEntries([...new Set(jobs.map(j => j.partition))].map(p => [p, {label: 'Slurm job partition', model: p}]));
  const reported = new Map(snapshot.nodes.map(n => [n.data.server_name, n]));
  const sinfo = snapshot.slurm?.data.sinfo || [];
  const names = new Set([...sinfo.map(n => n.name || n.hostname), ...reported.keys()]);
  nodes = [...names].map(id => {
    const report = reported.get(id), raw = report?.data, isCloud = raw?.source_type === 'cloud', s = isCloud ? null : sinfo.find(n => (n.name || n.hostname) === id), stale = !fresh(report?.receivedAt);
    const gpus = (raw?.gpus || []).map(g => {
      const util = validNumber(g.gpu_utilization), memory = validNumber(g.vram_total_mb), memoryUsed = validNumber(g.vram_total_used_mb), processes = g.processes || [];
      return {index: g.id, uuid: g.uuid, model: g.gpu_name || 'Unknown model', util: !stale && !g.collection_error && util !== null && util >= 0 && util <= 100 ? util : null, memory: memory !== null && memory > 0 ? memory / 1024 : null, memoryUsed: memoryUsed !== null && memoryUsed >= 0 ? memoryUsed / 1024 : null, temp: null, allocated: processes.length > 0, processes, error: g.collection_error, jobRecords: isCloud ? [] : resolveGpuJobs(processes, jobs)};
    });
    return {id, isCloud, total: gpus.length, allocated: gpus.filter(g => g.allocated).length, state: isCloud ? 'CLOUD' : s?.state?.toUpperCase() || 'UNKNOWN', gpus, cpu: isCloud ? validNumber(raw.cpu_count) : s?.cpus ?? null, cpuAllocated: s?.alloc_cpus ?? null, receivedAt: report?.receivedAt, stale, raw, partitions: [], slurmFresh: isCloud ? null : fresh(snapshot.slurm?.receivedAt)};
  }).sort((a, b) => nodeOrder(a.id) - nodeOrder(b.id));
}
currentNodes = () => liveState.mode === 'demo' ? nodes.filter(n => state.partition === 'all' || n.partition === state.partition) : nodes;
const sampleNote = $('.sample-note');
function renderConnection() {
  const demo = liveState.mode === 'demo', snap = liveState.snapshot, hasData = !!(snap?.slurm || snap?.nodes?.length), staleNodes = nodes.filter(n => n.stale).length;
  const message = demo ? 'Sample cluster. All values and names are fictional.' : liveState.error ? `${liveState.error} ${hasData ? 'Showing last received data; live status is unavailable.' : 'Live data is unavailable.'}${liveState.errorKind === 'quota' ? ' Automatic retry within 5 minutes, or use Refresh now.' : ''}` : !hasData ? 'Waiting for collectors. This dashboard checks for reports every 30 seconds.' : `Slurm: ${ageText(snap.slurm?.receivedAt)} · ${snap.nodes.length}/${nodes.length} nodes reporting · Auto-refresh every 30 seconds${staleNodes ? ` · ${staleNodes} stale or missing` : ''}`;
  sampleNote.innerHTML = `${icon(demo ? 'flask' : liveState.error ? 'info' : 'activity')}<span>${esc(message)}</span><button id="retry-live">${demo ? 'Data source' : 'Refresh now'} ↗</button>`;
  $('#retry-live').onclick = () => demo ? showDataInfo() : loadSnapshot({force: true});
  renderRefreshControl();
  const times = demo ? [] : [snap?.slurm?.receivedAt, ...(snap?.nodes || []).map(n => n.receivedAt)].filter(Number.isFinite);
  $('.snapshot').innerHTML = `${icon('clock')}<span>${demo ? 'Sep 22, 10:40 KST · Sample' : times.length ? clockText(Math.max(...times)) : 'No reports received'}</span>`;
  const selected = state.partition;
  $('#partition-filter').innerHTML = '<option value="all">All job partitions</option>' + Object.keys(partitionMeta).map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  state.partition = Object.hasOwn(partitionMeta, selected) ? selected : 'all';
  $('#partition-filter').value = state.partition;
  $('.node-key').innerHTML = demo ? '<span><i class="green-dot"></i>Healthy</span><span><i class="amber-dot"></i>Maintenance</span>' : '<span><i class="green-dot"></i>Reporting</span><span><i class="amber-dot"></i>Stale / missing</span>';
  $('.table-footer>span:last-child').textContent = demo ? 'Slurm · Sample snapshot' : `Slurm: ${ageText(snap?.slurm?.receivedAt)}`;
}
function renderRefreshControl() {
  clearTimeout(refreshControlTimer);
  const button = $('#retry-live');
  if (!button || liveState.mode === 'demo') return;
  const remaining = liveState.lastAttemptAt === null ? 0 : Math.max(0, liveState.lastAttemptAt + MANUAL_COOLDOWN_MS - Date.now());
  button.disabled = liveState.loading || remaining > 0;
  button.textContent = liveState.loading ? 'Refreshing…' : remaining > 0 ? `Refresh in ${Math.ceil(remaining / 1000)}s` : 'Refresh now ↗';
  button.title = liveState.loading ? 'A refresh is in progress.' : remaining > 0 ? 'Please wait 5 seconds between refreshes.' : 'Fetch the latest reports now.';
  if (!document.hidden && !liveState.loading && remaining > 0) refreshControlTimer = setTimeout(renderRefreshControl, Math.min(1000, remaining));
}
// GPU indices from Slurm GRES do not necessarily match NVML device indices.
// Only process-reported Slurm IDs establish a GPU-to-job relationship.
function gpuJobsMarkup(n, g) {
  if (g.error) return '<span class="gpu-job-empty">GPU report unavailable</span>';
  if (n.isCloud) return cloudProcessesMarkup(n, g);
  if (!g.jobRecords.length) return `<span class="gpu-job-empty">${n.stale ? 'No process in last report' : 'No process observed'}</span>`;
  return g.jobRecords.map(record => {
    const user = record.users.join(', ') || 'User unavailable';
    const content = `<span class="gpu-job-meta"><span class="gpu-job-id">${record.jobId ? `#${esc(record.jobId)}` : 'Job ID unavailable'}</span><span class="gpu-job-user" title="User: ${esc(user)}">${esc(user)}</span></span><span class="gpu-job-name">${esc(record.name || 'Name unavailable')}</span>`;
    return record.job ? `<button class="gpu-job-link" data-job="${esc(record.job.id)}" title="Job ${esc(record.jobId)} · ${esc(user)} · ${esc(record.name)}" aria-label="Job ${esc(record.jobId)}: ${esc(record.name)} by ${esc(user)}, details">${content}</button>` : `<div class="gpu-job-unlinked" title="${esc(record.name || 'No matching Slurm job information')}">${content}</div>`;
  }).join('');
}
function cloudProcessesMarkup(n, g) {
  if (!g.processes.length) return `<span class="gpu-job-empty">${n.stale ? 'No process in last report' : 'No process observed'}</span>`;
  const users = new Map();
  for (const process of g.processes) {
    const user = typeof process.username === 'string' && process.username.trim() ? process.username : null;
    let group = users.get(user);
    if (!group) {group = {count: 0, pids: new Set()}; users.set(user, group);}
    const pid = process.pid, knownPid = typeof pid === 'number' && Number.isInteger(pid) && pid >= 0 || typeof pid === 'string' && /^\d+$/.test(pid);
    if (!knownPid || !group.pids.has(String(pid))) {
      group.count++;
      if (knownPid) group.pids.add(String(pid));
    }
  }
  return [...users].map(([user, group]) => `<div class="gpu-process-user"><span class="gpu-process-name" title="${esc(user || 'User unavailable')}">${esc(user || 'User unavailable')}</span><span class="gpu-process-count">${group.count} ${group.count === 1 ? 'process' : 'processes'}</span></div>`).join('');
}
function gpuJobsCaption(n) {
  if (n.stale) return 'Last observed · GPU data stale';
  if (n.isCloud) return 'Standalone · observed GPU processes';
  if (!n.slurmFresh) return 'Observed processes · Slurm data stale';
  return 'Jobs observed on each GPU';
}
function formatStorage(gib) {
  if (gib >= 1024) return `${(gib / 1024).toLocaleString('en-US', {maximumFractionDigits: 2})} TiB`;
  if (gib > 0 && gib < 1) return `${(gib * 1024).toLocaleString('en-US', {maximumFractionDigits: 1})} MiB`;
  return `${gib.toLocaleString('en-US', {maximumFractionDigits: 1})} GiB`;
}
function storageMarkup(n) {
  const raw = n.raw || {};
  const disks = [
    {label: 'Main disk', path: raw.disk_path, total: raw.total_disk_gb, free: raw.free_disk_gb, used: raw.used_disk_gb},
    {label: 'Data disk', path: raw.subdisk_path, total: raw.total_subdisk_gb, free: raw.free_subdisk_gb, used: raw.used_subdisk_gb}
  ].filter(disk => disk.path || [disk.total, disk.free, disk.used].some(value => validNumber(value) !== null));
  return `<div class="node-storage ${n.stale ? 'is-stale' : ''}" aria-label="Storage capacity"><div class="storage-heading"><span>Storage</span><span>${n.stale ? 'Stale report' : 'Available / Total'}</span></div>${disks.length ? disks.map(disk => {
    const total = validNumber(disk.total) !== null && disk.total > 0 ? disk.total : null;
    // Use the collector's available space. Total minus used can include space
    // reserved by the filesystem that ordinary users cannot write to.
    const free = validNumber(disk.free) !== null && disk.free >= 0 && (total === null || disk.free <= total) ? disk.free : null;
    return `<div class="storage-row"><span class="storage-label">${disk.label}${disk.path ? `<span class="storage-path">${esc(disk.path)}</span>` : ''}</span><span class="storage-values"><strong>${n.stale ? '—' : free === null ? 'Not reported' : `${formatStorage(free)} free`}</strong><span>${n.stale ? 'Awaiting fresh data' : total === null ? 'Total not reported' : `${formatStorage(total)} total`}</span></span></div>`;
  }).join('') : `<p class="storage-empty">${n.stale ? 'Awaiting fresh data' : 'Not reported'}</p>`}</div>`;
}
renderNodes = function() {
  if (liveState.mode === 'demo') return demoRender.nodes();
  $('#node-count').textContent = liveState.snapshot ? nodes.length : '—';
  $('#node-grid').innerHTML = nodes.length ? nodes.map(n => {
    const valid = n.gpus.filter(g => g.util !== null), memory = n.gpus.filter(g => !g.error && g.memory !== null && g.memoryUsed !== null);
    const util = valid.length ? average(valid.map(g => g.util)) : null, mem = !n.stale && memory.length ? 100 * memory.reduce((sum, g) => sum + g.memoryUsed, 0) / memory.reduce((sum, g) => sum + g.memory, 0) : null;
    const models = [...new Set(n.gpus.map(g => g.model))].join(' / ');
    return `<article class="node live-node ${n.stale ? 'drain-node' : ''}" aria-label="${esc(displayNodeName(n.id))}">
      <button class="node-summary" data-node="${esc(n.id)}" aria-label="${esc(displayNodeName(n.id))} details">
        <div class="node-header"><div class="node-title">${icon('server')}<span class="node-name">${esc(displayNodeName(n.id))}</span></div><span class="state-badge ${n.stale ? 'drain' : n.isCloud ? 'cloud' : 'mixed'}">${esc(n.state)}${(n.isCloud ? n.stale : !n.slurmFresh) ? ' · stale' : ''}</span></div>
        <div class="node-model">${esc(models || 'No GPU report')}${n.gpus.length ? ` × ${n.gpus.length}` : ''}</div>
        <div class="gpu-blocks">${n.gpus.length ? n.gpus.map(g => `<span class="gpu-block ${g.util === null ? 'unavailable' : g.allocated ? 'occupied' : ''}" title="GPU ${esc(g.index)} · ${g.util === null ? 'No fresh metrics' : g.allocated ? 'Process observed' : 'No process observed'}">${esc(g.index)}</span>`).join('') : '<span class="node-no-gpu">Waiting for the node collector</span>'}</div>
        <div class="node-stats"><span>Compute <strong>${percent(util)}</strong></span><span>VRAM <strong>${percent(mem)}</strong></span><span>CPU <strong>${!n.stale && validNumber(n.raw?.cpu_percent) !== null ? Math.round(n.raw.cpu_percent) + '%' : '—'}</strong></span></div>
        ${storageMarkup(n)}
        <div class="node-detail-line"><span>${esc(ageText(n.receivedAt))}</span><span>${n.stale ? 'Stale / missing' : `${n.allocated} GPUs with processes`}</span></div>
      </button>
      ${n.gpus.length ? `<div class="gpu-jobs-summary"><p class="gpu-jobs-caption ${n.stale || (!n.isCloud && !n.slurmFresh) ? 'is-stale' : ''}">${gpuJobsCaption(n)}</p><div class="gpu-jobs-heading"><span>GPU</span><span>${n.isCloud ? 'User / Processes' : 'Job ID · User / Job name'}</span></div>${n.gpus.map(g => `<div class="gpu-job-row" data-gpu-index="${esc(g.index)}"><span class="gpu-job-index">${esc(g.index)}</span><div class="gpu-job-items">${gpuJobsMarkup(n, g)}</div></div>`).join('')}</div>` : ''}
    </article>`;
  }).join('') : `<div class="waiting-nodes"><span class="small-icon">${icon('server')}</span><h3>${liveState.error ? 'Cluster data is unavailable' : 'Waiting for node reports'}</h3><p>${liveState.error ? 'The last request failed. The dashboard will retry automatically.' : 'Received node reports will appear here automatically.'}</p><button id="waiting-help">Collector details ↗</button></div>`;
  $('#waiting-help')?.addEventListener('click', showDataInfo);
};
renderJobs = function() {
  const all = currentJobs(), rows = filteredJobs(), pages = Math.max(1, Math.ceil(rows.length / 12)), hasSlurm = liveState.mode === 'demo' || !!liveState.snapshot?.slurm;
  liveState.page = Math.min(liveState.page, pages);
  const visible = rows.slice((liveState.page - 1) * 12, liveState.page * 12);
  $('#job-count').textContent = hasSlurm ? all.length : '—';
  $('#total-jobs').textContent = hasSlurm ? all.length : '—';
  $('#running-jobs').textContent = hasSlurm ? all.filter(j => j.state === 'RUNNING').length : '—';
  $('#pending-jobs').textContent = hasSlurm ? all.filter(j => j.state === 'PENDING').length : '—';
  $('#job-rows').innerHTML = visible.length ? visible.map((j, i) => `<tr><td class="mono">${esc(j.id)}</td><td><button class="job-name" data-job="${esc(j.id)}">${esc(j.name)}</button></td><td><span class="job-user"><span class="user-dot ${i % 3 === 0 ? 'lilac' : i % 3 === 1 ? 'blue' : ''}" aria-hidden="true">${esc(j.user.slice(0, 1).toUpperCase())}</span>${esc(j.user)}</span></td><td><span class="job-status ${j.state === 'PENDING' ? 'pending' : ''}">${esc(stateLabels[j.state] || j.state)}</span></td><td><span class="partition-chip">${esc(j.partition)}</span></td><td class="mono">${esc(j.gpus)}</td><td class="mono">${j.state === 'PENDING' ? '—' : esc(j.elapsed)}</td><td class="${j.state === 'PENDING' ? 'pending-reason' : 'mono'}"><span title="${esc(j.state === 'PENDING' ? j.target : displayNodeList(j.target))}">${esc(j.state === 'PENDING' ? reasons[j.target.replace(/^\(|\)$/g, '')] || j.target : displayNodeList(j.target))}</span></td><td><button class="table-arrow" data-job="${esc(j.id)}" aria-label="Job ${esc(j.id)} details">${icon('arrow')}</button></td></tr>`).join('') : `<tr><td colspan="9" class="empty-state">${liveState.mode === 'live' && !liveState.snapshot?.slurm ? liveState.error ? 'Slurm data is unavailable while the request is failing.' : 'Waiting for Slurm reports.' : all.length === 0 ? 'No jobs in the latest report.' : 'No matching jobs. Try another search or filter.'}</td></tr>`;
  $('#result-count').textContent = hasSlurm ? `${rows.length} jobs · Showing ${visible.length ? ((liveState.page - 1) * 12 + 1) + '–' + Math.min(liveState.page * 12, rows.length) : 0}` : liveState.error ? 'Slurm data unavailable' : 'Waiting for Slurm reports';
  $('#page-number').textContent = `${liveState.page} / ${pages}`;
  $('#prev-page').disabled = liveState.page === 1;
  $('#next-page').disabled = liveState.page === pages;
  document.querySelectorAll('[data-state]').forEach(b => {b.classList.toggle('active', b.dataset.state === state.jobState); b.setAttribute('aria-pressed', String(b.dataset.state === state.jobState));});
};
showNode = function(id) {
  if (liveState.mode === 'demo') return demoRender.node(id);
  const n = nodes.find(n => n.id === id);
  if (!n) return;
  const memory = n.raw;
  const context = n.isCloud ? 'Standalone cloud node · no Slurm' : `${n.state}${n.slurmFresh ? '' : ' · Slurm data stale'}`;
  const cpuDetail = n.isCloud ? detailItem('CPU cores', n.cpu ?? 'Not reported') : detailItem('Slurm CPU allocation', n.cpu !== null ? `${n.cpuAllocated ?? '—'} / ${n.cpu}${n.slurmFresh ? '' : ' (stale)'}` : 'Not reported');
  const note = n.isCloud ? 'This standalone cloud node reports GPU processes and users without Slurm. Process counts do not indicate reserved GPU allocations.' : 'Jobs are linked using the Slurm IDs of processes observed on each GPU. A reserved GPU may have no process yet. Missing IDs or ambiguous matches are shown as unavailable.';
  openDialog(`<h2 id="dialog-title">${esc(displayNodeName(n.id))}</h2><p class="dialog-subtitle">${esc(context)} · ${esc(ageText(n.receivedAt))}</p><dl class="detail-grid">${detailItem('GPU report', n.stale ? liveState.error ? 'Live refresh unavailable; last report shown' : 'Missing or over 3 minutes old' : 'Fresh report')}${cpuDetail}${detailItem('Host RAM', memory?.ram_used_gb !== null && memory?.ram_used_gb !== undefined ? `${memory.ram_used_gb} / ${memory.ram_total_gb} GiB${n.stale ? ' (stale)' : ''}` : 'Not reported')}${detailItem('Report received at', clockText(n.receivedAt))}</dl>
    ${storageMarkup(n)}<p class="storage-note">Free space is available to users and excludes filesystem reserves. 1 TiB = 1,024 GiB.</p>
    <p class="gpu-jobs-caption ${n.stale || (!n.isCloud && !n.slurmFresh) ? 'is-stale' : ''}">${gpuJobsCaption(n)}</p><div class="dialog-gpus with-jobs">${n.gpus.map(g => `<div class="dialog-gpu ${g.util === null ? 'gpu-offline' : ''}"><strong>GPU ${esc(g.index)}</strong><span>Compute ${percent(g.util)}</span><span>${g.memoryUsed === null || g.memory === null || n.stale || g.error ? 'VRAM —' : `VRAM ${g.memoryUsed.toFixed(1)} / ${g.memory.toFixed(1)} GiB`}</span><div class="dialog-gpu-jobs"><span class="gpu-jobs-label">${n.isCloud ? 'User / Processes' : 'Job ID · User / Job name'}</span>${gpuJobsMarkup(n, g)}</div></div>`).join('')}</div>
    <p class="dialog-note">${note} Reports older than 3 minutes, or shown during a failed refresh, are marked stale and excluded from current utilization.</p>`, n.isCloud ? 'CLOUD NODE · LIVE REPORTS' : 'GPU NODE · LIVE REPORTS');
};
showJob = function(id) {
  if (liveState.mode === 'demo') return demoRender.job(id);
  const j = jobs.find(j => j.id === id);
  if (!j) return;
  const slurmFresh = fresh(liveState.snapshot?.slurm?.receivedAt);
  const observed = slurmFresh ? nodes.filter(n => !n.isCloud).flatMap(n => n.gpus.filter(g => !n.stale && !g.error && g.jobRecords.some(record => record.job?.id === j.id)).map(g => `${displayNodeName(n.id)} / GPU ${g.index}`)) : [];
  openDialog(`<h2 id="dialog-title">${esc(j.name)}</h2><p class="dialog-subtitle">Job ${esc(j.id)} · ${esc(j.user)}${slurmFresh ? '' : ' · Slurm data stale'}</p><dl class="detail-grid">${detailItem('State', stateLabels[j.state] || j.state)}${detailItem('Partition', j.partition)}${detailItem('Requested GPUs (reported)', j.gpus)}${detailItem('Elapsed', j.state === 'PENDING' ? 'Not started' : j.elapsed)}${detailItem(j.state === 'PENDING' ? 'Pending reason' : 'Assigned nodes', j.state === 'PENDING' ? j.target : displayNodeList(j.target))}${detailItem('Observed GPUs', slurmFresh ? observed.join(', ') || 'No current process match' : 'Unavailable while Slurm data is stale')}${detailItem('Requested CPUs', j.raw.req_cpus || 'Not reported')}${detailItem('Slurm report received at', clockText(liveState.snapshot?.slurm?.receivedAt))}</dl><p class="dialog-note">${j.state === 'PENDING' ? 'Submission time is not collected, so time pending is unavailable. ' : ''}Requested GPUs are shown as reported by the collector. GPUs with observed processes may differ from the reserved GPU list.</p>`, 'SLURM JOB · LIVE REPORTS');
};
showDataInfo = function() {
  openDialog('<h2 id="dialog-title">Collector connection</h2><p class="dialog-subtitle">Live reports from your node and Slurm collectors.</p><div class="dialog-copy"><p>Node reports arrive at <code>POST /api/report/node</code> and Slurm reports at <code>POST /api/report/slurm</code>, authenticated with the collectors\' reporting token.</p><p>The dashboard updates every 30 seconds while this tab is visible. Background tabs pause updates and refresh on return. Reports older than 3 minutes are marked stale. Failed refreshes retain the last received reports with stale status. Missing metrics are shown as unavailable rather than zero. During a daily database limit, automatic retries are spaced up to 5 minutes apart; Refresh now checks immediately, with at least 5 seconds between requests.</p><p>GPU jobs are matched using process Slurm IDs and exact job aliases. Job names come from the Slurm queue or the process report. GPUs without observed processes can still be reserved.</p><p>Standalone cloud nodes show GPU users and process counts independently of the lab Slurm queue.</p></div>', 'DATA SOURCE');
};
render = function() {renderConnection(); renderNodes(); renderJobs();};
function scheduleSnapshotRefresh(at = liveState.nextAttemptAt, resume = false) {
  clearTimeout(refreshTimer);
  if (document.hidden || liveState.mode !== 'live') return;
  refreshTimer = setTimeout(() => loadSnapshot({resume}), Math.max(0, at - Date.now()));
}
function validSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || (snapshot.history !== undefined && !Array.isArray(snapshot.history))) return false;
  if (!snapshot.nodes.every(report => report?.data && typeof report.data.server_name === 'string'
    && Array.isArray(report.data.gpus) && report.data.gpus.every(gpu => gpu && typeof gpu === 'object'
      && (gpu.processes === undefined || Array.isArray(gpu.processes) && gpu.processes.every(process => process && typeof process === 'object'))))) return false;
  if (snapshot.slurm === null || snapshot.slurm === undefined) return true;
  const data = snapshot.slurm.data;
  return !!data && Array.isArray(data.squeue) && Array.isArray(data.sinfo)
    && data.squeue.every(job => job && (typeof job.job_id === 'string' || typeof job.job_id === 'number')
      && ['name', 'user', 'job_state', 'partition', 'node_list_or_reason', 'reason'].every(key => job[key] === undefined || job[key] === null || typeof job[key] === 'string'))
    && data.sinfo.every(node => node && (typeof node.name === 'string' || typeof node.hostname === 'string')
      && (node.state === undefined || node.state === null || typeof node.state === 'string'));
}
async function loadSnapshot({force = false, resume = false} = {}) {
  if (document.hidden || liveState.loading || liveState.mode !== 'live') return;
  const cooldownUntil = liveState.lastAttemptAt === null ? 0 : liveState.lastAttemptAt + MANUAL_COOLDOWN_MS;
  const allowedAt = Math.max(force || resume ? cooldownUntil : 0, !force && (!resume || liveState.error) ? liveState.nextAttemptAt : 0);
  if (Date.now() < allowedAt) {
    if (force) renderRefreshControl();
    else scheduleSnapshotRefresh(allowedAt, resume);
    return;
  }
  clearTimeout(refreshTimer);
  liveState.loading = true;
  liveState.lastAttemptAt = Date.now();
  renderRefreshControl();
  const request = {controller: new AbortController(), paused: false};
  activeRequest = request;
  const timer = setTimeout(() => request.controller.abort(), 10000);
  try {
    const response = await fetch('/api/snapshot', {cache: 'no-store', signal: request.controller.signal});
    const snapshot = await response.json().catch(error => {if (error?.name === 'AbortError') throw error; return null;});
    if (request.paused) return;
    if (!response.ok) {
      if (response.status === 503 && snapshot?.error === 'storage_quota_exceeded') {
        const now = Date.now(), nextUtcDay = Math.floor(now / 86400000) * 86400000 + 86400000;
        const retryAt = Number.isFinite(snapshot.retry_at) && snapshot.retry_at > now && snapshot.retry_at <= now + 2 * 86400000 ? snapshot.retry_at : nextUtcDay;
        throw Object.assign(new Error(), {publicMessage: `Daily database limit reached. Resets ${clockText(retryAt)}.`, kind: 'quota', retryAt});
      }
      throw Object.assign(new Error(), {publicMessage: response.status === 401 ? 'Authentication required.' : `Unable to refresh. Server returned ${response.status}.`});
    }
    if (!validSnapshot(snapshot)) throw Object.assign(new Error(), {publicMessage: 'Unable to refresh. Unexpected server response.'});
    if (liveState.mode !== 'live') return;
    liveState.error = null;
    liveState.errorKind = null;
    liveState.retryAt = null;
    normalizeSnapshot(snapshot);
    liveState.snapshot = snapshot;
    liveState.lastRead = Date.now();
    liveState.failureCount = 0;
    liveState.nextAttemptAt = Date.now() + REFRESH_INTERVAL_MS;
  } catch (error) {
    if (liveState.mode === 'live' && !request.paused) {
      liveState.error = error?.name === 'AbortError' ? 'No response within 10 seconds.' : error?.publicMessage || 'Unable to refresh. Please check your connection and try again.';
      liveState.errorKind = error?.kind === 'quota' ? 'quota' : 'request';
      liveState.retryAt = error?.kind === 'quota' ? error.retryAt : null;
      liveState.failureCount += 1;
      const retryDelay = liveState.errorKind === 'quota' ? Math.min(QUOTA_RETRY_MS, Math.max(ERROR_RETRY_BASE_MS, liveState.retryAt - Date.now())) : Math.min(QUOTA_RETRY_MS, ERROR_RETRY_BASE_MS * liveState.failureCount);
      liveState.nextAttemptAt = Date.now() + retryDelay;
      if (liveState.snapshot) normalizeSnapshot(liveState.snapshot);
      else {nodes = []; jobs = []; partitionMeta = {};}
    }
  } finally {
    clearTimeout(timer);
    if (activeRequest === request) activeRequest = null;
    liveState.loading = false;
    if (liveState.mode === 'live') {
      if (!document.hidden) render();
      if (request.paused && !document.hidden) loadSnapshot({resume: true});
      else scheduleSnapshotRefresh();
    }
  }
}
$('#prev-page').onclick = () => {liveState.page = Math.max(1, liveState.page - 1); renderJobs();};
$('#next-page').onclick = () => {liveState.page++; renderJobs();};
$('#job-search').addEventListener('input', () => {liveState.page = 1; renderJobs();});
$('#partition-filter').addEventListener('change', () => {liveState.page = 1; renderJobs();});
document.querySelectorAll('[data-state]').forEach(b => b.addEventListener('click', () => {liveState.page = 1; renderJobs();}));
nodes = []; jobs = []; partitionMeta = {};
render(); loadSnapshot();
document.addEventListener('visibilitychange', () => {
  clearTimeout(refreshTimer);
  clearTimeout(refreshControlTimer);
  if (document.hidden) {
    if (activeRequest) {activeRequest.paused = true; activeRequest.controller.abort();}
    return;
  }
  if (liveState.snapshot) normalizeSnapshot(liveState.snapshot);
  render();
  loadSnapshot({resume: true});
});
