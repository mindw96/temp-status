import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await Promise.all(['app.js', 'gpu-jobs.js', 'live.js'].map(name =>
  readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')));
const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
assert.doesNotMatch(page, /class="sample-note"|class="node-key"|id="sample-details"|Slurm snapshot/);
assert.equal([...page.matchAll(/id="retry-live"/g)].length, 1);
assert.doesNotMatch(page, /id="nodes-title"|id="node-count"|Cluster overview/);
assert.match(page, /id="page-title">NLP Lab\. Server Status<\/h1>/);
assert.match(page, /class="heading-controls"><span class="snapshot">[\s\S]*?id="retry-live"[^>]*>Refresh Now<\/button><button[^>]*id="theme-toggle"/);
const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};

// Run the actual browser scripts against a small DOM and controllable browser
// clock. No network, wall-clock sleep, or external browser dependency is needed.
function browser({hidden = false, holdRequest = false} = {}) {
  let now = Date.parse('2026-09-22T10:00:00Z'), timerId = 0;
  const timers = new Map(), elements = new Map(), listeners = new Map(), requests = [], responses = [];
  const element = selector => {
    assert.ok(!['.sample-note', '.node-key', '#sample-details', '#node-count', '.table-footer>span:last-child'].includes(selector),
      `Removed status UI must not be accessed: ${selector}`);
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', disabled: false, hidden: false, addEventListener() {}, showModal() {},
      classList: {toggle() {}}, setAttribute() {}
    });
    return elements.get(selector);
  };
  class BrowserDate extends Date {static now() {return now;}}
  const snapshot = () => ({
    nodes: [{receivedAt: now, data: {server_name: 'devbox', gpus: [
      {id: 0, gpu_utilization: 40, vram_total_mb: 1024, vram_total_used_mb: 256,
        processes: [{pid: 1, slurm_job_id: '1', username: 'lab-user'}]}
    ]}}],
    slurm: {receivedAt: now, data: {sinfo: [{name: 'devbox', state: 'MIXED'}],
      squeue: [{job_id: '1', name: 'Training', user: 'lab-user', job_state: 'RUNNING'}]}}
  });
  const document = {
    hidden, querySelector: element, querySelectorAll: () => [],
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    }
  };
  const context = vm.createContext({
    structuredClone, Date: BrowserDate, Intl, AbortController, document,
    window: {addEventListener() {}},
    setTimeout(callback, delay) {timers.set(++timerId, {at: now + delay, callback}); return timerId;},
    clearTimeout(id) {timers.delete(id);},
    fetch: async (url, options) => {
      const request = {at: now, signal: options.signal};
      requests.push(request);
      if (holdRequest) {
        holdRequest = false;
        return await new Promise((resolve, reject) => {
          request.resolve = resolve;
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error(), {name: 'AbortError'})));
        });
      }
      const response = responses.length ? responses.shift() : {status: 200, body: snapshot()};
      if (response.networkError) throw new TypeError('Network unavailable');
      return {ok: response.status >= 200 && response.status < 300, status: response.status,
        json: async () => {if (response.invalidJSON) throw new SyntaxError('Malformed JSON'); return response.body;}};
    }
  });
  for (const script of source) vm.runInContext(script, context);
  return {
    requests, responses, element, snapshot, timers,
    state: () => vm.runInContext('({...liveState})', context),
    evaluate: code => vm.runInContext(code, context),
    async visibility(value) {
      document.hidden = value;
      for (const listener of listeners.get('visibilitychange') || []) listener();
      await flush();
    },
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at; timers.delete(id); timer.callback(); await flush();
      }
      now = end; await flush();
    }
  };
}

// A background-loaded page performs no request and runs no polling timers.
const hidden = browser({hidden: true});
await flush();
assert.equal(hidden.requests.length, 0);
assert.equal(hidden.timers.size, 0);
assert.equal(hidden.element('#connection-status').hidden, false);
assert.match(hidden.element('#connection-status').textContent, /Waiting for collectors/);
await hidden.advance(600000);
assert.equal(hidden.requests.length, 0);
await hidden.visibility(false);
assert.equal(hidden.requests.length, 1);
assert.equal(hidden.state().error, null);

