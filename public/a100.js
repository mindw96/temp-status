(() => {
  'use strict';
  const POLL_MS = 30_000;
  const STALE_MS = 180_000;
  const STORAGE_STALE_MS = 600_000;
  const COOLDOWN_MS = 5_000;
  const MAX_BACKOFF_MS = 300_000;
  const names = Object.freeze({
    mindw:'민동욱',kangjh:'강전휘',kimjh:'김지호',parkyr:'박양렬',parksh:'박수현',
    kimmj:'김민재',leekh:'이건희',leesh:'이승호',choihj:'최형준',chunmei:'메이',
    zuchi:'주치',leejg:'이준규',ahnjm:'안정민',seois:'서인석',kimgy:'김관엽',
    kimhj:'김현주',kimyh:'김유현',leejy:'이지영',yangdj:'양동준',janghj:'장현준',
    chasj:'차상진',choihb:'최한백',kangmk:'강민규',ryujh:'류정환',phdkimjh:'김정환',
    leeki:'이건일',anu:'아누',kimhy:'김하영'
  });
  const errors = Object.freeze({
    quota_unavailable:'GPU quota is unavailable.',
    storage_unavailable:'Storage usage is unavailable.',
    jobs_unavailable:'The job list could not be updated.',
    pods_unavailable:'Pod status could not be updated.',
    gpu_metrics_unavailable:'Some GPU activity measurements are unavailable.',
    collection_timeout:'The collector did not finish in time.',
    collection_failed:'The collector could not complete this report.'
  });
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const numericText = value => number(value) === null ? '—' : value.toLocaleString('en-US', {maximumFractionDigits:1});
  const ownerName = owner => Object.hasOwn(names, owner) ? `${names[owner]}(${owner})` : owner || 'User unavailable';
  const dateValue = value => typeof value === 'string' ? Date.parse(value) : typeof value === 'number' && Number.isFinite(value) ? value : NaN;
  const state = {snapshot:null, loading:false, error:'', failures:0, lastAttempt:0, offset:0, owner:'', search:'', dialogId:null};
  let pollTimer, cooldownTimer, freshnessTimer, previousFreshness = '';
  const now = () => Date.now() + state.offset;
  const report = () => state.snapshot?.report ?? null;
  const allJobs = () => Array.isArray(report()?.jobs) ? report().jobs : [];
  const fresh = (at, limit = STALE_MS) => Number.isFinite(dateValue(at)) && now() - dateValue(at) <= limit && dateValue(at) - now() < 60_000;
  const reportStale = () => !!report() && (state.snapshot.stale || !fresh(report().collected_at) || !fresh(state.snapshot.received_at));
  const jobsFresh = () => !!report() && !reportStale() && fresh(report().jobs_collected_at) && !report().errors?.some(code => ['jobs_unavailable','pods_unavailable'].includes(code));
  const finished = job => ['Succeeded','Failed'].includes(job.status);
  const completed = job => job.status === 'Succeeded';
  const statusName = job => ({Running:'Running',Pending:'Queued',Succeeded:'Completed',Failed:'Failed',Suspended:'Suspended',Unknown:'Unknown'}[job.status] || 'Unknown');
  const unitCount = (value, singular, plural = `${singular}s`) => number(value) === null ? `${singular} request unavailable` : `${numericText(value)} ${value === 1 ? singular : plural}`;
  function timestamp(at, includeDate = true) {
    const value = dateValue(at);
    if (!Number.isFinite(value)) return 'Not reported';
    return new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Seoul', ...(includeDate ? {day:'2-digit',month:'short'} : {}), hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(value) + ' KST';
  }
  function duration(job) {
    const start = dateValue(job.started_at);
    const end = finished(job) ? dateValue(job.finished_at) : now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return job.status === 'Pending' ? 'Waiting to start' : 'Runtime unavailable';
    const minutes = Math.max(0, Math.floor((end - start) / 60_000));
    if (minutes < 1) return '< 1m';
    return `${minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ` : ''}${minutes >= 60 ? `${Math.floor(minutes / 60) % 24}h ` : ''}${minutes % 60}m`;
  }
  function byteText(value) {
    if (number(value) === null) return '—';
    return value >= 1024 ** 4 ? `${numericText(value / 1024 ** 4)} TiB` : `${numericText(value / 1024 ** 3)} GiB`;
  }
  function percentage(value) {
    return number(value) !== null && value <= 100 ? `${Math.round(value)}%` : '—';
  }
  function meter(label, value, extraClass = '') {
    const valid = number(value) !== null && value <= 100;
    const blend = (start, end) => Math.max(0, Math.min(1, (value - start) / (end - start)));
    const hue = valid ? 140 - 108 * blend(25,35) - 32 * blend(65,75) : 0;
    return `<span class="a100-meter ${extraClass}"${valid ? ` role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"` : ' aria-hidden="true"'}>${valid ? `<span style="width:${value}%;--a100-hue:${hue}"></span>` : ''}</span>`;
  }
  function renderSummary() {
    const data = report();
    const quota = data?.quota;
    const quotaValid = !!quota && !reportStale() && !quota.error && fresh(quota.collected_at) && number(quota.gpu_used) !== null && number(quota.gpu_limit) !== null;
    const quotaNote = quotaValid
      ? `${numericText(Math.max(0,quota.gpu_limit - quota.gpu_used))} within lab quota · not cluster-wide availability`
      : quota?.error ? 'GPU quota is unavailable.' : data ? 'GPU quota is stale or not reported.' : 'Waiting for quota report.';
    const jobs = allJobs();
    const jobCounts = jobsFresh();
    const storage = data?.storage;
    const storageValid = !!storage && !storage.error && !reportStale() && fresh(storage.collected_at, STORAGE_STALE_MS) && number(storage.used_bytes) !== null && number(storage.limit_bytes) !== null && storage.limit_bytes > 0;
    const storagePercent = storageValid ? storage.used_bytes / storage.limit_bytes * 100 : null;
    const storageNote = storageValid ? `Lab-wide GPFS quota · measured ${timestamp(storage.collected_at, false)}` : storage?.error ? 'Storage usage is unavailable.' : data ? 'Storage usage is stale or not reported.' : 'Waiting for storage report.';
    const failedCount = jobs.filter(job => job.status === 'Failed').length;
    $('#a100-summary').innerHTML = `<div class="a100-summary-card"><div class="a100-summary-title"><span>Requested GPUs</span><span class="a100-summary-value">${quotaValid ? numericText(quota.gpu_used) : '—'} <span class="a100-denominator">/ ${quotaValid ? numericText(quota.gpu_limit) : '—'}</span></span></div><p class="a100-summary-note">${esc(quotaNote)}</p><div class="a100-counts"><span>Running <b>${jobCounts ? jobs.filter(job => job.status === 'Running').length : '—'}</b></span><span>Queued <b>${jobCounts ? jobs.filter(job => job.status === 'Pending').length : '—'}</b></span>${jobCounts && failedCount ? `<span class="a100-failure">Failed <b>${failedCount}</b></span>` : ''}</div></div><div class="a100-summary-card"><div class="a100-summary-title"><span>Shared storage</span><span class="a100-summary-value">${storageValid ? numericText(storagePercent) : '—'}<span class="a100-denominator">${storageValid ? '%' : ''}</span></span></div><div class="a100-storage-line"><span>Used / quota</span><span>${storageValid ? `${byteText(storage.used_bytes)} / ${byteText(storage.limit_bytes)}` : '— / —'}</span></div>${meter('Shared storage usage',storagePercent === null ? null : Math.min(100,storagePercent),'a100-storage-meter')}<p class="a100-summary-note">${esc(storageNote)}</p></div>`;
  }
  function renderConnection() {
    const data = report();
    const messages = [];
    if (state.error) messages.push(state.error + (data ? ' Showing the last received report.' : ' Live data is unavailable.'));
    if (!data && !state.error) messages.push(state.loading ? 'Connecting to the A100 collector…' : 'Waiting for the first A100 report. This page checks every 30 seconds.');
    if (reportStale()) messages.push('The A100 report is stale. Current GPU activity is unavailable.');
    if (data && !jobsFresh() && !reportStale()) messages.push('Job status is stale or unavailable. Listed jobs may have changed.');
    for (const code of new Set(Array.isArray(data?.errors) ? data.errors : [])) messages.push(errors[code] || 'Part of the report is unavailable.');
    $('#a100-connection').textContent = [...new Set(messages)].join(' ');
    $('#a100-connection').hidden = !messages.length;
    $('#a100-timestamp').textContent = data ? timestamp(data.collected_at) : 'No report received';
    $('#a100-timestamp').title = data ? `Collected at ${timestamp(data.collected_at)} · received at ${timestamp(state.snapshot.received_at)}` : 'Waiting for the A100 collector';
  }
  function renderOwners() {
    const users = [...new Set(allJobs().map(job => job.owner).filter(Boolean))];
    if (state.owner && !users.includes(state.owner)) users.push(state.owner);
    users.sort((a,b) => ownerName(a).localeCompare(ownerName(b),'ko'));
    $('#a100-owner').innerHTML = '<option value="">All users</option>' + users.map(user => `<option value="${esc(user)}"${state.owner === user ? ' selected' : ''}>${esc(ownerName(user))}</option>`).join('');
  }
  function matches(job) {
    return (!state.owner || state.owner === job.owner) && (!state.search || [job.name,job.owner,ownerName(job.owner),statusName(job)].some(value => String(value || '').toLocaleLowerCase().includes(state.search)));
  }
  function gpuMarkup(gpu, index, count, job) {
    const usable = !reportStale() && jobsFresh() && fresh(gpu.collected_at);
    const util = usable && number(gpu.utilization_pct) !== null && gpu.utilization_pct <= 100 ? gpu.utilization_pct : null;
    const memoryValid = usable && number(gpu.memory_used_mib) !== null && number(gpu.memory_total_mib) !== null && gpu.memory_total_mib > 0 && gpu.memory_used_mib <= gpu.memory_total_mib;
    const memoryPercent = memoryValid ? gpu.memory_used_mib / gpu.memory_total_mib * 100 : null;
    const model = typeof gpu.name === 'string' ? gpu.name.replace(/\b(?:NVIDIA|NVL|Blackwell)\b/gi,'').trim() : '';
    const label = [count > 1 ? `GPU ${index + 1} of ${count}` : '',model].filter(Boolean).join(' · ');
    const unavailable = !usable ? 'GPU measurement is stale or unavailable.' : util === null || !memoryValid ? 'Some GPU measurements are unavailable.' : '';
    return `<div class="a100-gpu">${label ? `<p class="a100-gpu-label">${esc(label)}</p>` : ''}<div class="a100-gpu-metrics"><span>UTIL</span>${meter(`${job.name} GPU utilization`,util)}<span class="a100-metric-value">${percentage(util)}</span><span>VRAM</span>${meter(`${job.name} GPU memory usage`,memoryPercent)}<span class="a100-metric-value">${percentage(memoryPercent)}</span><span class="a100-memory">${memoryValid ? `(${numericText(gpu.memory_used_mib / 1024)} / ${numericText(gpu.memory_total_mib / 1024)} GiB)` : 'Memory unavailable'}</span></div>${unavailable ? `<p class="a100-metrics-note a100-warning">${esc(unavailable)}</p>` : ''}</div>`;
  }
  function jobMarkup(job) {
    const gpus = Array.isArray(job.gpus) ? job.gpus : [];
    const gpuRequest = number(job.requested_gpus);
    const noMetrics = job.status === 'Pending' ? 'GPU activity will appear after the job starts.' : job.status === 'Failed' ? 'Job failed. Open its details to view the reported status.' : gpuRequest === 0 ? 'No GPUs requested.' : 'GPU activity is unavailable.';
    const restarts = (job.pods || []).reduce((sum,pod) => sum + (number(pod.restarts) ?? 0),0);
    const partial = gpuRequest !== null && gpuRequest > gpus.length && job.status === 'Running' && gpus.length > 0;
    const measurementTimes = gpus.map(gpu => dateValue(gpu.collected_at)).filter(Number.isFinite);
    const lastMeasurement = measurementTimes.length ? timestamp(Math.min(...measurementTimes),false) : 'unknown time';
    return `<article class="a100-job-card"><div class="a100-job-top"><span class="a100-job-owner" title="${esc(ownerName(job.owner))}">${esc(ownerName(job.owner))}</span><span class="a100-job-status${job.status === 'Failed' ? ' a100-failure' : ''}">${esc(statusName(job))}</span></div><button type="button" class="a100-job-name" data-a100-job="${esc(job.id)}" aria-label="${esc(job.name)}, job details">${esc(job.name || 'Unnamed job')}</button><div class="a100-job-meta"><span>${gpuRequest === null ? 'GPU request unavailable' : `${esc(unitCount(gpuRequest,'GPU'))} requested`}</span><span>${esc(duration(job))}</span></div>${job.reason ? `<p class="a100-job-reason a100-warning">${esc(job.reason)}</p>` : ''}<div class="a100-gpu-list">${gpus.length ? gpus.map((gpu,index) => gpuMarkup(gpu,index,gpus.length,job)).join('') : `<p class="a100-metrics-note">${esc(noMetrics)}</p>`}</div>${partial ? `<p class="a100-metrics-note a100-warning">Measurements received for ${gpus.length} of ${numericText(gpuRequest)} requested GPUs.</p>` : ''}${job.metrics_error && gpus.length ? `<p class="a100-metrics-note a100-warning">Last measurement: ${esc(lastMeasurement)}. The latest collection was incomplete.</p>` : ''}${restarts ? `<p class="a100-metrics-note">${restarts} container ${restarts === 1 ? 'restart' : 'restarts'}</p>` : ''}</article>`;
  }
  function renderJobs() {
    const jobs = allJobs();
    const active = jobs.filter(job => !completed(job));
    const visible = active.filter(matches).sort((a,b) => ({Failed:0,Running:1,Pending:2,Suspended:3,Unknown:4}[a.status] ?? 5) - ({Failed:0,Running:1,Pending:2,Suspended:3,Unknown:4}[b.status] ?? 5) || String(a.name).localeCompare(String(b.name)));
    const done = jobs.filter(completed).filter(matches).sort((a,b) => (dateValue(b.finished_at) || 0) - (dateValue(a.finished_at) || 0));
    $('#a100-active-count').textContent = report() ? state.owner || state.search ? `${visible.length} / ${active.length}` : String(active.length) : '—';
    const empty = !report() ? 'Waiting for the first report.' : state.owner || state.search ? 'No matching active jobs.' : !jobsFresh() ? 'The current job list is unavailable.' : 'No active jobs in the latest report.';
    $('#a100-job-cards').innerHTML = visible.length ? visible.map(jobMarkup).join('') : `<p class="a100-empty">${empty}</p>`;
    $('#a100-finished-count').textContent = report() ? String(done.length) : '—';
    $('#a100-finished-list').innerHTML = done.length ? done.map(job => `<div class="a100-finished-row"><button type="button" class="a100-job-name" data-a100-job="${esc(job.id)}">${esc(job.name || 'Unnamed job')}</button><span>${esc(ownerName(job.owner))}</span><span>${esc(statusName(job))}</span></div>`).join('') : '<p class="a100-summary-note">No completed jobs match the current filters.</p>';
  }
  const detail = (label,value) => `<div><dt>${esc(label)}</dt><dd>${esc(value ?? 'Not reported')}</dd></div>`;
  function renderDialog() {
    const job = allJobs().find(item => item.id === state.dialogId);
    if (!job) {
      if ($('#a100-dialog').open) $('#a100-dialog-content').innerHTML = '<h2 id="a100-dialog-title">Job no longer reported</h2><p class="dialog-subtitle">This job is no longer present in the latest report.</p>';
      return;
    }
    const pods = Array.isArray(job.pods) ? job.pods : [];
    $('#a100-dialog-content').innerHTML = `<h2 id="a100-dialog-title">${esc(job.name || 'Unnamed job')}</h2><p class="dialog-subtitle">${esc(ownerName(job.owner))} · ${esc(statusName(job))}</p><dl class="detail-grid">${detail('Requested GPUs',numericText(job.requested_gpus))}${detail('Requested CPU',number(job.cpu_requested) === null ? 'Not reported' : `${numericText(job.cpu_requested)} cores`)}${detail('Requested RAM',number(job.ram_requested_bytes) === null ? 'Not reported' : byteText(job.ram_requested_bytes))}${detail('Runtime',duration(job))}${detail('Created',timestamp(job.created_at))}${detail('Started',timestamp(job.started_at))}${finished(job) ? detail('Finished',timestamp(job.finished_at)) : ''}${detail('Node',job.node || 'Not assigned')}${job.reason ? detail('Reason',job.reason) : ''}</dl>${!jobsFresh() ? '<p class="dialog-note">Job status is stale or unavailable. These are the last reported details.</p>' : ''}<div class="a100-dialog-pods">${pods.length ? pods.map(pod => `<div class="a100-dialog-pod">${esc(pod.name)}<span>${esc(pod.phase || 'Unknown')} · ${number(pod.restarts) === null ? 'Restarts not reported' : `${numericText(pod.restarts)} restarts`}</span></div>`).join('') : '<p>No Pods reported for this job yet.</p>'}</div>`;
  }
  function render() {
    renderConnection();
    renderSummary();
    renderOwners();
    renderJobs();
    if ($('#a100-dialog').open) renderDialog();
    previousFreshness = freshnessKey();
  }
  function freshnessKey() {
    const data = report();
    return data ? JSON.stringify([reportStale(),jobsFresh(),fresh(data.quota?.collected_at),fresh(data.storage?.collected_at,STORAGE_STALE_MS),...allJobs().flatMap(job => (job.gpus || []).map(gpu => fresh(gpu.collected_at)))]) : '';
  }
  function watchFreshness() {
    clearInterval(freshnessTimer);
    if (document.hidden) return;
    freshnessTimer = setInterval(() => {
      const key = freshnessKey();
      if (key === previousFreshness) return;
      previousFreshness = key;
      renderConnection();
      renderSummary();
      renderJobs();
      if ($('#a100-dialog').open) renderDialog();
    },15_000);
  }
  function renderRefresh() {
    clearTimeout(cooldownTimer);
    const remaining = Math.max(0,state.lastAttempt + COOLDOWN_MS - Date.now());
    $('#a100-refresh').disabled = state.loading || remaining > 0;
    $('#a100-refresh .refresh-label').textContent = state.loading ? 'Refreshing…' : remaining > 0 ? `Refresh in ${Math.ceil(remaining / 1000)}s` : 'Refresh Now';
    $('#a100-refresh').title = 'Fetch the latest report. Automatically refreshes every 30 seconds.';
    if (!document.hidden && !state.loading && remaining > 0) cooldownTimer = setTimeout(renderRefresh,Math.min(1000,remaining));
  }
  function schedule(delay) {
    clearTimeout(pollTimer);
    if (!document.hidden) pollTimer = setTimeout(loadSnapshot,delay ?? Math.min(MAX_BACKOFF_MS,POLL_MS * 2 ** Math.min(state.failures,4)));
  }
  async function loadSnapshot() {
    if (state.loading || document.hidden || Date.now() - state.lastAttempt < COOLDOWN_MS) return;
    clearTimeout(pollTimer);
    state.loading = true;
    state.lastAttempt = Date.now();
    renderRefresh();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(),15_000);
    try {
      const response = await fetch('/api/a100/snapshot',{signal:abort.signal,headers:{Accept:'application/json'},cache:'no-store'});
      if (!response.ok) throw new Error(`The report service returned HTTP ${response.status}.`);
      const snapshot = await response.json();
      if (!snapshot || typeof snapshot !== 'object' || !Object.hasOwn(snapshot,'report') || (snapshot.report !== null && (!Array.isArray(snapshot.report.jobs) || snapshot.report.schema_version !== 1))) throw new Error('The report service returned an invalid response.');
      state.snapshot = snapshot;
      const serverTime = dateValue(snapshot.server_time);
      state.offset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
      state.error = '';
      state.failures = 0;
    } catch (error) {
      state.error = error.name === 'AbortError' ? 'The report service timed out.' : error instanceof TypeError ? 'Could not reach the report service.' : error.message || 'Could not load the report.';
      state.failures += 1;
    } finally {
      clearTimeout(timeout);
      state.loading = false;
      render();
      renderRefresh();
      schedule();
    }
  }
  $('#a100-refresh').addEventListener('click',loadSnapshot);
  $('#a100-owner').addEventListener('change',event => {state.owner = event.target.value;renderJobs();});
  $('#a100-search').addEventListener('input',event => {state.search = event.target.value.trim().toLocaleLowerCase();renderJobs();});
  $('#main').addEventListener('click',event => {
    const button = event.target.closest('[data-a100-job]');
    if (!button) return;
    state.dialogId = button.dataset.a100Job;
    renderDialog();
    $('#a100-dialog').showModal();
  });
  $('#a100-close').addEventListener('click',() => $('#a100-dialog').close());
  $('#a100-dialog').addEventListener('click',event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
  });
  document.addEventListener('visibilitychange',() => {
    clearTimeout(pollTimer);
    clearTimeout(cooldownTimer);
    watchFreshness();
    if (!document.hidden) {
      render();
      renderRefresh();
      const remaining = Math.max(0,POLL_MS - (Date.now() - state.lastAttempt));
      if (remaining === 0) loadSnapshot();
      else schedule(remaining);
    }
  });
  render();
  watchFreshness();
  loadSnapshot();
})();
