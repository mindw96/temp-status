import assert from 'node:assert/strict';
import {once} from 'node:events';
import worker from '../dist/server/index.js';
import {a100Snapshot, validateA100Report} from '../src/a100.js';
import {localDB} from './local-db.mjs';
import {createRenderServer} from './render-server.mjs';

const token = 'a100-isolated-test-token', mainToken = 'main-isolated-test-token';
const now = new Date().toISOString(), old = new Date(Date.now() - 600000).toISOString();
const report = {
  schema_version: 1, cluster_id: 'a100', collected_at: now, jobs_collected_at: now, errors: [],
  quota: {gpu_used: 1, gpu_limit: 8, collected_at: now, error: null},
  storage: {used_bytes: 4096, limit_bytes: 5 * 1024 ** 4, collected_at: now, error: null},
  jobs: [{id: 'job-uid-1', name: 'test-training', owner: 'mindw', status: 'Running', reason: '',
    requested_gpus: 1, cpu_requested: 0.5, ram_requested_bytes: 64 * 1024 ** 3,
    created_at: now, started_at: now, finished_at: null, node: 'hawk04',
    pods: [{name: 'test-training-pod', phase: 'Running', restarts: 0}],
    gpus: [{uuid: 'GPU-uuid-1', name: 'A100-SXM4-80GB', utilization_pct: 99,
      memory_used_mib: 60000, memory_total_mib: 81920, collected_at: now,
      pod: 'test-training-pod', container: 'main'}], metrics_error: null}]
};
const DB = localDB(), env = {DB, STATUS_REPORT_TOKEN: mainToken, A100_REPORT_TOKEN: token, SNAPSHOT_AUTH_MODE: 'public'};
const call = (path, {method = 'GET', body, auth, environment = env, headers = {}} = {}) => worker.fetch(
  new Request('https://local.test' + path, {method,
    headers: {...headers, ...(auth ? {'X-Status-Token': auth} : {}), ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})}), environment, {});
const post = (body = report, auth = token, environment = env) => call('/api/a100/report', {method: 'POST', body, auth, environment});
const snapshot = async () => (await call('/api/a100/snapshot')).json();