// Visible pages use the 30-second cadence. Hidden pages cancel both network and
// cooldown timers, and a healthy return refreshes without waiting for that cadence.
const healthy = browser();
await flush();
assert.equal(healthy.requests.length, 1);
assert.equal(healthy.element('#connection-status').hidden, true);
assert.equal(healthy.element('#connection-status').textContent, '');
assert.equal(healthy.element('#retry-live').textContent, 'Refresh in 5s');
assert.equal(healthy.element('#retry-live').disabled, true);
await healthy.advance(4000);
assert.equal(healthy.element('#retry-live').textContent, 'Refresh in 1s');
await healthy.element('#retry-live').onclick();
assert.equal(healthy.requests.length, 1);
await healthy.advance(1000);
assert.equal(healthy.element('#retry-live').textContent, 'Refresh Now');
assert.equal(healthy.element('#retry-live').disabled, false);
assert.match(healthy.element('#retry-live').title, /every 30 seconds/);
await healthy.advance(24999);
assert.equal(healthy.requests.length, 1);
await healthy.advance(1);
assert.equal(healthy.requests.length, 2);
await healthy.visibility(true);
assert.equal(healthy.timers.size, 0);
await healthy.advance(60000);
assert.equal(healthy.requests.length, 2);
await healthy.visibility(false);
assert.equal(healthy.requests.length, 3);
await healthy.visibility(true);
await healthy.advance(1000);
await healthy.visibility(false);
assert.equal(healthy.requests.length, 3);
await healthy.advance(3999);
assert.equal(healthy.requests.length, 3);
await healthy.advance(1);
assert.equal(healthy.requests.length, 4);

// Manual refresh bypasses normal polling, but even repeated programmatic clicks
// cannot issue requests less than 5 seconds apart.
await healthy.element('#retry-live').onclick();
assert.equal(healthy.requests.length, 4);
await healthy.advance(5000);
await healthy.element('#retry-live').onclick(); await flush();
assert.equal(healthy.requests.length, 5);
assert.equal(healthy.requests.at(-1).at - healthy.requests.at(-2).at, 5000);

// Hiding during an in-flight read aborts it without converting a deliberate
// pause into a network error or retry penalty. Returning resumes safely.
const inFlight = browser({holdRequest: true});
await flush();
assert.equal(inFlight.state().loading, true);
assert.equal(inFlight.element('#retry-live').textContent, 'Refreshing…');
assert.equal(inFlight.element('#retry-live').disabled, true);
await inFlight.visibility(true);
assert.equal(inFlight.requests[0].signal.aborted, true);
assert.equal(inFlight.state().loading, false);
assert.equal(inFlight.state().error, null);
assert.equal(inFlight.state().failureCount, 0);
assert.equal(inFlight.timers.size, 0);
await inFlight.advance(5000);
await inFlight.visibility(false);
assert.equal(inFlight.requests.length, 2);
assert.equal(inFlight.state().snapshot.nodes.length, 1);

// A tab can become visible before the aborted fetch has settled. Its completion
// must still resume exactly once instead of losing the visibility event.
const rapidReturn = browser({holdRequest: true});
await flush(); await rapidReturn.advance(5000);
await Promise.all([rapidReturn.visibility(true), rapidReturn.visibility(false)]);
await flush();
assert.equal(rapidReturn.requests.length, 2);
assert.equal(rapidReturn.state().error, null);
assert.equal(rapidReturn.state().loading, false);

