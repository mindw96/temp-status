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
assert.deepEqual(apply({server: 'server2'}).visibleJobIds, ['2', '3']);
assert.equal(element('#total-jobs').textContent, 2);
assert.equal(element('#pending-jobs').textContent, 0);
assert.deepEqual(apply({user: 'alice'}).visibleJobIds, ['2']);
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

// The demo renderer has the same seven-column, ten-row pagination contract.
evaluate('liveState.mode = "demo"; nodes = demoData.nodes; jobs = demoData.jobs; partitionMeta = demoData.partitions; renderJobs();');
assert.equal((element('#job-rows').innerHTML.match(/<td(?:\s|>)/g) || []).length, 10 * 7);
assert.doesNotMatch(element('#job-rows').innerHTML, /partition-chip/);
element('#next-page').onclick();
assert.equal(visibleIds().length, 2);
assert.equal(element('#page-number').textContent, '2 / 2');
assert.equal(element('#next-page').disabled, true);
console.log('Slurm job filter tests passed: exact hostlists, pending semantics, combined filters, pagination, refresh retention, reset, counts, escaping and seven columns.');