try {
  const empty = await snapshot();
  assert.equal(empty.report, null); assert.equal(empty.received_at, null);
  assert.equal(empty.stale, true); assert.equal(empty.reporting_enabled, true);
  assert.equal(empty.stale_after_seconds, 180);
  assert.equal((await call('/api/a100/report')).status, 405);
  assert.equal((await call('/api/a100/snapshot', {method: 'POST', body: {}})).status, 405);
  assert.equal((await call('/api/a100/snapshot', {method: 'HEAD'})).status, 405);
  assert.equal((await call('/api/a100/missing')).status, 404);
  for (const auth of [null, '', 'wrong', mainToken]) assert.equal((await post(report, auth)).status, 401);
  for (const a100Token of [undefined, '', '  ', mainToken, 'a'.repeat(1025)]) {
    const environment = {...env, A100_REPORT_TOKEN: a100Token};
    assert.equal((await post(report, mainToken, environment)).status, 503);
    const response = await call('/api/a100/snapshot', {environment});
    assert.equal(response.status, 200); assert.equal((await response.json()).reporting_enabled, false);
    assert.equal((await call('/api/snapshot', {environment})).status, 200);
  }
  assert.equal((await call('/api/report/node', {method: 'POST', auth: token, body: {server_name: 'not-allowed', gpus: []}})).status, 401);
  for (const path of ['/api/snapshot', '/api/a100/snapshot']) {
    assert.equal((await call(path, {environment: {...env, SNAPSHOT_AUTH_MODE: 'sites'}})).status, 401);
    assert.equal((await call(path, {environment: {...env, SNAPSHOT_AUTH_MODE: 'sites'}, headers: {'oai-authenticated-user-id': 'test'}})).status, 200);
    assert.equal((await call(path, {environment: {...env, SNAPSHOT_AUTH_MODE: 'invalid'}, headers: {'oai-authenticated-user-id': 'test'}})).status, 503);
  }

  await call('/api/report/node', {method: 'POST', auth: mainToken, body: {server_name: 'lab-server', gpus: []}});
  await call('/api/report/slurm', {method: 'POST', auth: mainToken, body: {sinfo: [], squeue: [{job_id: '123', name: 'lab-job'}]}});
  const before = await (await call('/api/snapshot')).json();
  const accepted = await post();
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).ok, true);
  let current = await snapshot();
  assert.deepEqual(current.report, validateA100Report(report)); assert.equal(current.stale, false);
  assert.ok(Date.parse(current.received_at));
  const primary = await (await call('/api/snapshot')).json();
  assert.deepEqual(primary.nodes, before.nodes); assert.deepEqual(primary.slurm, before.slurm);
  assert.deepEqual(primary.history, []);
  assert.equal(JSON.stringify(primary).includes('hawk04'), false);
  assert.equal(JSON.stringify(current).includes('lab-server'), false);
  assert.equal(JSON.stringify(current).includes('lab-job'), false);

  const poisoned = structuredClone(report);
  poisoned.token = token; poisoned.kubeconfig = 'private-kube-config'; poisoned.logs = 'private-log';
  poisoned.errors = ['gpu_metrics_unavailable', 'stderr contains secret-token'];
  poisoned.storage.error = 'command-line secret';
  poisoned.jobs[0].metrics_error = 'Authorization: secret';
  poisoned.jobs[0].reason = 'kubectl failed --token=private';
  poisoned.jobs[0].spec = {env: {TOKEN: 'private-env'}, command: ['private-command']};
  poisoned.jobs[0].gpus[0].processes = [{pid: 1, command: 'private-process'}];
  assert.equal((await post(poisoned)).status, 200);
  current = await snapshot();
  const exposed = JSON.stringify(current);
  for (const value of [token, 'private-', 'secret', 'Authorization', 'kubectl', 'processes', 'command']) assert.equal(exposed.includes(value), false, value);
  assert.deepEqual(current.report.errors, ['gpu_metrics_unavailable', 'collection_failed']);
  assert.equal(current.report.storage.error, 'collection_failed');
  assert.equal(current.report.jobs[0].metrics_error, 'collection_failed');
  assert.equal(current.report.jobs[0].reason, '');

  // Known zero activity is different from failed collection or missing metrics.
  for (const value of [0, undefined, null, '0', false, {}, [], -1, 101, Infinity, NaN]) {
    const probe = structuredClone(report);
    probe.jobs[0].gpus[0].utilization_pct = value;
    probe.jobs[0].gpus[0].memory_used_mib = value === 101 ? -1 : value;
    probe.quota.gpu_used = value === 101 ? -1 : value;
    probe.storage.used_bytes = value === 101 ? -1 : value;
    assert.equal((await post(probe)).status, 200);
    const normalized = (await snapshot()).report;
    assert.equal(normalized.jobs[0].gpus[0].utilization_pct, value === 0 ? 0 : null);
    assert.equal(normalized.jobs[0].gpus[0].memory_used_mib, value === 0 ? 0 : null);
    assert.equal(normalized.quota.gpu_used, value === 0 ? 0 : null);
    assert.equal(normalized.storage.used_bytes, value === 0 ? 0 : null);
  }
  const failure = {...report, jobs_collected_at: old, quota: null, storage: {error: 'storage_unavailable'}, jobs: [], errors: ['jobs_unavailable']};
  assert.equal((await post(failure)).status, 200);
  current = await snapshot();
  assert.equal(current.report.jobs_collected_at, old); assert.equal(current.report.quota.gpu_used, null);
  assert.equal(current.report.storage.used_bytes, null); assert.deepEqual(current.report.jobs, []);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS count FROM reports WHERE key LIKE 'a100:%'").get().count, 1);

  for (const invalid of [null, [], {}, {...report, schema_version: 2}, {...report, cluster_id: 'node:lab-server'},
    {...report, collected_at: null}, {...report, collected_at: 'not-a-date'},
    {...report, collected_at: new Date(Date.now() + 600000).toISOString()},
    {...report, jobs: {}}, {...report, jobs: Array(501).fill(report.jobs[0])},
    {...report, jobs: [report.jobs[0], report.jobs[0]]},
    {...report, jobs: [{...report.jobs[0], pods: Array(65).fill(report.jobs[0].pods[0])}]},
    {...report, jobs: [{...report.jobs[0], gpus: [report.jobs[0].gpus[0], report.jobs[0].gpus[0]]}]},
    {...report, errors: Array(33).fill('jobs_unavailable')}
  ]) assert.equal((await post(invalid)).status, 400);
  assert.equal((await post('{bad json')).status, 400);
  const oversized = await call('/api/a100/report', {method: 'POST', auth: token, body: '{}', headers: {'Content-Length': String(1024 * 1024 + 1)}});
  assert.equal(oversized.status, 413);
  assert.equal((await post(' '.repeat(1024 * 1024 + 1))).status, 413);
  assert.deepEqual((await snapshot()).report, validateA100Report(failure));

  assert.equal(a100Snapshot({payload: JSON.stringify({...report, collected_at: old}), received_at: Date.now()}).stale, true);
  assert.equal(a100Snapshot({payload: JSON.stringify(report), received_at: Date.now() - 600000}).stale, true);
  const unavailable = {...env, DB: {prepare() {throw new Error('private storage failure');}}};
  assert.equal((await post(report, token, unavailable)).status, 503);
  assert.deepEqual(await (await call('/api/a100/snapshot', {environment: unavailable})).json(), {error: 'storage_unavailable'});
  // A malformed isolated record cannot break the main dashboard snapshot.
  DB.raw.prepare('UPDATE reports SET payload=? WHERE key=?').run('not json', 'a100:cluster');
  assert.equal((await call('/api/snapshot')).status, 200);
} finally {DB.raw.close();}