// Quota and request backoff survive visibility changes; explicit manual refresh
// can recover immediately once its 5-second cooldown has elapsed.
const failures = browser();
await flush(); await failures.advance(5000);
failures.responses.push({status: 503, body: {error: 'storage_quota_exceeded', retry_at: Date.parse('2026-09-23T00:00:00Z')}});
await failures.element('#retry-live').onclick(); await flush();
assert.equal(failures.state().errorKind, 'quota');
assert.match(failures.state().error, /09:00:00 KST/);
assert.equal(failures.element('#connection-status').hidden, false);
assert.match(failures.element('#connection-status').textContent, /Showing last received data; live status is unavailable/);
assert.match(failures.element('#connection-status').textContent, /Automatic retry within 5 minutes, or use Refresh Now/);
assert.equal(failures.evaluate('nodes[0].stale'), true);
assert.equal(failures.evaluate('nodes[0].gpus[0].util'), null);
assert.equal(failures.state().snapshot.nodes.length, 1);
assert.equal(failures.state().nextAttemptAt - failures.requests.at(-1).at, 300000);
await failures.visibility(true); await failures.advance(60000); await failures.visibility(false);
assert.equal(failures.requests.length, 2);
await failures.element('#retry-live').onclick(); await flush();
assert.equal(failures.requests.length, 3);
assert.equal(failures.state().error, null);
assert.equal(failures.state().failureCount, 0);
assert.equal(failures.evaluate('nodes[0].stale'), false);
assert.equal(failures.element('#connection-status').hidden, true);
assert.equal(failures.element('#connection-status').textContent, '');
for (const [expectedDelay, response] of [
  [120000, {status: 503, body: {error: 'storage_unavailable'}}],
  [240000, {status: 200, invalidJSON: true}],
  [300000, {networkError: true}]
]) {
  await failures.advance(5000); failures.responses.push(response);
  await failures.element('#retry-live').onclick(); await flush();
  assert.equal(failures.state().nextAttemptAt - failures.requests.at(-1).at, expectedDelay);
  assert.equal(failures.state().snapshot.nodes.length, 1);
  assert.equal(failures.element('#connection-status').hidden, false);
  assert.match(failures.element('#connection-status').textContent, /live status is unavailable/);
}

// A receiver restart can return a valid but incomplete snapshot before all
// collectors have reported again. Keep the recent snapshot together, mark its
// live metrics/allocations unavailable, and retry on the ordinary 30s cadence.
const allocationSnapshot = client => {
  const result = client.snapshot();
  result.nodes[0].data.gpus[0].slurm_gres_index = 0;
  result.slurm.data.squeue[0].gpu_allocations = [{node: 'devbox', gres_indices: [0]}];
  return result;
};
for (const missing of ['all reports', 'Slurm report', 'node report', 'replaced node']) {
  const partial = browser({hidden: true});
  partial.responses.push({status: 200, body: allocationSnapshot(partial)});
  await partial.visibility(false);
  const previous = partial.state().snapshot;
  assert.equal(partial.evaluate('nodes[0].gpus[0].allocated'), true);
  await partial.advance(5000);
  const incomplete = partial.snapshot();
  incomplete.nodes[0].data.gpus[0].gpu_utilization = 88;
  incomplete.slurm.data.squeue[0].name = 'Partial replacement';
  if (missing === 'all reports') {incomplete.nodes = []; incomplete.slurm = null;}
  else if (missing === 'Slurm report') incomplete.slurm = null;
  else if (missing === 'node report') incomplete.nodes = [];
  else incomplete.nodes[0].data.server_name = 'server2';
  partial.responses.push({status: 200, body: incomplete});
  await partial.element('#retry-live').onclick(); await flush();
  assert.equal(partial.state().errorKind, 'incomplete', missing);
  assert.equal(partial.state().snapshot, previous, `${missing}: preserve the whole snapshot`);
  assert.equal(partial.evaluate('jobs[0].name'), 'Training');
  assert.equal(partial.evaluate('nodes[0].stale'), true);
  assert.equal(partial.evaluate('nodes[0].gpus[0].util'), null);
  assert.equal(partial.evaluate('nodes[0].gpus[0].allocated'), false);
  assert.equal(partial.evaluate('nodes[0].slurmFresh'), false);
  assert.equal(partial.element('#connection-status').hidden, false);
  assert.match(partial.element('#connection-status').textContent, /Waiting/i);
  assert.match(partial.element('#connection-status').textContent, /last received data|last reports/i);
  assert.equal(partial.state().nextAttemptAt - partial.requests.at(-1).at, 30000);

  // Repeated incompleteness must not discard retained data merely because the
  // previous read set an error, nor increase the delay to request-error backoff.
  await partial.advance(29999);
  assert.equal(partial.requests.length, 2);
  partial.responses.push({status: 200, body: incomplete});
  await partial.advance(1);
  assert.equal(partial.requests.length, 3);
  assert.equal(partial.state().errorKind, 'incomplete');
  assert.equal(partial.state().snapshot, previous);
  assert.equal(partial.state().nextAttemptAt - partial.requests.at(-1).at, 30000);

  await partial.advance(29999);
  const recovered = allocationSnapshot(partial);
  recovered.slurm.data.squeue[0].name = 'Recovered training';
  partial.responses.push({status: 200, body: recovered});
  await partial.advance(1);
  assert.equal(partial.requests.length, 4);
  assert.equal(partial.state().snapshot, recovered);
  assert.equal(partial.state().error, null);
  assert.equal(partial.state().errorKind, null);
  assert.equal(partial.state().failureCount, 0);
  assert.equal(partial.evaluate('jobs[0].name'), 'Recovered training');
  assert.equal(partial.evaluate('nodes[0].stale'), false);
  assert.equal(partial.evaluate('nodes[0].gpus[0].allocated'), true);
  assert.equal(partial.element('#connection-status').hidden, true);
}

