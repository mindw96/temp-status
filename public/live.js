'use strict';
const demoData = {nodes: structuredClone(nodes), jobs: structuredClone(jobs), partitions: structuredClone(partitionMeta)};
const demoRender = {nodes: renderNodes, node: showNode, job: showJob, dataInfo: showDataInfo};
const REFRESH_INTERVAL_MS = 30000, ERROR_RETRY_BASE_MS = 120000, FRESHNESS_MS = 180000, QUOTA_RETRY_MS = 300000, MANUAL_COOLDOWN_MS = 5000;
const JOBS_PER_PAGE = 10;
const liveState = {mode: 'live', snapshot: null, error: null, errorKind: null, retryAt: null, loading: false, page: 1, lastRead: 0, lastAttemptAt: null, nextAttemptAt: 0, failureCount: 0};
let refreshTimer, refreshControlTimer, activeRequest;
const fresh = at => !liveState.error && Number.isFinite(at) && Date.now() - at < FRESHNESS_MS;
const validNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
function slurmResources(node) {
  const total = node?.cpus ?? node?.cpus_total, allocated = node?.alloc_cpus ?? node?.cpus_allocated, idle = node?.idle_cpus;
  // Slurm's Other CPUs are not idle. Do not count them as free capacity.
  const cpu = [total, allocated, idle].every(Number.isInteger) && total > 0 && allocated >= 0 && idle >= 0 && allocated + idle <= total
    ? {total, allocated, free: idle} : null;
  const memory = validNumber(node?.real_memory), reserved = validNumber(node?.mem_spec_limit ?? 0), used = validNumber(node?.alloc_memory);
  const ram = memory !== null && reserved !== null && used !== null && memory > 0 && reserved >= 0 && reserved < memory && used >= 0 && used <= memory - reserved
    ? {total: (memory - reserved) / 1024, allocated: used / 1024, free: (memory - reserved - used) / 1024} : null;
  return {cpu, ram};
}
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
      const observedJobRecords = isCloud ? [] : resolveGpuJobs(processes, jobs);
      const allocationRecords = isCloud || stale || !fresh(snapshot.slurm?.receivedAt) ? [] : resolveAllocatedGpuJobs(id, g.slurm_gres_index, jobs);
      const jobRecords = allocationRecords.length ? allocationRecords : observedJobRecords;
      return {index: g.id, uuid: g.uuid, model: g.gpu_name || 'Unknown model', util: !stale && !g.collection_error && util !== null && util >= 0 && util <= 100 ? util : null, memory: memory !== null && memory > 0 ? memory / 1024 : null, memoryUsed: memoryUsed !== null && memoryUsed >= 0 && (memory === null || memoryUsed <= memory) ? memoryUsed / 1024 : null, temp: null, allocated: isCloud ? processes.length > 0 : allocationRecords.length > 0, occupied: allocationRecords.length > 0 || processes.length > 0, gresIndex: g.slurm_gres_index, processes, error: g.collection_error, jobRecords, observedJobRecords, allocationRecords};
    });
    return {id, isCloud, total: gpus.length, allocated: gpus.filter(g => g.allocated).length, state: isCloud ? 'CLOUD' : s?.state?.toUpperCase() || 'UNKNOWN', gpus, cpu: isCloud ? validNumber(raw.cpu_count) : s?.cpus ?? null, cpuAllocated: s?.alloc_cpus ?? null, slurmResources: slurmResources(s), receivedAt: report?.receivedAt, stale, raw, partitions: [], slurmFresh: isCloud ? null : fresh(snapshot.slurm?.receivedAt)};
  }).sort((a, b) => nodeOrder(a.id) - nodeOrder(b.id));
}
const connectionStatus = $('#connection-status');
function renderConnection() {
  const demo = liveState.mode === 'demo', snap = liveState.snapshot, hasData = !!(snap?.slurm || snap?.nodes?.length);
  const message = demo ? 'Sample cluster. All values and names are fictional.' : liveState.error ? `${liveState.error} ${hasData ? 'Showing last received data; live status is unavailable.' : 'Live data is unavailable.'}${liveState.errorKind === 'quota' ? ' Automatic retry within 5 minutes, or use Refresh now.' : ''}` : !hasData ? 'Waiting for collectors. This dashboard checks for reports every 30 seconds.' : '';
  connectionStatus.textContent = message;
  connectionStatus.hidden = !message;
  $('#retry-live').onclick = () => demo ? showDataInfo() : loadSnapshot({force: true});
  renderRefreshControl();
  const times = demo ? [] : [snap?.slurm?.receivedAt, ...(snap?.nodes || []).map(n => n.receivedAt)].filter(Number.isFinite);
  $('.snapshot').innerHTML = `${icon('clock')}<span>${demo ? 'Sep 22, 10:40 KST · Sample' : times.length ? clockText(Math.max(...times)) : 'No reports received'}</span>`;
}
function renderRefreshControl() {
  clearTimeout(refreshControlTimer);
  const button = $('#retry-live');
  if (!button) return;
  if (liveState.mode === 'demo') {
    button.disabled = false;
    button.textContent = 'Data source';
    button.title = 'About the sample data.';
    return;
  }
  const remaining = liveState.lastAttemptAt === null ? 0 : Math.max(0, liveState.lastAttemptAt + MANUAL_COOLDOWN_MS - Date.now());
  button.disabled = liveState.loading || remaining > 0;
  button.textContent = liveState.loading ? 'Refreshing…' : remaining > 0 ? `Refresh in ${Math.ceil(remaining / 1000)}s` : 'Refresh now';
  button.title = liveState.loading ? 'A refresh is in progress.' : remaining > 0 ? 'Please wait 5 seconds between refreshes.' : 'Fetch the latest reports now. Automatically refreshes every 30 seconds.';
  if (!document.hidden && !liveState.loading && remaining > 0) refreshControlTimer = setTimeout(renderRefreshControl, Math.min(1000, remaining));
}
// GPU indices from Slurm GRES do not necessarily match NVML device indices.
// Prefer verified device allocations; process IDs provide an explicit fallback.
function gpuJobsMarkup(n, g, compactCard = false) {
  const index = compactCard ? `<span class="gpu-job-index gpu-id">GPU ${esc(g.index)}</span>` : '';
  const empty = (message, idle = false) => compactCard
    ? `<div class="gpu-job-unlinked gpu-job-vacant" title="${esc(message)}"><span class="gpu-card-header">${index}${idle ? '' : `<span class="gpu-job-status">${esc(message)}</span>`}</span><span class="gpu-job-name gpu-job-placeholder" aria-hidden="true">&nbsp;</span><span class="sr-only">${esc(message)}</span></div>`
    : `<span class="gpu-job-empty">${esc(message)}</span>`;
  if (g.error && !g.allocationRecords?.length) return empty('GPU report unavailable');
  if (n.isCloud) return !g.processes.length ? empty(n.stale ? 'No process in last report' : 'No process observed', !n.stale) : `${compactCard ? `<div class="gpu-card-header">${index}</div>` : ''}${cloudProcessesMarkup(n, g)}`;
  if (!g.jobRecords.length) {
    const mapped = Number.isInteger(g.gresIndex) && g.gresIndex >= 0, idle = !n.stale && n.slurmFresh && mapped;
    return empty(n.stale ? 'GPU data stale' : !n.slurmFresh ? 'Slurm data stale' : !mapped ? 'Allocation unavailable' : 'No allocation reported', idle);
  }
  return g.jobRecords.map((record, position) => {
    const user = record.users.map(displayUserName).join(', ') || 'User unavailable', source = record.allocated ? 'Slurm allocated' : 'Observed process';
    const userLabel = record.allocated ? user : `Observed: ${user}`;
    const meta = `<span class="gpu-job-meta"><span class="gpu-job-id">${record.jobId ? esc(record.jobId) : 'Job ID unavailable'}</span><span class="gpu-job-separator" aria-hidden="true">-</span><span class="gpu-job-user" title="${source} · User: ${esc(user)}">${esc(userLabel)}</span></span>`;
    const content = `${compactCard ? `<span class="gpu-card-header">${position === 0 ? index : ''}${meta}</span>` : meta}<span class="gpu-job-name">${esc(record.name || 'Name unavailable')}</span>`;
    return record.job ? `<button class="gpu-job-link" data-job="${esc(record.job.id)}" data-source="${record.allocated ? 'allocation' : 'process'}" title="${source} · Job ${esc(record.jobId)} · ${esc(user)} · ${esc(record.name)}" aria-label="${source} · Job ${esc(record.jobId)}: ${esc(record.name)} by ${esc(user)}, details">${content}</button>` : `<div class="gpu-job-unlinked" title="${esc(record.name || 'No matching Slurm job information')}">${content}</div>`;
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
  return [...users].map(([user, group]) => `<div class="gpu-process-user"><span class="gpu-process-name" title="${esc(user ? displayUserName(user) : 'User unavailable')}">${esc(user ? displayUserName(user) : 'User unavailable')}</span><span class="gpu-process-count">${group.count} ${group.count === 1 ? 'process' : 'processes'}</span></div>`).join('');
}
function gpuJobsCaption(n) {
  if (n.stale) return 'Last observed · GPU data stale';
  if (n.isCloud) return 'Standalone · observed GPU processes';
  if (!n.slurmFresh) return 'Observed processes · Slurm data stale';
  return '';
}
function gpuJobsCaptionMarkup(n) {
  const caption = gpuJobsCaption(n);
  return caption ? `<p class="gpu-jobs-caption ${n.stale || (!n.isCloud && !n.slurmFresh) ? 'is-stale' : ''}">${esc(caption)}</p>` : '';
}
const compactGiB = value => value.toLocaleString('en-US', {maximumFractionDigits: 1, useGrouping: false});
function resourceMarkup(label, value) {
  const usable = validNumber(value) !== null && value >= 0 && value <= 100 ? value : null;
  return `<div class="resource-row"><div class="resource-line"><span class="metric-label">${esc(label)}</span><strong class="metric-value">${percent(usable)}</strong></div></div>`;
}
function allocationStatus(n, resource) {
  if (!n.slurmFresh) return 'Stale';
  if (/DOWN|DRAIN|FAIL|MAINT|UNKNOWN|NOT_RESPONDING|POWER|REBOOT|FUTURE|\*/.test(n.state)) return 'Unavailable';
  return resource ? '' : 'Not reported';
}
const allocationNumber = value => value.toLocaleString('en-US', {maximumFractionDigits: 1});
function allocationDescription(n, key) {
  const resource = n.slurmResources[key], status = allocationStatus(n, resource);
  if (status) return status;
  const {total, allocated, free} = resource, unit = key === 'ram' ? ' GiB' : '';
  const other = total - allocated - free;
  return `${allocationNumber(allocated)}${unit} allocated · ${allocationNumber(free)}${unit} free · ${allocationNumber(total)}${unit} total${other > 0 ? ` · ${allocationNumber(other)} unavailable` : ''} · Slurm`;
}
function allocationMarkup(n, key) {
  const resource = n.slurmResources[key], status = allocationStatus(n, resource), unit = key === 'ram' ? ' GiB' : '';
  const value = status || `${compactGiB(resource.free)}<span class="allocation-total"> / ${compactGiB(resource.total)}${unit}</span>`;
  return `<div class="resource-row" title="${esc(allocationDescription(n, key))}"><div class="resource-line"><span class="metric-label">${key.toUpperCase()}</span><strong class="metric-value">${value}</strong></div></div>`;
}
function usageMeterMarkup(label, value, className) {
  const usable = validNumber(value) !== null && value >= 0 && value <= 100 ? value : null;
  // Blend through the 30% and 70% boundaries instead of abruptly switching colors.
  const blend = (start, end) => Math.max(0, Math.min(1, (usable - start) / (end - start)));
  const hue = usable === null ? null : 140 - 108 * blend(25, 35) - 32 * blend(65, 75);
  return usable === null
    ? `<span class="${esc(className)} is-unavailable" aria-hidden="true"></span>`
    : `<span class="${esc(className)}" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${usable}"><span style="width:${usable}%;--usage-meter-hue:${hue}" aria-hidden="true"></span></span>`;
}
function gpuMetricMarkup(label, value, capacity = '') {
  const usable = validNumber(value) !== null && value >= 0 && value <= 100 ? value : null;
  const meter = usageMeterMarkup(label, usable, 'gpu-meter');
  return `<div class="gpu-metric"><span class="gpu-metric-label">${esc(label)}</span>${meter}<span class="gpu-metric-value"><strong>${percent(usable)}</strong> <span class="gpu-memory">${esc(capacity)}</span></span></div>`;
}
function gpuBlockMarkup(n, g) {
  const available = !n.stale && !g.error;
  const occupied = !n.stale && ((!n.isCloud && n.slurmFresh && g.allocated) || (!g.error && g.processes.length > 0));
  const util = available ? g.util : null;
  const memoryAvailable = available && validNumber(g.memoryUsed) !== null && validNumber(g.memory) !== null && g.memory > 0 && g.memoryUsed >= 0 && g.memoryUsed <= g.memory;
  const vramPercent = memoryAvailable ? g.memoryUsed / g.memory * 100 : null;
  const capacity = memoryAvailable ? `(${compactGiB(g.memoryUsed)} / ${compactGiB(g.memory)} GiB)` : '';
  return `<div class="gpu-job-row gpu-block${occupied ? ' occupied' : ''}" data-gpu-index="${esc(g.index)}"><div class="gpu-job-items">${gpuJobsMarkup(n, g, true)}</div><div class="gpu-metrics">${gpuMetricMarkup('UTIL', util)}${gpuMetricMarkup('VRAM', vramPercent, capacity)}</div></div>`;
}
function storageMarkup(n) {
  const raw = n.raw || {};
  const disks = [
    {label: 'Main disk', path: raw.disk_path, total: raw.total_disk_gb, free: raw.free_disk_gb, used: raw.used_disk_gb},
    {label: 'Data disk', path: raw.subdisk_path, total: raw.total_subdisk_gb, free: raw.free_subdisk_gb, used: raw.used_subdisk_gb}
  ].filter(disk => disk.path || [disk.total, disk.free, disk.used].some(value => validNumber(value) !== null));
  return `<div class="node-storage ${n.stale ? 'is-stale' : ''}" aria-label="Storage capacity: percent used, free / total GiB">${disks.length ? disks.map(disk => {
    const total = validNumber(disk.total) !== null && disk.total > 0 ? disk.total : null;
    // Use the collector's available space. Total minus used can include space
    // reserved by the filesystem that ordinary users cannot write to.
    const free = validNumber(disk.free) !== null && disk.free >= 0 && (total === null || disk.free <= total) ? disk.free : null;
    const used = validNumber(disk.used) !== null && disk.used >= 0 && total !== null && disk.used <= total ? disk.used : null;
    const usagePercent = used === null ? null : used / total * 100;
    const usage = percent(usagePercent);
    const capacity = `${free === null ? '—' : compactGiB(free)} / ${total === null ? '—' : compactGiB(total)} GiB`;
    const description = n.stale ? 'Stale report · Awaiting fresh data' : `${usage} used · ${capacity} free / total${free === null || total === null ? ' · Not reported' : ''}`;
    return `<div class="storage-disk"><div class="storage-row" title="${esc(description)}"><span class="storage-label"><span>${disk.label}:</span> <span class="storage-path" title="${esc(disk.path || 'Path not reported')}">${esc(disk.path || '—')}</span></span><span class="storage-values">${n.stale ? '<span class="storage-stale">Stale report</span>' : `<strong>${usage}</strong> <span>(${capacity})</span>`}</span></div>${usageMeterMarkup(`${disk.label} usage`, n.stale ? null : usagePercent, 'storage-meter')}</div>`;
  }).join('') : `<p class="storage-empty">${n.stale ? 'Awaiting fresh data' : 'Not reported'}</p>`}</div>`;
}
renderNodes = function() {
  if (liveState.mode === 'demo') return demoRender.nodes();
  $('#node-count').textContent = liveState.snapshot ? nodes.length : '—';
  $('#node-grid').innerHTML = nodes.length ? nodes.map(n => {
    const modelLabel = nodeGpuModelLabel(n);
    return `<article class="node live-node panel ds-server-card ${n.stale ? 'drain-node' : ''}" aria-label="${esc(displayNodeName(n.id))}">
      <button class="node-summary" data-node="${esc(n.id)}" aria-label="${esc(displayNodeName(n.id))} details">
        <div class="node-header"><div class="node-title"><span class="node-name">${esc(displayNodeName(n.id))}</span></div><span class="node-model-badge" title="${esc(modelLabel)}">${esc(modelLabel)}</span></div>
        ${n.gpus.length ? '' : '<p class="node-no-gpu">Waiting for the node collector</p>'}
        <div class="resource-metrics" aria-label="${n.isCloud ? 'Host utilization' : 'Slurm resources: free / total'}">${n.isCloud ? resourceMarkup('CPU', !n.stale ? n.raw?.cpu_percent : null) + resourceMarkup('RAM', !n.stale ? n.raw?.ram_percent : null) : allocationMarkup(n, 'cpu') + allocationMarkup(n, 'ram')}</div>
        ${storageMarkup(n)}
      </button>
      ${n.gpus.length ? `<div class="gpu-jobs-summary">${gpuJobsCaptionMarkup(n)}${n.gpus.map(g => gpuBlockMarkup(n, g)).join('')}</div>` : ''}
    </article>`;
  }).join('') : `<div class="waiting-nodes"><span class="small-icon">${icon('server')}</span><h3>${liveState.error ? 'Cluster data is unavailable' : 'Waiting for node reports'}</h3><p>${liveState.error ? 'The last request failed. The dashboard will retry automatically.' : 'Received node reports will appear here automatically.'}</p><button id="waiting-help">Collector details ↗</button></div>`;
  $('#waiting-help')?.addEventListener('click', showDataInfo);
};
renderJobs = function() {
  renderJobFilters();
  const all = jobsForFilterCounts(), rows = filteredJobs(), pages = Math.max(1, Math.ceil(rows.length / JOBS_PER_PAGE)), hasSlurm = liveState.mode === 'demo' || !!liveState.snapshot?.slurm;
  liveState.page = Math.min(liveState.page, pages);
  const visible = rows.slice((liveState.page - 1) * JOBS_PER_PAGE, liveState.page * JOBS_PER_PAGE);
  $('#job-count').textContent = hasSlurm ? all.length : '—';
  $('#total-jobs').textContent = hasSlurm ? all.length : '—';
  $('#running-jobs').textContent = hasSlurm ? all.filter(j => j.state === 'RUNNING').length : '—';
  $('#pending-jobs').textContent = hasSlurm ? all.filter(j => j.state === 'PENDING').length : '—';
  $('#job-rows').innerHTML = visible.length ? visible.map(j => `<tr><td class="mono">${esc(j.id)}</td><td class="job-name-cell"><button class="job-name" data-job="${esc(j.id)}" title="${esc(j.name)}">${esc(j.name)}</button></td><td><span class="job-user">${esc(displayUserName(j.user))}</span></td><td><span class="job-status ${jobStatusClass(j.state)}">${esc(stateLabels[j.state] || j.state)}</span></td><td class="mono">${esc(j.gpus)}</td><td class="job-target-cell ${j.state === 'PENDING' ? 'pending-reason' : 'mono'}">${jobTargetMarkup(j)}</td><td><button class="table-arrow" data-job="${esc(j.id)}" aria-label="Job ${esc(j.id)} details">${icon('arrow')}</button></td></tr>`).join('') : `<tr><td colspan="7" class="empty-state">${liveState.mode === 'live' && !liveState.snapshot?.slurm ? liveState.error ? 'Slurm data is unavailable while the request is failing.' : 'Waiting for Slurm reports.' : jobs.length === 0 ? 'No jobs in the latest report.' : 'No matching jobs. Try another search or filter.'}</td></tr>`;
  $('#result-count').textContent = hasSlurm ? `${rows.length} jobs · Showing ${visible.length ? ((liveState.page - 1) * JOBS_PER_PAGE + 1) + '–' + Math.min(liveState.page * JOBS_PER_PAGE, rows.length) : 0}` : liveState.error ? 'Slurm data unavailable' : 'Waiting for Slurm reports';
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
  const cpuDetail = n.isCloud ? detailItem('CPU cores', n.cpu ?? 'Not reported') : detailItem('Slurm CPU allocation', allocationDescription(n, 'cpu')) + detailItem('Slurm RAM allocation', allocationDescription(n, 'ram'));
  const note = n.isCloud ? 'This standalone cloud node reports GPU processes and users without Slurm. Process counts do not indicate reserved GPU allocations.' : 'CPU and RAM summaries show free / total capacity from Slurm. Free capacity is unallocated; job constraints, reservations and scheduling policies can still prevent immediate scheduling. GPU cards show the user and job assigned by Slurm, even when no process is running on the GPU. Utilization and VRAM remain measured values. Observed process labels are used only when a Slurm owner is unavailable; stale or ambiguous allocation data is not treated as current ownership.';
  openDialog(`<h2 id="dialog-title">${esc(displayNodeName(n.id))}</h2><p class="dialog-subtitle">${esc(context)} · ${esc(ageText(n.receivedAt))}</p><dl class="detail-grid">${detailItem('GPU report', n.stale ? liveState.error ? 'Live refresh unavailable; last report shown' : 'Missing or over 3 minutes old' : 'Fresh report')}${cpuDetail}${detailItem('Host RAM', memory?.ram_used_gb !== null && memory?.ram_used_gb !== undefined ? `${memory.ram_used_gb} / ${memory.ram_total_gb} GiB${n.stale ? ' (stale)' : ''}` : 'Not reported')}${detailItem('Report received at', clockText(n.receivedAt))}</dl>
    ${storageMarkup(n)}<p class="storage-note">Storage shows percent used and (free / total GiB). Free space is available to users and excludes filesystem reserves.</p>
    ${gpuJobsCaptionMarkup(n)}<div class="dialog-gpus with-jobs">${n.gpus.map(g => `<div class="dialog-gpu ${g.util === null ? 'gpu-offline' : ''}"><strong>GPU ${esc(g.index)}</strong><span>Compute ${percent(g.util)}</span><span>${g.memoryUsed === null || g.memory === null || n.stale || g.error ? 'VRAM —' : `VRAM ${g.memoryUsed.toFixed(1)} / ${g.memory.toFixed(1)} GiB`}</span><div class="dialog-gpu-jobs"><span class="gpu-jobs-label">${n.isCloud ? 'User / Processes' : 'Job ID · User / Job name'}</span>${gpuJobsMarkup(n, g)}</div></div>`).join('')}</div>
    <p class="dialog-note">${note} Reports older than 3 minutes, or shown during a failed refresh, are marked stale and excluded from current utilization.</p>`, n.isCloud ? 'CLOUD NODE · LIVE REPORTS' : 'GPU NODE · LIVE REPORTS');
};
function requestedRam(job) {
  const match = String(job?.req_mem ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([KMGTPE]?)([cn]?)$/i);
  if (!match) return 'Not reported';
  const suffixScope = {c: 'cpu', n: 'node'}[match[3].toLowerCase()];
  const scope = ['total', 'node', 'cpu'].includes(job.req_mem_scope) ? job.req_mem_scope : suffixScope;
  if (suffixScope && scope !== suffixScope) return 'Not reported';
  let value = Number(match[1]), unit = 'KMGTPE'.indexOf((match[2] || 'M').toUpperCase());
  if (!Number.isFinite(value)) return 'Not reported';
  if (value === 0) return scope === 'node' ? 'All node memory' : 'Not reported';
  while (value < 1 && unit > 0) {value *= 1024; unit--;}
  while (value >= 1024 && unit < 5) {value /= 1024; unit++;}
  const label = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'][unit];
  const scopeLabel = {total: /^\d+_\[/.test(job.job_id || '') ? ' per array task' : ' total', node: ' per node', cpu: ' per CPU'}[scope] || '';
  return `${value.toLocaleString('en-US', {maximumFractionDigits: 3})} ${label}${scopeLabel}`;
}
showJob = function(id) {
  if (liveState.mode === 'demo') return demoRender.job(id);
  const j = jobs.find(j => j.id === id);
  if (!j) return;
  const slurmFresh = fresh(liveState.snapshot?.slurm?.receivedAt);
  const allocatedDevices = slurmFresh ? nodes.filter(n => !n.isCloud).flatMap(n => n.gpus.filter(g => g.allocationRecords.some(record => record.job?.id === j.id)).map(g => `${displayNodeName(n.id)} / GPU ${g.index}`)) : [];
  const observed = slurmFresh ? nodes.filter(n => !n.isCloud).flatMap(n => n.gpus.filter(g => !n.stale && !g.error && g.observedJobRecords.some(record => record.job?.id === j.id)).map(g => `${displayNodeName(n.id)} / GPU ${g.index}`)) : [];
  openDialog(`<h2 id="dialog-title">${esc(j.name)}</h2><p class="dialog-subtitle">Job ${esc(j.id)} · ${esc(displayUserName(j.user))}${slurmFresh ? '' : ' · Slurm data stale'}</p><dl class="detail-grid">${detailItem('State', stateLabels[j.state] || j.state)}${detailItem('Partition', j.partition)}${detailItem('Requested GPUs', j.gpus)}${detailItem('Slurm allocated GPUs', j.state === 'PENDING' ? 'Not allocated yet' : j.raw.alloc_gpus || 'Not reported')}${detailItem('Elapsed', j.state === 'PENDING' ? 'Not started' : j.elapsed)}${detailItem(j.state === 'PENDING' ? 'Pending reason' : 'Assigned nodes', j.state === 'PENDING' ? j.target : displayNodeList(j.target))}${j.state === 'PENDING' ? detailItem('Requested nodes', displayNodeList(requestedNodeList(j)) || 'Not specified') : ''}${detailItem('Requested CPUs', j.raw.req_cpus || 'Not reported')}${detailItem('Requested RAM', requestedRam(j.raw))}${detailItem('Allocated GPU devices', slurmFresh ? allocatedDevices.join(', ') || (j.state === 'PENDING' ? 'Not allocated yet' : 'Device mapping unavailable') : 'Unavailable while Slurm data is stale')}${detailItem('GPUs with observed processes', slurmFresh ? observed.length ? `${observed.length} ${observed.length === 1 ? 'GPU' : 'GPUs'} · ${observed.join(', ')}` : 'No current process match' : 'Unavailable while Slurm data is stale')}${detailItem('Slurm report received at', clockText(liveState.snapshot?.slurm?.receivedAt))}</dl><p class="dialog-note">${j.state === 'PENDING' ? 'Requested nodes are specified by the job; no server has been allocated yet. Submission time is not collected, so time pending is unavailable. ' : ''}RAM shows the Slurm request, not measured usage; per-CPU and per-node requests are labeled. GPU requests and allocations come from Slurm. Observed GPUs list only devices with matching reported processes; an allocated GPU can have no observed process.</p>`, 'SLURM JOB · LIVE REPORTS');
};
showDataInfo = function() {
  openDialog('<h2 id="dialog-title">Collector connection</h2><p class="dialog-subtitle">Live reports from your node and Slurm collectors.</p><div class="dialog-copy"><p>Node reports arrive at <code>POST /api/report/node</code> and Slurm reports at <code>POST /api/report/slurm</code>, authenticated with the collectors\' reporting token.</p><p>The dashboard updates every 30 seconds while this tab is visible. Background tabs pause updates and refresh on return. Reports older than 3 minutes are marked stale. Failed refreshes retain the last received reports with stale status. Missing metrics are shown as unavailable rather than zero. During a daily database limit, automatic retries are spaced up to 5 minutes apart; Refresh now checks immediately, with at least 5 seconds between requests.</p><p>GPU owners come from Slurm device allocations and each node\'s verified device mapping. Cards show the allocated user and job even without GPU processes; utilization and VRAM remain measured values. When allocation information is unavailable, process matches are explicitly labeled as observed.</p><p>Standalone cloud nodes show GPU users and process counts independently of the lab Slurm queue.</p></div>', 'DATA SOURCE');
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
function missingRecentReports(snapshot) {
  const previous = liveState.snapshot;
  if (!previous) return false;
  const recent = report => Number.isFinite(report?.receivedAt) && Date.now() - report.receivedAt < FRESHNESS_MS;
  const reportedNodes = new Set(snapshot.nodes.map(report => report.data.server_name));
  return recent(previous.slurm) && !snapshot.slurm
    || previous.nodes.some(report => recent(report) && !reportedNodes.has(report.data.server_name));
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
    // A restarted receiver may briefly have only some collector reports. Keep
    // the previous view marked stale until they arrive, bounded by freshness.
    if (missingRecentReports(snapshot)) throw Object.assign(new Error(), {publicMessage: 'Waiting for fresh collector reports.', kind: 'incomplete'});
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
      liveState.errorKind = ['quota', 'incomplete'].includes(error?.kind) ? error.kind : 'request';
      liveState.retryAt = error?.kind === 'quota' ? error.retryAt : null;
      liveState.failureCount += 1;
      const retryDelay = liveState.errorKind === 'incomplete' ? REFRESH_INTERVAL_MS : liveState.errorKind === 'quota' ? Math.min(QUOTA_RETRY_MS, Math.max(ERROR_RETRY_BASE_MS, liveState.retryAt - Date.now())) : Math.min(QUOTA_RETRY_MS, ERROR_RETRY_BASE_MS * liveState.failureCount);
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