async function close(server) {
  const pending = once(server, 'close'); server.close(); server.closeAllConnections(); await pending;
}
async function listen(a100ReportToken) {
  const server = createRenderServer({reportToken: mainToken, a100ReportToken});
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server;
}
let server = await listen(token + '\n');
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const postHTTP = (auth, body) => fetch(base + '/api/a100/report', {method: 'POST', headers: {'X-Status-Token': auth, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  assert.equal((await postHTTP(mainToken, report)).status, 401);
  assert.equal((await postHTTP(token, report)).status, 200);
  const served = await fetch(base + '/api/a100/snapshot');
  assert.match(served.headers.get('cache-control'), /no-store/);
  assert.equal(served.headers.get('etag'), null);
  assert.equal((await served.json()).report.jobs[0].id, 'job-uid-1');
  const etags = [];
  for (const path of ['/a100', '/a100/', '/a100.html', '/a100.js', '/a100.css']) {
    const response = await fetch(base + path, {headers: {'Accept-Encoding': 'gzip'}});
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('cache-control'), /must-revalidate/);
    const etag = response.headers.get('etag'); assert.ok(etag); etags.push(etag);
    assert.equal((await fetch(base + path, {headers: {'Accept-Encoding': 'gzip', 'If-None-Match': etag}})).status, 304);
    assert.equal((await fetch(base + path, {method: 'HEAD'})).status, 200);
  }
  assert.equal(etags[0], etags[1]); assert.equal(etags[0], etags[2]);
  const oversized = await fetch(base + '/api/a100/report', {method: 'POST', headers: {'X-Status-Token': token}, body: ' '.repeat(1024 * 1024 + 1)});
  assert.equal(oversized.status, 413);
} finally {await close(server);}
server = await listen(undefined);
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
  const response = await (await fetch(base + '/api/a100/snapshot')).json();
  assert.equal(response.report, null); assert.equal(response.reporting_enabled, false);
  assert.equal((await fetch(base + '/api/a100/report', {method: 'POST', body: '{}'})).status, 503);
  assert.equal((await fetch(base + '/api/snapshot')).status, 200);
} finally {await close(server);}
console.log('PASS: A100 separate tokens/storage/read policy, public allowlist, null-vs-zero metrics, source timestamps/staleness, bounded ingestion, API isolation, cached page aliases/assets, and optional-token restart.');