// Reports cannot be preserved indefinitely: after their 3-minute freshness
// window, a smaller valid snapshot is accepted even after an incomplete read.
const expired = browser();
await flush(); await expired.advance(5000);
expired.responses.push({status: 200, body: {nodes: [], slurm: null}});
await expired.element('#retry-live').onclick(); await flush();
assert.equal(expired.state().errorKind, 'incomplete');
await expired.visibility(true); await expired.advance(175001);
const emptyAfterExpiry = {nodes: [], slurm: null};
expired.responses.push({status: 200, body: emptyAfterExpiry});
await expired.visibility(false);
assert.equal(expired.state().snapshot, emptyAfterExpiry);
assert.equal(expired.state().error, null);
assert.equal(expired.evaluate('nodes.length'), 0);
assert.equal(expired.evaluate('jobs.length'), 0);
assert.match(expired.element('#connection-status').textContent, /Waiting for collectors/);

// An explicit fresh Slurm report with an empty queue is real information. It
// clears completed jobs instead of being mistaken for a missing collector.
const completed = browser();
await flush(); await completed.advance(5000);
const noJobs = completed.snapshot();
noJobs.slurm.data.squeue = [];
completed.responses.push({status: 200, body: noJobs});
await completed.element('#retry-live').onclick(); await flush();
assert.equal(completed.state().snapshot, noJobs);
assert.equal(completed.state().error, null);
assert.equal(completed.evaluate('jobs.length'), 0);
assert.equal(completed.evaluate('nodes[0].stale'), false);
assert.match(completed.element('#job-rows').innerHTML, /No jobs in the latest report/);
assert.equal(completed.element('#connection-status').hidden, true);

// A newly opened page has nothing to retain. Empty initial startup is still a
// normal waiting state, not a request failure or a sample-data fallback.
const emptyStartup = browser({hidden: true});
emptyStartup.responses.push({status: 200, body: {nodes: [], slurm: null}});
await emptyStartup.visibility(false);
assert.equal(emptyStartup.state().error, null);
assert.equal(emptyStartup.state().failureCount, 0);
assert.equal(emptyStartup.evaluate('nodes.length'), 0);
assert.equal(emptyStartup.evaluate('jobs.length'), 0);
assert.equal(emptyStartup.state().nextAttemptAt - emptyStartup.requests.at(-1).at, 30000);
assert.match(emptyStartup.element('#connection-status').textContent, /Waiting for collectors/);

// Removing the always-on banner must not conceal initial failures or make a
// sample view look live. The relocated control still opens sample information.
const connection = browser({hidden: true});
connection.evaluate('liveState.error = "Request failed"; renderConnection();');
assert.equal(connection.element('#connection-status').hidden, false);
assert.match(connection.element('#connection-status').textContent, /Request failed Live data is unavailable/);
connection.evaluate('liveState.mode = "demo"; renderConnection();');
assert.equal(connection.element('#connection-status').hidden, false);
assert.match(connection.element('#connection-status').textContent, /All values and names are fictional/);
assert.equal(connection.element('#retry-live').textContent, 'Data source');
assert.equal(connection.element('#retry-live').disabled, false);
await connection.element('#retry-live').onclick();
assert.match(connection.element('#dialog-content').innerHTML, /<h2 id="dialog-title">Collector connection<\/h2>/);
assert.equal(connection.requests.length, 0);

