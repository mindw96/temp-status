import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Execute the production scripts with a small DOM. Filter changes must be local
// and retain their meaning when a fresh queue has no matching jobs.
const elements = new Map(), tools = new Map();
let requests = 0;
function element(selector) {
  assert.notEqual(selector, '#partition-filter', 'The removed partition control must not be accessed');
  if (!elements.has(selector)) {
    const listeners = new Map();
    elements.set(selector, {innerHTML: '', textContent: '', value: '', disabled: false,
      dataset: {}, classList: {toggle() {}}, setAttribute() {}, showModal() {},
      addEventListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(callback);
      },
      dispatch(name, value) {
        if (value !== undefined) this.value = value;
        for (const callback of listeners.get(name) || []) callback({target: this});
      }
    });
  }
  return elements.get(selector);
}
const tabs = ['all', 'RUNNING', 'PENDING'].map(state => {
  const tab = element(`[data-state="${state}"]`); tab.dataset.state = state; return tab;
});
const document = {
  hidden: true, querySelector: element,
  querySelectorAll: selector => selector === '[data-state]' ? tabs : [],
  addEventListener() {}, modelContext: {registerTool(tool) {tools.set(tool.name, tool);}}
};
const context = vm.createContext({document, structuredClone, Date, Intl, AbortController,
  window: {addEventListener() {}}, setTimeout() {return 1;}, clearTimeout() {},
  fetch() {requests++; throw new Error('Filters must not request data');}
});
for (const name of ['app.js', 'gpu-jobs.js', 'live.js']) {
  vm.runInContext(await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8'), context);
}
const evaluate = code => vm.runInContext(code, context);
const plain = value => JSON.parse(JSON.stringify(value));
const ids = () => plain(evaluate('filteredJobs().map(job => job.id)'));
const visibleIds = () => [...element('#job-rows').innerHTML.matchAll(/<tr><td[^>]*>([^<]*)<\/td>/g)].map(match => match[1]);
const apply = toolInput => plain(tools.get('filter_cluster_dashboard').execute(toolInput));
const job = (id, user, target, state = 'RUNNING', extra = {}) => ({
  job_id: String(id), name: `Long training job ${id}`, user, node_list_or_reason: target,
  job_state: state, partition: 'gpu', req_gpus: '1', time: '12:34:56', ...extra
});
function report(queue, reportedNodes = ['devbox', 'server2', 'ubuntu', 'server4']) {
  const snapshot = {nodes: reportedNodes.map(server_name => ({receivedAt: Date.now(), data: {server_name, gpus: []}})),
    slurm: {receivedAt: Date.now(), data: {sinfo: reportedNodes.map(name => ({name, state: 'MIXED'})), squeue: queue}}};
  evaluate(`liveState.snapshot = ${JSON.stringify(snapshot)}; normalizeSnapshot(liveState.snapshot); render();`);
}

// Exact names and compressed/multiple-node allocations, with no range expansion.
for (const [hostlist, name, expected] of [
  ['server20', 'server2', false], ['server2', 'server2', true],
  ['devbox,server2', 'server2', true], ['devbox server2', 'devbox', true],
  ['server[2,4]', 'server2', true], ['server[2,4]', 'server3', false],
  ['devbox,server[2-4],ubuntu', 'ubuntu', true], ['server[2-4]', 'server4', true],
  ['server[2-4]', 'server20', false], ['server[02-04]', 'server02', true],
  ['server[02-04]', 'server2', false], ['server[2-4]', 'server02', false],
  ['rack[1-2]node[01-03]', 'rack2node03', true],
  ['rack[1-2]node[01-03]', 'rack3node03', false],
  ['server[1-999999999999999999999999999999]', 'server2', true],
  ['server[2-4', 'server2', false], ['server[[2]]', 'server2', false],
  ['server[4-2]', 'server2', false], ['server[a-z]', 'server2', false]
]) assert.equal(evaluate(`hostlistContains(${JSON.stringify(hostlist)}, ${JSON.stringify(name)})`), expected, `${hostlist} / ${name}`);

const original = [
  job(1, 'alice', 'devbox'), job(2, 'alice', 'server2'), job(3, 'bob', 'server[2,4]'),
  job(4, 'alice', '(Resources)', 'PENDING', {req_node_list: 'server2', batch_host: 'server2'}),
  job(5, 'bob', 'server20'), job(6, 'alice', 'server2', 'PENDING'),
  job(7, 'alice', '(null)', 'CONFIGURING'), job(8, 'carol', 'ubuntu')
];
report(original);
assert.deepEqual(plain(evaluate('jobFilterServers()')), ['devbox', 'server2', 'ubuntu', 'server4']);
assert.match(element('#job-user-filter').innerHTML, /value="alice"/);
assert.match(element('#job-server-filter').innerHTML, /value="@unassigned"/);
assert.equal(element('#reset-job-filters').disabled, true);
assert.deepEqual(apply({server: 'server2'}).visibleJobIds, ['2', '3', '4']);
assert.equal(element('#total-jobs').textContent, 3);
assert.equal(element('#running-jobs').textContent, 2);
assert.equal(element('#pending-jobs').textContent, 1);
assert.deepEqual(apply({user: 'alice'}).visibleJobIds, ['2', '4']);
assert.deepEqual(apply({search: 'training job 3'}).visibleJobIds, []);
assert.match(element('#job-rows').innerHTML, /No matching jobs/);
assert.deepEqual(apply({user: 'bob'}).visibleJobIds, ['3']);
assert.deepEqual(apply({server: 'devbox'}).visibleJobIds, []);
assert.deepEqual(apply({server: '@unassigned', user: 'alice', search: ''}).visibleJobIds, ['4', '6', '7']);
assert.equal(element('#pending-jobs').textContent, 2);
assert.deepEqual(apply({jobState: 'PENDING'}).visibleJobIds, ['4', '6']);
assert.throws(() => apply({partition: 'gpu'}), /Unsupported filter/);
assert.equal(tools.get('filter_cluster_dashboard').inputSchema.properties.partition, undefined);
assert.throws(() => apply({server: 'server20'}), /Unsupported filter/);
assert.throws(() => apply({user: 123}), /Unsupported filter/);

// Pending jobs are associated only with explicitly requested nodes. A reason,
// apparent target, batch host, or shared partition is not a server assignment.
element('#reset-job-filters').dispatch('click');
const pendingQueue = [
  job(101, 'alice', '(Resources)', 'PENDING', {req_node_list: 'devbox,server2', batch_host: 'ubuntu'}),
  job(102, 'alice', '(Priority)', 'PD', {req_node_list: 'server[2,4]'}),
  job(103, 'bob', '(Resources)', 'PENDING', {req_node_list: 'server20'}),
  job(104, 'bob', '(ReqNodeNotAvail, UnavailableNodes:server2)', 'PENDING', {batch_host: 'server2'}),
  job(105, 'alice', 'server2', 'PENDING', {req_node_list: '(null)', batch_host: 'server2'}),
  job(106, 'alice', '(Resources)', 'PENDING', {req_node_list: ' ubuntu '}),
  job(107, 'bob', 'server4', 'RUNNING', {req_node_list: 'server2'})
];
report(pendingQueue);
assert.deepEqual(apply({server: 'server2'}).visibleJobIds, ['101', '102']);
assert.equal(element('#total-jobs').textContent, 2);
assert.equal(element('#pending-jobs').textContent, 2);
assert.equal(element('#running-jobs').textContent, 0);
assert.deepEqual(apply({server: 'devbox'}).visibleJobIds, ['101']);
assert.deepEqual(apply({server: 'server4'}).visibleJobIds, ['102', '107']);
assert.deepEqual(apply({server: 'ubuntu'}).visibleJobIds, ['106']);
assert.match(element('#job-rows').innerHTML, /Requested: Server3/);
assert.deepEqual(apply({server: '@unassigned'}).visibleJobIds, ['101', '102', '103', '104', '105', '106']);
assert.match(element('#job-rows').innerHTML, /Server not specified/);
// Search accepts reported hostnames and display aliases, but not batch hosts.
assert.deepEqual(apply({server: '', search: 'devbox'}).visibleJobIds, ['101']);
assert.deepEqual(apply({search: 'Server1'}).visibleJobIds, ['101']);
assert.deepEqual(apply({search: 'Server3'}).visibleJobIds, ['106']);
assert.deepEqual(apply({server: 'server2', search: '', user: 'bob'}).visibleJobIds, []);
assert.deepEqual(apply({user: 'alice', jobState: 'PENDING'}).visibleJobIds, ['101', '102']);
assert.deepEqual(apply({jobState: 'RUNNING'}).visibleJobIds, []);
assert.equal(element('#pending-jobs').textContent, 2, 'Status counts retain the user/server filters');
evaluate('showJob("106")');
assert.match(element('#dialog-content').innerHTML, /<dt>Requested nodes<\/dt><dd>Server3<\/dd>/);
assert.doesNotMatch(element('#dialog-content').innerHTML, /<dt>Assigned nodes<\/dt><dd>Server3/);
evaluate('showJob("105")');
assert.match(element('#dialog-content').innerHTML, /<dt>Requested nodes<\/dt><dd>Not specified<\/dd>/);

// Missing or malformed metadata cannot silently assign a pending job. Slurm's
// common empty sentinels also remain in the unassigned view without throwing.
const noRequest = [undefined, null, '', '  ', '(null)', '(none)', 'None', 'N/A', '—', 123, {}, ['server2']];
element('#reset-job-filters').dispatch('click');
report(noRequest.map((req_node_list, index) => job(200 + index, 'alice', 'server2', 'PENDING', {req_node_list, batch_host: 'server2'})));
assert.deepEqual(apply({server: 'server2'}).visibleJobIds, []);
assert.equal(apply({server: '@unassigned'}).visibleJobIds.length, noRequest.length);
assert.match(element('#job-rows').innerHTML, /Server not specified/);
assert.equal(visibleIds().length, 10);

// Pending pagination includes requested-server jobs and resets/clamps when
// filters change or a new report moves the job from requested to assigned nodes.
element('#reset-job-filters').dispatch('click');
report(Array.from({length: 23}, (_, index) => job(300 + index, 'alice', '(Resources)', 'PENDING', {req_node_list: 'server2'})));
apply({server: 'server2', user: 'alice', jobState: 'PENDING'});
assert.equal(element('#pending-jobs').textContent, 23);
assert.equal(visibleIds().length, 10);
assert.equal(element('#page-number').textContent, '1 / 3');
element('#next-page').onclick();
element('#next-page').onclick();
assert.deepEqual(visibleIds(), ['320', '321', '322']);
report([job(300, 'alice', 'server4', 'RUNNING', {req_node_list: 'server2'})]);
assert.deepEqual(ids(), []);
assert.equal(element('#page-number').textContent, '1 / 1');
assert.deepEqual(apply({server: 'server4', jobState: 'RUNNING'}).visibleJobIds, ['300']);
assert.deepEqual(apply({server: '@unassigned', jobState: 'all'}).visibleJobIds, []);

// Filter controls reset page immediately, without a fetch, and each combines
// with the others. Clear filters returns the entire queue and first page.
element('#reset-job-filters').dispatch('click');
report(Array.from({length: 36}, (_, index) => job(index + 1, index % 2 ? 'bob' : 'alice', 'server2')));
assert.deepEqual(visibleIds(), Array.from({length: 10}, (_, index) => String(index + 1)));
assert.equal(element('#page-number').textContent, '1 / 4');
assert.equal(element('#result-count').textContent, '36 jobs · Showing 1–10');
assert.equal(element('#prev-page').disabled, true);
assert.equal(element('#next-page').disabled, false);
element('#next-page').onclick();
assert.deepEqual(visibleIds(), Array.from({length: 10}, (_, index) => String(index + 11)));
assert.equal(element('#result-count').textContent, '36 jobs · Showing 11–20');
element('#prev-page').onclick();
assert.equal(element('#page-number').textContent, '1 / 4');
evaluate('liveState.page = 4; renderJobs();');
assert.deepEqual(visibleIds(), ['31', '32', '33', '34', '35', '36']);
assert.equal(element('#page-number').textContent, '4 / 4');
assert.equal(element('#result-count').textContent, '36 jobs · Showing 31–36');
assert.equal(element('#prev-page').disabled, false);
assert.equal(element('#next-page').disabled, true);
// A refreshed queue that shrinks clamps to its last valid page.
report(Array.from({length: 21}, (_, index) => job(index + 1, index % 2 ? 'bob' : 'alice', 'server2')));
assert.equal(element('#page-number').textContent, '3 / 3');
assert.deepEqual(visibleIds(), ['21']);
assert.equal(element('#result-count').textContent, '21 jobs · Showing 21–21');
report(Array.from({length: 36}, (_, index) => job(index + 1, index % 2 ? 'bob' : 'alice', 'server2')));
evaluate('liveState.page = 4; renderJobs();');
element('#job-user-filter').dispatch('change', 'alice');
assert.equal(evaluate('liveState.page'), 1);
assert.equal(ids().length, 18);
assert.equal(element('#page-number').textContent, '1 / 2');
assert.equal(visibleIds().length, 10);
evaluate('liveState.page = 2;');
element('#job-server-filter').dispatch('change', 'server2');
assert.equal(evaluate('liveState.page'), 1);
evaluate('liveState.page = 2;');
element('#job-search').dispatch('input', 'training');
assert.equal(evaluate('liveState.page'), 1);
evaluate('liveState.page = 2;');
tabs[1].dispatch('click');
assert.equal(evaluate('liveState.page'), 1);
assert.equal(evaluate('state.jobState'), 'RUNNING');
evaluate('liveState.page = 2;');
apply({user: 'bob'});
assert.equal(evaluate('liveState.page'), 1);

// A disappearing selected user is retained. Refresh must not broaden a filter
// to all users when their final job finishes or the whole queue becomes empty.
report([job(40, 'carol', 'devbox')]);
assert.deepEqual(ids(), []);
assert.equal(element('#job-user-filter').value, 'bob');
assert.match(element('#job-user-filter').innerHTML, /bob · No current jobs/);
assert.equal(element('#job-server-filter').value, 'server2');
report([]);
assert.deepEqual(ids(), []);
assert.equal(element('#job-user-filter').value, 'bob');
assert.equal(evaluate('state.server'), 'server2');
assert.match(element('#job-rows').innerHTML, /colspan="7"/);
assert.match(element('#job-rows').innerHTML, /No jobs in the latest report/);
assert.equal(element('#page-number').textContent, '1 / 1');
assert.equal(element('#prev-page').disabled, true);
assert.equal(element('#next-page').disabled, true);
report([job(41, 'bob', 'server2')]);
assert.deepEqual(ids(), ['41']);
assert.doesNotMatch(element('#job-user-filter').innerHTML, /No current jobs/);

// Unknown nodes reported by Slurm are also selectable, ordered after the lab
// aliases. A vanished selected node remains selected as a zero-match option.
report([job(42, 'bob', 'extra-node')], ['devbox', 'extra-node']);
assert.deepEqual(apply({server: 'extra-node'}).visibleJobIds, ['42']);
report([job(43, 'bob', 'devbox')]);
assert.equal(element('#job-server-filter').value, 'extra-node');
assert.match(element('#job-server-filter').innerHTML, /extra-node · No current jobs/);
assert.deepEqual(ids(), []);

// Partition changes do not limit the remaining user/server filters or node cards.
element('#reset-job-filters').dispatch('click');
apply({user: 'bob', server: 'devbox'});
report([job(43, 'bob', 'devbox', 'RUNNING', {partition: 'other'})]);
assert.equal(evaluate('state.partition'), undefined);
assert.deepEqual(ids(), ['43']);
assert.deepEqual(plain(evaluate('currentNodes().map(node => node.id)')), ['devbox', 'server2', 'ubuntu', 'server4']);

// Clearing also clears the shared status and search filters.
apply({jobState: 'RUNNING', search: 'job'});
element('#reset-job-filters').dispatch('click');
assert.deepEqual(plain(evaluate('state')), {jobState: 'all', search: '', user: '', server: ''});
assert.equal(evaluate('liveState.page'), 1);
assert.equal(element('#job-search').value, '');
assert.equal(element('#job-user-filter').value, '');
assert.equal(element('#job-server-filter').value, '');
assert.equal(element('#reset-job-filters').disabled, true);
assert.deepEqual(ids(), ['43']);
assert.equal(requests, 0);

// Escaping still protects names in widened cells, titles, and select labels.
const unusualName = 'Training <script> & "full name"';
report([job(44, 'user<one>"', 'devbox', 'RUNNING', {name: unusualName})]);
const markup = element('#job-rows').innerHTML;
assert.equal((markup.match(/<td(?:\s|>)/g) || []).length, 7);
assert.match(markup, /class="job-name-cell"/);
assert.match(markup, /title="Training &lt;script&gt; &amp; &quot;full name&quot;"/);
assert.doesNotMatch(markup, /<script>|partition-chip|12:34:56/);
assert.match(element('#job-user-filter').innerHTML, /user&lt;one&gt;&quot;/);

// Requested nodes are untrusted report text in both the row and detail dialog.
const unusualRequest = 'server2<script> & "host"';
report([job(45, 'alice', '(Resources)', 'PENDING', {req_node_list: unusualRequest})]);
assert.match(element('#job-rows').innerHTML, /server2&lt;script&gt; &amp; &quot;host&quot;/);
assert.doesNotMatch(element('#job-rows').innerHTML, /<script>/);
evaluate('showJob("45")');
assert.match(element('#dialog-content').innerHTML, /server2&lt;script&gt; &amp; &quot;host&quot;/);
assert.doesNotMatch(element('#dialog-content').innerHTML, /<script>/);

// Requested memory preserves units and scope without turning missing data into
// zero, or treating an explicit all-node-memory request as a zero allocation.
for (const [raw, expected] of [
  [{req_mem: '4G', req_mem_scope: 'total'}, '4 GiB total'],
  [{job_id: '46_[2-8%3]', req_mem: '59G', req_mem_scope: 'total'}, '59 GiB per array task'],
  [{req_mem: '32768M', req_mem_scope: 'node'}, '32 GiB per node'],
  [{req_mem: '2048M', req_mem_scope: 'cpu'}, '2 GiB per CPU'],
  [{req_mem: '512Mc'}, '512 MiB per CPU'],
  [{req_mem: '1.5Tn'}, '1.5 TiB per node'],
  [{req_mem: '64G'}, '64 GiB'],
  [{req_mem: '0M', req_mem_scope: 'node'}, 'All node memory'],
  [{req_mem: '0n'}, 'All node memory'],
  ...[{}, {req_mem: ''}, {req_mem: '-4G'}, {req_mem: 'NaN'},
    {req_mem: '<script>'}, {req_mem: '0'}, {req_mem: '0', req_mem_scope: 'total'},
    {req_mem: '4Gc', req_mem_scope: 'total'}].map(raw => [raw, 'Not reported'])
]) {
  report([job(46, 'alice', 'devbox', 'RUNNING', {req_cpus: '2', ...raw})]);
  evaluate(`showJob(${JSON.stringify(raw.job_id || '46')})`);
  const dialog = element('#dialog-content').innerHTML;
  assert.ok(dialog.includes(`<dt>Requested RAM</dt><dd>${expected}</dd>`), JSON.stringify(raw));
  assert.match(dialog, /<dt>Requested CPUs<\/dt><dd>2<\/dd>/);
  assert.doesNotMatch(dialog, /<script>/);
}
report([job(47, 'alice', '(Priority)', 'PENDING', {req_mem: '32G', req_mem_scope: 'total'})]);
evaluate('showJob("47")');
assert.match(element('#dialog-content').innerHTML, /<dt>Requested RAM<\/dt><dd>32 GiB total<\/dd>/);
assert.match(element('#dialog-content').innerHTML, /<dt>Requested CPUs<\/dt><dd>Not reported<\/dd>/);

// Requested and allocated GPUs must not be derived from the number of devices
// with matching processes. Multiple processes on one device still mean one GPU.
report([job(54901, 'alice', 'server2', 'RUNNING', {req_gpus: '2', alloc_gpus: '2'})]);
evaluate(`liveState.snapshot.nodes.find(n => n.data.server_name === 'server2').data.gpus = [
  {id: 0, processes: [{pid: 10, slurm_job_id: '54901'}, {pid: 11, slurm_job_id: '54901'}]},
  {id: 2, processes: []}
]; normalizeSnapshot(liveState.snapshot); showJob('54901');`);
assert.match(element('#dialog-content').innerHTML, /<dt>Requested GPUs<\/dt><dd>2<\/dd>/);
assert.match(element('#dialog-content').innerHTML, /<dt>Slurm allocated GPUs<\/dt><dd>2<\/dd>/);
assert.match(element('#dialog-content').innerHTML, /<dt>GPUs with observed processes<\/dt><dd>1 GPU · Server2 \/ GPU 0<\/dd>/);
assert.doesNotMatch(element('#dialog-content').innerHTML, /Server2 \/ GPU 2/);
evaluate(`liveState.snapshot.slurm.receivedAt = Date.now() - FRESHNESS_MS - 1; showJob('54901');`);
assert.match(element('#dialog-content').innerHTML, /Unavailable while Slurm data is stale/);
assert.doesNotMatch(element('#dialog-content').innerHTML, /1 GPU ·/);
for (const [state, raw, expected] of [
  ['RUNNING', {req_gpus: '0', alloc_gpus: '0'}, '0'],
  ['RUNNING', {req_gpus: '2'}, 'Not reported'],
  ['PENDING', {req_gpus: '2'}, 'Not allocated yet']
]) {
  report([job(48, 'alice', 'server2', state, raw)]);
  evaluate('showJob("48")');
  assert.ok(element('#dialog-content').innerHTML.includes(`<dt>Slurm allocated GPUs</dt><dd>${expected}</dd>`));
}

// Allocation owns the card even with zero utilization and no GPU processes.
// Node3 deliberately has an NVML index that differs from its GRES index.
const ownerQueue = [
  job(54901, 'ryujh', 'server2', 'RUNNING', {req_gpus: '2', alloc_gpus: '2',
    gpu_allocations: [{node: 'server2', gres_indices: [0, 2]}]}),
  job(54902, 'ryujh', 'server2', 'RUNNING', {req_gpus: '2', alloc_gpus: '2',
    gpu_allocations: [{node: 'server2', gres_indices: [3, 5]}]}),
  job(60000, 'alice', 'ubuntu', 'RUNNING', {gpu_allocations: [{node: 'ubuntu', gres_indices: [2]}]}),
  job(60001, 'pending-user', '(Resources)', 'PENDING', {gpu_allocations: [{node: 'server2', gres_indices: [1]}]})
];
report(ownerQueue);
evaluate(`liveState.snapshot.nodes.find(n => n.data.server_name === 'server2').data.gpus =
  Array.from({length: 8}, (_, id) => ({id, minor_number: id, slurm_gres_index: id,
    gpu_utilization: 0, vram_total_mb: 49152, vram_total_used_mb: 4,
    processes: id === 0 ? [{pid: 10, slurm_job_id: '54901'}] : []}));
liveState.snapshot.nodes.find(n => n.data.server_name === 'ubuntu').data.gpus =
  [2, 3, 0, 1].map((minor, id) => ({id, minor_number: minor, slurm_gres_index: minor, processes: []}));
normalizeSnapshot(liveState.snapshot); render();`);
assert.deepEqual(plain(evaluate("nodes.find(n => n.id === 'server2').gpus.map(g => g.allocationRecords.map(r => r.jobId))")),
  [['54901'], [], ['54901'], ['54902'], [], ['54902'], [], []]);
assert.deepEqual(plain(evaluate("nodes.find(n => n.id === 'ubuntu').gpus.map(g => g.allocationRecords.map(r => r.jobId))")),
  [['60000'], [], [], []]);
const idleMarkup = () => evaluate("gpuBlockMarkup(nodes.find(n => n.id === 'server2'), nodes.find(n => n.id === 'server2').gpus[2])");
assert.match(idleMarkup(), /data-source="allocation"/);
assert.match(idleMarkup(), /54901/); assert.match(idleMarkup(), /ryujh/);
assert.match(idleMarkup(), /UTIL <strong>0%<\/strong>/);
assert.match(idleMarkup(), /류정환\(ryujh\)/);
assert.doesNotMatch(idleMarkup(), /No process observed|Observed: ryujh/);
assert.equal(evaluate("nodes.find(n => n.id === 'server2').gpus[2].allocated"), true);
// Compact cards keep the GPU and owner ahead of the job name and put measured
// metrics last. Multiple records must retain every link, with one GPU label.
const singleCard = idleMarkup();
const gpuAt = singleCard.indexOf('>GPU 2</span>');
const ownerAt = singleCard.indexOf('class="gpu-job-meta"');
const nameAt = singleCard.indexOf('class="gpu-job-name"');
const metricsAt = singleCard.indexOf('class="gpu-metrics"');
assert.ok(gpuAt >= 0 && gpuAt < ownerAt && ownerAt < nameAt && nameAt < metricsAt);
const sharedCard = evaluate(`(() => {
  const node = nodes.find(n => n.id === 'server2'), gpu = node.gpus[2];
  return gpuBlockMarkup(node, {...gpu, jobRecords: [...gpu.jobRecords, ...node.gpus[3].jobRecords]});
})()`);
assert.deepEqual([...sharedCard.matchAll(/data-job="([^"]+)"/g)].map(match => match[1]), ['54901', '54902']);
assert.equal([...sharedCard.matchAll(/>GPU 2<\/span>/g)].length, 1);
assert.equal([...sharedCard.matchAll(/class="gpu-job-name"/g)].length, 2);
assert.match(sharedCard, />Long training job 54901<\/span>/);
assert.match(sharedCard, />Long training job 54902<\/span>/);
assert.ok(sharedCard.lastIndexOf('class="gpu-job-name"') < sharedCard.indexOf('class="gpu-metrics"'));
assert.doesNotMatch(sharedCard, /class="meter/);
evaluate('showJob("54901")');
assert.match(element('#dialog-content').innerHTML, /<dt>Allocated GPU devices<\/dt><dd>Server2 \/ GPU 0, Server2 \/ GPU 2<\/dd>/);
assert.match(element('#dialog-content').innerHTML, /<dt>GPUs with observed processes<\/dt><dd>1 GPU · Server2 \/ GPU 0<\/dd>/);
// A fresh node with a missing map cannot use its display index as a substitute.
evaluate("delete liveState.snapshot.nodes.find(n => n.data.server_name === 'server2').data.gpus[2].slurm_gres_index; normalizeSnapshot(liveState.snapshot);");
assert.doesNotMatch(idleMarkup(), /54901|ryujh/);
assert.match(idleMarkup(), /Allocation unavailable/);
evaluate("liveState.snapshot.nodes.find(n => n.data.server_name === 'server2').data.gpus[2].slurm_gres_index = 2; liveState.snapshot.slurm.receivedAt = Date.now() - FRESHNESS_MS - 1; normalizeSnapshot(liveState.snapshot);");
assert.doesNotMatch(idleMarkup(), /54901|ryujh/);
assert.match(idleMarkup(), /Slurm data stale/);
// Ending a job clears its allocation on the next snapshot, even if an older
// node report still contains process information for that job.
evaluate("liveState.snapshot.slurm.receivedAt = Date.now(); liveState.snapshot.slurm.data.squeue = liveState.snapshot.slurm.data.squeue.filter(j => j.job_id !== '54901'); normalizeSnapshot(liveState.snapshot);");
assert.doesNotMatch(idleMarkup(), /54901|ryujh/);
assert.match(idleMarkup(), /No allocation reported/);

// FULL describes all verified device reservations, independently of measured
// utilization and node CPU state. Keep the underlying Slurm state untouched.
const fullQueue = [job(61000, 'mindw', 'server2', 'RUNNING', {req_gpus: '4', alloc_gpus: '4',
  gpu_allocations: [{node: 'server2', gres_indices: [0, 1, 2, 3]}]})];
const renderFullNode = (code = '') => {
  evaluate('liveState.error = null');
  report(fullQueue, ['server2']);
  evaluate(`liveState.snapshot.nodes[0].data.gpus =
    [2, 3, 0, 1].map((gres, id) => ({id, slurm_gres_index: gres,
      gpu_utilization: 0, vram_total_mb: 49152, vram_total_used_mb: 4, processes: []}));
    ${code}; normalizeSnapshot(liveState.snapshot); renderNodes();`);
};
const renderedBadge = () => {
  const match = element('#node-grid').innerHTML.match(/<span class="state-badge badge ([^"]*)"[^>]*>([^<]*)<\/span>/);
  assert.ok(match, 'Node state badge must render');
  return {classes: match[1], label: match[2]};
};
renderFullNode();
assert.equal(renderedBadge().label, 'FULL');
assert.match(renderedBadge().classes, /badge-full/);
assert.match(element('#node-grid').innerHTML, /All 4 GPUs allocated by Slurm · Node state: MIXED/);
assert.equal(evaluate('nodes[0].state'), 'MIXED');
assert.deepEqual(plain(evaluate('nodes[0].gpus.map(g => g.util)')), [0, 0, 0, 0]);
assert.deepEqual(plain(evaluate('nodes[0].gpus.map(g => g.processes.length)')), [0, 0, 0, 0]);
assert.match(element('#node-grid').innerHTML, /민동욱\(mindw\)/);

// Missing activity metrics do not erase a fresh, verified allocation.
renderFullNode('liveState.snapshot.nodes[0].data.gpus.forEach(g => {g.gpu_utilization = null; g.vram_total_used_mb = null;})');
assert.equal(renderedBadge().label, 'FULL');

for (const [reason, code] of [
  ['one free GPU', 'liveState.snapshot.slurm.data.squeue[0].gpu_allocations[0].gres_indices = [0, 1, 2]'],
  ['process activity alone', `liveState.snapshot.slurm.data.squeue[0].gpu_allocations = [];
    liveState.snapshot.nodes[0].data.gpus.forEach(g => {g.gpu_utilization = 100; g.vram_total_used_mb = 49152; g.processes = [{pid: g.id + 1, slurm_job_id: '61000', username: 'mindw'}];})`],
  ['duplicate device map', 'liveState.snapshot.nodes[0].data.gpus[1].slurm_gres_index = 2'],
  ['missing device map', 'delete liveState.snapshot.nodes[0].data.gpus[1].slurm_gres_index'],
  ['negative device map', 'liveState.snapshot.nodes[0].data.gpus[1].slurm_gres_index = -1'],
  ['noninteger device map', 'liveState.snapshot.nodes[0].data.gpus[1].slurm_gres_index = 1.5'],
  ['string device map', 'liveState.snapshot.nodes[0].data.gpus[1].slurm_gres_index = "3"'],
  ['no GPU devices', 'liveState.snapshot.nodes[0].data.gpus = []'],
  ['missing node report', 'liveState.snapshot.nodes = []'],
  ['missing Slurm report', 'liveState.snapshot.slurm = null'],
  ['stale node report', 'liveState.snapshot.nodes[0].receivedAt = Date.now() - FRESHNESS_MS - 1'],
  ['stale Slurm report', 'liveState.snapshot.slurm.receivedAt = Date.now() - FRESHNESS_MS - 1'],
  ['failed refresh', 'liveState.error = "Request failed"'],
  ['cloud node', 'liveState.snapshot.nodes[0].data.source_type = "cloud"'],
  ['pending job', 'liveState.snapshot.slurm.data.squeue[0].job_state = "PENDING"'],
  ['completed job', 'liveState.snapshot.slurm.data.squeue[0].job_state = "COMPLETED"']
]) {
  renderFullNode(code);
  assert.doesNotMatch(renderedBadge().label, /FULL/, reason);
  assert.doesNotMatch(renderedBadge().classes, /badge-full/, reason);
}
for (const status of ['DOWN', 'MIXED+DRAIN', 'FAIL', 'MAINT', 'UNKNOWN', 'NOT_RESPONDING', 'POWER_DOWN', 'REBOOT', 'FUTURE', 'ALLOCATED*']) {
  renderFullNode(`liveState.snapshot.slurm.data.sinfo[0].state = ${JSON.stringify(status)}`);
  assert.equal(renderedBadge().label, status);
  assert.equal(evaluate('nodes[0].state'), status);
}
evaluate('liveState.error = null');

// Display names do not change account identities, filtering, or job ownership.
element('#reset-job-filters').dispatch('click');
const namedJobs = [job(701, 'mindw', 'devbox'), job(702, 'kimjh', 'server2'),
  job(703, 'phdkimjh', 'server2'), job(704, 'guest-user', 'ubuntu')];
report(namedJobs);
assert.equal(evaluate('Object.keys(userDisplayNames).length'), 28);
assert.equal(evaluate('displayUserName("mindw")'), '민동욱(mindw)');
assert.equal(evaluate('displayUserName("phdkimjh")'), '김정환(phdkimjh)');
for (const unknown of ['guest-user', 'constructor', '__proto__', 'Mindw']) {
  assert.equal(evaluate(`displayUserName(${JSON.stringify(unknown)})`), unknown);
}
assert.match(element('#job-user-filter').innerHTML, /value="mindw">민동욱\(mindw\)<\/option>/);
assert.match(element('#job-rows').innerHTML, /김지호\(kimjh\)/);
assert.match(element('#job-rows').innerHTML, /guest-user/);
for (const search of ['민동욱', 'mindw', '민동욱(mindw)']) assert.deepEqual(apply({search}).visibleJobIds, ['701']);
assert.deepEqual(apply({search: '김정환', server: 'server2'}).visibleJobIds, ['703']);
assert.deepEqual(apply({search: '', server: '', user: 'mindw'}).visibleJobIds, ['701']);
assert.equal(evaluate('state.user'), 'mindw');
assert.deepEqual(plain(evaluate('jobs.map(j => j.user)')), ['mindw', 'kimjh', 'phdkimjh', 'guest-user']);
evaluate('showJob("703")');
assert.match(element('#dialog-content').innerHTML, /김정환\(phdkimjh\)/);
report([job(704, 'guest-user', 'ubuntu')]);
assert.match(element('#job-user-filter').innerHTML, /value="mindw">민동욱\(mindw\) · No current jobs/);
element('#reset-job-filters').dispatch('click');

// The demo renderer has the same seven-column, ten-row pagination contract.
evaluate('liveState.mode = "demo"; nodes = demoData.nodes; jobs = demoData.jobs; partitionMeta = demoData.partitions; renderJobs();');
assert.equal((element('#job-rows').innerHTML.match(/<td(?:\s|>)/g) || []).length, 10 * 7);
assert.doesNotMatch(element('#job-rows').innerHTML, /partition-chip/);
element('#next-page').onclick();
assert.equal(visibleIds().length, 2);
assert.equal(element('#page-number').textContent, '2 / 2');
assert.equal(element('#next-page').disabled, true);
console.log('Slurm job filter tests passed: exact hostlists, pending semantics, combined filters, pagination, refresh retention, reset, counts, escaping, seven columns, and verified all-device FULL badge semantics.');