// The 3-minute boundary and help text agree, including reports that age while
// hidden. No extra network reads are needed just to evaluate freshness.
failures.evaluate('liveState.error=null;');
assert.equal(failures.evaluate('fresh(Date.now()-179000)'), true);
assert.equal(failures.evaluate('fresh(Date.now()-180000)'), false);
failures.evaluate('showDataInfo();');
assert.match(failures.element('#dialog-content').innerHTML, /every 30 seconds/);
assert.match(failures.element('#dialog-content').innerHTML, /older than 3 minutes/);
assert.match(failures.element('#dialog-content').innerHTML, /at least 5 seconds/);

// Disk availability must use the reported free value, not total minus used:
// reserved filesystem blocks are not available to ordinary users.
const storage = browser();
await flush();
const visibleText = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
storage.evaluate(`Object.assign(liveState.snapshot.nodes[0].data, {
  disk_path: '/', total_disk_gb: 1759, used_disk_gb: 1655, free_disk_gb: 15,
  subdisk_path: '/data', total_subdisk_gb: 14194, used_subdisk_gb: 12887, free_subdisk_gb: 591
}); normalizeSnapshot(liveState.snapshot); renderNodes(); showNode('devbox');`);
for (const selector of ['#node-grid', '#dialog-content']) {
  const html = storage.element(selector).innerHTML;
  assert.match(visibleText(html), /Main disk: \/ 94% \(15 \/ 1759 GiB\)/);
  assert.match(visibleText(html), /Data disk: \/data 91% \(591 \/ 14194 GiB\)/);
  assert.deepEqual([...html.matchAll(/class="storage-meter"[^>]*aria-valuenow="([^"]+)"/g)].map(match => Number(match[1])), [1655 / 1759 * 100, 12887 / 14194 * 100]);
  assert.doesNotMatch(html, /\(104 \/|\(1307 \/|storage-heading/);
}
const markup = raw => storage.evaluate(`storageMarkup({raw:${JSON.stringify(raw)}, stale:false})`);
assert.match(visibleText(markup({total_disk_gb:100, used_disk_gb:100, free_disk_gb:0})), /100% \(0 \/ 100 GiB\)/);
assert.match(markup({total_disk_gb:100, used_disk_gb:0, free_disk_gb:95}), /aria-valuenow="0"/);
assert.match(markup({total_disk_gb:100, used_disk_gb:50, free_disk_gb:null}), /Not reported/);
assert.match(visibleText(markup({total_disk_gb:100, used_disk_gb:50})), /50% \(— \/ 100 GiB\)/);
assert.match(markup({total_disk_gb:100, used_disk_gb:50}), /aria-valuenow="50"/);
assert.doesNotMatch(markup({total_disk_gb:100, used_disk_gb:50}), /\(50 \/|Data disk|storage-heading/);
for (const free of [-1, 101, '50']) {
  const html = markup({total_disk_gb:100, free_disk_gb:free});
  assert.match(html, /Not reported/);
  assert.match(visibleText(html), /\(— \/ 100 GiB\)/);
}
for (const used of [-1, 101, '50', null]) {
  const html = markup({total_disk_gb:100, used_disk_gb:used, free_disk_gb:5});
  assert.match(visibleText(html), /— \(5 \/ 100 GiB\)/);
  assert.doesNotMatch(html, /aria-valuenow=|style="width:/);
}
for (const total of [0, -1, '100', null]) {
  const html = markup({total_disk_gb:total, used_disk_gb:50, free_disk_gb:5});
  assert.match(visibleText(html), /— \(5 \/ — GiB\)/);
  assert.doesNotMatch(html, /aria-valuenow=|style="width:/);
}
assert.match(markup({total_disk_gb:100, free_disk_gb:0.5}), /\(0\.5 \/ 100 GiB\)/);
assert.match(markup({total_disk_gb:4096, free_disk_gb:2048}), /\(2048 \/ 4096 GiB\)/);
assert.match(markup({total_disk_gb:100, free_disk_gb:1, disk_path:'/<script>bad</script>'}), /&lt;script&gt;/);
storage.evaluate('liveState.error="Request failed"; normalizeSnapshot(liveState.snapshot); renderNodes(); showNode("devbox");');
for (const selector of ['#node-grid', '#dialog-content']) {
  const html = storage.element(selector).innerHTML;
  assert.match(html, /Stale report/); assert.match(html, /Awaiting fresh data/);
  assert.doesNotMatch(html, /\(15 \/ 1759 GiB\)|\(591 \/ 14194 GiB\)/);
  assert.doesNotMatch(html, /class="storage-meter"[^>]*aria-valuenow=/);
  assert.equal([...html.matchAll(/class="storage-meter is-unavailable"/g)].length, 2);
}
storage.evaluate('liveState.error=null; liveState.snapshot.nodes[0].receivedAt=Date.now()-180000; normalizeSnapshot(liveState.snapshot); renderNodes();');
assert.match(storage.element('#node-grid').innerHTML, /Stale report/);

// The compact cards and detail dialog must distinguish real zero usage from
// unavailable metrics, including impossible VRAM usage above device capacity.
const metrics = browser();
await flush();
const renderMetrics = code => metrics.evaluate(`${code}; normalizeSnapshot(liveState.snapshot); renderNodes(); showNode('devbox');`);
renderMetrics('Object.assign(liveState.snapshot.nodes[0].data.gpus[0], {gpu_utilization:0,vram_total_used_mb:0})');
const gpuCard = () => metrics.evaluate('gpuBlockMarkup(nodes[0], nodes[0].gpus[0])');
assert.match(visibleText(gpuCard()), /UTIL 0% VRAM 0% \(0 \/ 1 GiB\)/);
assert.equal([...gpuCard().matchAll(/role="meter"/g)].length, 2);
assert.equal([...gpuCard().matchAll(/aria-valuenow="0"/g)].length, 2);
assert.match(metrics.element('#dialog-content').innerHTML, /0\.0 \/ 1\.0 GiB/);
assert.match(metrics.element('#dialog-content').innerHTML, /0%/);
renderMetrics('Object.assign(liveState.snapshot.nodes[0].data.gpus[0], {gpu_utilization:99,vram_total_used_mb:30720,vram_total_mb:49152})');
assert.match(visibleText(gpuCard()), /UTIL 99% VRAM 63% \(30 \/ 48 GiB\)/);
assert.match(gpuCard(), /aria-label="UTIL"[^>]*aria-valuenow="99"/);
assert.match(gpuCard(), /aria-label="VRAM"[^>]*aria-valuenow="62\.5"/);
renderMetrics('Object.assign(liveState.snapshot.nodes[0].data.gpus[0], {vram_total_used_mb:2048,vram_total_mb:1024})');
assert.equal(metrics.evaluate('nodes[0].gpus[0].memoryUsed'), null);
for (const selector of ['#node-grid', '#dialog-content']) {
  assert.match(visibleText(metrics.element(selector).innerHTML), /VRAM —/);
  assert.doesNotMatch(metrics.element(selector).innerHTML, /2(?:\.0)? \/ 1(?:\.0)? GiB|200%/);
}
for (const value of ['null', 'NaN', '-1', '101']) {
  renderMetrics(`Object.assign(liveState.snapshot.nodes[0].data, {cpu_percent:${value},ram_percent:${value}});
    liveState.snapshot.nodes[0].data.gpus[0].gpu_utilization=${value}`);
  assert.match(metrics.element('#node-grid').innerHTML, /Not reported/);
  assert.doesNotMatch(gpuCard(), /aria-valuenow=|style="width:/);
  assert.match(visibleText(gpuCard()), /UTIL — VRAM —/);
  assert.doesNotMatch(metrics.element('#node-grid').innerHTML, /--p:|NaN%|101%|-1%|>0%/);
  assert.match(metrics.element('#dialog-content').innerHTML, /Compute —/);
}
for (const cause of ['liveState.snapshot.nodes[0].receivedAt=Date.now()-180000', 'liveState.error="Request failed"', 'liveState.snapshot.nodes[0].data.gpus[0].collection_error="Query failed"']) {
  renderMetrics(`liveState.error=null; liveState.snapshot.nodes[0].receivedAt=Date.now();
    Object.assign(liveState.snapshot.nodes[0].data.gpus[0], {gpu_utilization:77,vram_total_used_mb:512,collection_error:null}); ${cause}`);
  for (const selector of ['#node-grid', '#dialog-content']) {
    assert.match(visibleText(metrics.element(selector).innerHTML), /VRAM —/);
    assert.doesNotMatch(metrics.element(selector).innerHTML, /77%|0\.5 \/ 1(?:\.0)? GiB|--p:/);
  }
  assert.doesNotMatch(gpuCard(), /aria-valuenow=|style="width:/);
}

// Server CPU/RAM summaries represent Slurm reservations, not the collector's
// measured utilization. Scheduler idle counts exclude unavailable/Other CPUs.
const allocations = browser();
await flush();
const resourceFixture = {
  name: 'devbox', state: 'MIXED', cpus: 64, alloc_cpus: 60, idle_cpus: 4,
  real_memory: 512000, alloc_memory: 432128
};
const renderAllocations = (overrides = {}, code = '') => allocations.evaluate(`
  liveState.error = null;
  liveState.snapshot.nodes[0].receivedAt = Date.now();
  liveState.snapshot.slurm.receivedAt = Date.now();
  liveState.snapshot.slurm.data.sinfo = [${JSON.stringify({...resourceFixture, ...overrides})}];
  Object.assign(liveState.snapshot.nodes[0].data, {cpu_percent: 1, ram_percent: 2});
  ${code}; normalizeSnapshot(liveState.snapshot); renderNodes();`);
const resources = () => JSON.parse(allocations.evaluate('JSON.stringify(nodes[0].slurmResources)'));
// Extract a complete resource row without depending on whether text values have
// nested spans, then inspect its visible text and explanatory tooltip separately.
const resourceRow = label => {
  const html = allocations.element('#node-grid').innerHTML;
  const labelAt = html.indexOf(`>${label}</span>`);
  assert.ok(labelAt >= 0, `Missing ${label} summary`);
  const start = html.lastIndexOf('<div class="resource-row', labelAt);
  assert.ok(start >= 0, `Missing ${label} resource row`);
  let depth = 0;
  for (const tag of html.slice(start).matchAll(/<\/?div\b[^>]*>/g)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, start + tag.index + tag[0].length);
  }
  assert.fail(`Unclosed ${label} resource row`);
};
const rowText = label => resourceRow(label).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const assertNoFree = (label, reason) => {
  assert.match(rowText(label), new RegExp(reason));
  assert.doesNotMatch(rowText(label), /\bFree\b/);
  assert.doesNotMatch(resourceRow(label), /class="meter|width:[\d.]+%/);
};

renderAllocations();
assert.deepEqual(resources(), {
  cpu: {total: 64, allocated: 60, free: 4},
  ram: {total: 500, allocated: 422, free: 78}
});
assert.equal(rowText('CPU'), 'CPU 4 / 64');
assert.equal(rowText('RAM'), 'RAM 78 / 500 GiB');
assert.match(resourceRow('CPU'), /60 allocated · 4 free · 64 total · Slurm/);
assert.match(resourceRow('RAM'), /422 GiB allocated · 78 GiB free · 500 GiB total · Slurm/);
for (const label of ['CPU', 'RAM']) assert.doesNotMatch(resourceRow(label), /class="meter|role="meter"|width:[\d.]+%/);
assert.doesNotMatch(rowText('CPU'), /1%/);
assert.doesNotMatch(rowText('RAM'), /2%/);

for (const [allocated, free] of [[0, 64], [64, 0], [60, 0]]) {
  renderAllocations({alloc_cpus: allocated, idle_cpus: free});
  assert.deepEqual(resources().cpu, {total: 64, allocated, free});
  assert.equal(rowText('CPU'), `CPU ${free} / 64`);
}
for (const [allocated, free] of [[0, 500], [512000, 0]]) {
  renderAllocations({alloc_memory: allocated});
  assert.deepEqual(resources().ram, {total: 500, allocated: allocated / 1024, free});
  assert.equal(rowText('RAM'), `RAM ${free} / 500 GiB`);
}
renderAllocations({real_memory: 522240, mem_spec_limit: 10240});
assert.deepEqual(resources().ram, {total: 500, allocated: 422, free: 78});
renderAllocations({cpus: 128, alloc_cpus: 36, idle_cpus: 92,
  real_memory: 1536000, alloc_memory: 221184});
assert.equal(rowText('CPU'), 'CPU 92 / 128');
assert.equal(rowText('RAM'), 'RAM 1284 / 1500 GiB');
renderAllocations({real_memory: 512512, alloc_memory: 432128});
assert.equal(rowText('RAM'), 'RAM 78.5 / 500.5 GiB');

for (const invalid of [
  {cpus: null}, {cpus: 0}, {cpus: -1}, {cpus: '64'}, {cpus: 64.5},
  {alloc_cpus: null}, {alloc_cpus: -1}, {alloc_cpus: 65}, {alloc_cpus: 60.5},
  {idle_cpus: null}, {idle_cpus: -1}, {idle_cpus: 5}, {idle_cpus: 0.5}
]) {
  renderAllocations(invalid);
  assert.equal(resources().cpu, null, JSON.stringify(invalid));
  assertNoFree('CPU', 'Not reported');
  assert.equal(rowText('RAM'), 'RAM 78 / 500 GiB');
}
for (const invalid of [
  {real_memory: null}, {real_memory: 0}, {real_memory: -1}, {real_memory: '512000'},
  {alloc_memory: null}, {alloc_memory: -1}, {alloc_memory: 512001},
  {mem_spec_limit: -1}, {mem_spec_limit: 512000}, {mem_spec_limit: 512001},
  {mem_spec_limit: 100000}
]) {
  renderAllocations(invalid);
  assert.equal(resources().ram, null, JSON.stringify(invalid));
  assertNoFree('RAM', 'Not reported');
  assert.equal(rowText('CPU'), 'CPU 4 / 64');
}
for (const field of ['cpus', 'alloc_cpus', 'idle_cpus', 'real_memory', 'alloc_memory']) {
  renderAllocations({}, `delete liveState.snapshot.slurm.data.sinfo[0].${field}`);
  assertNoFree(['cpus', 'alloc_cpus', 'idle_cpus'].includes(field) ? 'CPU' : 'RAM', 'Not reported');
}

for (const state of ['DOWN', 'MIXED+DRAIN', 'FAIL', 'MAINT', 'UNKNOWN', 'NOT_RESPONDING', 'IDLE*']) {
  renderAllocations({state});
  assertNoFree('CPU', 'Unavailable');
  assertNoFree('RAM', 'Unavailable');
}
for (const cause of [
  'liveState.snapshot.slurm.receivedAt = Date.now() - 180000',
  'liveState.error = "Request failed"'
]) {
  renderAllocations({}, cause);
  assertNoFree('CPU', 'Stale');
  assertNoFree('RAM', 'Stale');
}
renderAllocations({}, 'liveState.snapshot.nodes[0].receivedAt = Date.now() - 180000');
assert.equal(rowText('CPU'), 'CPU 4 / 64');
assert.equal(rowText('RAM'), 'RAM 78 / 500 GiB');

// Standalone utilization retains its percentage semantics without restoring bars.
for (const [value, expected] of [[0, '0%'], [45, '45%'], [100, '100%'], [null, '—'], [-1, '—'], [101, '—']]) {
  const markup = allocations.evaluate(`resourceMarkup('CPU', ${JSON.stringify(value)})`);
  assert.equal(visibleText(markup), `CPU ${expected}`);
  assert.doesNotMatch(markup, /class="meter|width:[\d.]+%/);
}

console.log('PASS: relocated refresh control and error-only connection status, hidden startup/pause, abort and visibility resume, 30-second cadence, 5-second manual cooldown, quota/error backoff and recovery, incomplete snapshot retention/30-second recovery/expiry/empty-queue handling, retained stale data, 3-minute freshness, disk availability/reserves/units/missing/zero/stale handling, card/detail metric bounds/zero/stale/error handling, and text-only Slurm CPU/RAM free/total capacity/idle/reserves/invalid/state/freshness handling.');
