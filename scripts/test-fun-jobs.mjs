import assert from 'node:assert/strict';
import {once} from 'node:events';
import {funJobPattern, normalizeFunJobs, funJobsSnapshot} from '../src/fun-jobs.js';
import {createRenderServer} from './render-server.mjs';
import worker from '../dist/server/index.js';
import {localDB} from './local-db.mjs';

for (const id of ['1111', '2222', '3333', '55555', '9999999999']) assert.equal(funJobPattern(id), 'repeat');
for (const id of ['1234', '12345', '6789', '123456789']) assert.equal(funJobPattern(id), 'ascending');
for (const id of ['4321', '54321', '43210', '9876543210']) assert.equal(funJobPattern(id), 'descending');
for (const id of ['1000', '2000', '9000', '10000', '20000', '1000000000', '9000000000']) assert.equal(funJobPattern(id), 'round');
// Symmetric numbers and repeating blocks are excluded unless they already
// satisfy the original all-identical-digits rule.
for (const id of ['1221', '12321', '10001', '121121', '1234554321', '22622', '30003',
  '1212', '123123', '202020', '121212', '1234512345',
  '111', '100', '12000', '20001', '12312', '112233', '7890', '01234', '0000', '12345_7',
  '12345_[1-20]', '12345+0', ' 1111', '1111\n', '11111111111', 1111, null, {}, '１２３４']) {
  assert.equal(funJobPattern(id), null, String(id));
}
const started = '2026-10-20T00:00:00.000Z';
const archive = {version: 1, status: 'ok', started_at: started, records: [
  {job_id: '1111', name: 'first recorded job', user: 'mindw', pattern: 'repeat', first_seen_at: started},
  {job_id: '12345', name: '<img src=x onerror=alert(1)>', user: 'kimjh', pattern: 'ascending', first_seen_at: '2026-10-20T00:00:01.123456Z'}
]};
const clean = normalizeFunJobs(archive);
assert.deepEqual(clean.records.map(j => j.job_id), ['12345', '1111']);
assert.equal(clean.records[0].first_seen_at, '2026-10-20T00:00:01.123Z');
assert.equal(Object.hasOwn(clean.records[0], 'source'), false);
assert.equal(Object.hasOwn(clean.records[0], 'submitted_at'), false);
const historicalRecord = {job_id: '2222', name: 'old matching job', user: 'mindw',
  pattern: 'repeat', first_seen_at: '2026-10-20T00:00:02.000Z',
  source: 'sacct', submitted_at: '2025-09-17T10:14:25.123456Z'};
const expandedRecords = ['1000', '10000', '20000'].map(job_id => ({
  job_id, name: `pattern test ${job_id}`, user: 'mindw', pattern: funJobPattern(job_id),
  first_seen_at: started, source: 'sacct', submitted_at: '2025-09-01T00:00:00.000Z'
}));
const historicalArchive = {...archive, records: [...archive.records, historicalRecord, ...expandedRecords]};
const historicalClean = normalizeFunJobs(historicalArchive);
assert.deepEqual(historicalClean.records.find(item => item.job_id === historicalRecord.job_id),
  {...historicalRecord, submitted_at: '2025-09-17T10:14:25.123Z'});
assert.deepEqual(historicalClean.records.map(item => item.job_id),
  ['20000', '12345', '10000', '2222', '1111', '1000']);
for (const record of expandedRecords) assert.deepEqual(historicalClean.records.find(item => item.job_id === record.job_id), record);
assert.equal(historicalClean.started_at, started);
// Four-digit IDs must follow larger five-digit IDs even when discovered later.
const requestedIDs = ['1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '11111', '22222', '33333', '44444', '55555', '66666', '12345'];
const requestedArchive = {...archive, records: requestedIDs.map((job_id, index) => ({
  job_id, name: 'sorting regression', user: 'mindw', pattern: funJobPattern(job_id),
  first_seen_at: new Date(Date.parse(started) + (requestedIDs.length - index) * 1000).toISOString()
}))};
assert.deepEqual(normalizeFunJobs(requestedArchive).records.map(item => item.job_id), [
  '66666', '55555', '44444', '33333', '22222', '12345', '11111',
  '9999', '8888', '7777', '6666', '5555', '4444', '3333', '2222', '1111'
]);
assert.equal(normalizeFunJobs({...archive, records: [{
  ...historicalRecord, submitted_at: historicalRecord.first_seen_at
}]}).status, 'ok');
assert.equal(normalizeFunJobs(undefined), null);
for (const invalid of [
  [], {}, {...archive, version: 2}, {...archive, records: [...archive.records, archive.records[0]]},
  {...archive, records: Array(1001).fill(archive.records[0])},
  {...archive, started_at: '2026-02-31T00:00:00Z'},
  {...archive, records: [{...archive.records[0], first_seen_at: '2026-10-19T00:00:00Z'}]},
  ...[
    {source: 'sacct'}, {submitted_at: historicalRecord.submitted_at},
    {source: null, submitted_at: historicalRecord.submitted_at},
    {source: 'squeue', submitted_at: historicalRecord.submitted_at},
    {source: 'sacct', submitted_at: null},
    {source: 'sacct', submitted_at: '2026-10-21T00:00:00Z'},
    {source: 'sacct', submitted_at: '2025-02-30T00:00:00Z'},
    {source: 'sacct', submitted_at: '1969-12-31T23:59:59Z'},
    {source: 'sacct', submitted_at: '2025-09-17T10:14:25+09:00'},
    {source: 'sacct', submitted_at: ' 2025-09-17T10:14:25Z'},
  ].map(fields => ({...archive, records: [{...archive.records[0], ...fields}]})),
  ...[{pattern: 'descending'}, {user: 'x'.repeat(81)}, {name: 'x'.repeat(501)},
    {job_id: '22622', pattern: 'palindrome'}, {job_id: '1212', pattern: 'repeating'},
    {job_id: '1111_0'}, {first_seen_at: '2026-13-01T00:00:00Z'}]
    .map(fields => ({...archive, records: [{...archive.records[0], ...fields}]}))
]) assert.equal(normalizeFunJobs(invalid).status, 'unavailable');
assert.equal(normalizeFunJobs({...archive, status: 'unavailable'}).records.length, 2);
assert.equal(normalizeFunJobs({...archive, status: 'full'}).status, 'full');
// Python's character bounds count code points; emoji names must not invalidate
// a successfully persisted archive when JavaScript validates its copy.
assert.equal(normalizeFunJobs({...archive, records: [{...archive.records[0], name: '🚀'.repeat(500)}]}).status, 'ok');
assert.equal(funJobsSnapshot({payload: JSON.stringify({fun_jobs: archive}), received_at: 1000}, 181001).stale, true);

const storage = localDB();
try {
  const request = (path, method = 'GET') => new Request('https://local.test' + path, {method});
  const env = {DB: storage, STATUS_REPORT_TOKEN: 'test-only'};
  assert.equal((await worker.fetch(request('/api/fun-jobs'), env, {})).status, 401);
  assert.equal((await worker.fetch(request('/api/fun-jobs'), {...env, SNAPSHOT_AUTH_MODE: 'invalid'}, {})).status, 503);
  assert.equal((await worker.fetch(request('/api/fun-jobs', 'POST'), {...env, SNAPSHOT_AUTH_MODE: 'public'}, {})).status, 405);
} finally { storage.raw.close(); }

async function listen() {
  const server = createRenderServer({reportToken: 'fun-jobs-test-only'});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
async function close(server) {
  const closed = once(server, 'close');
  server.close(); server.closeAllConnections();
  await closed;
}
let server = await listen();
try {
  const url = () => `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(url() + path);
  const post = (report, token = 'fun-jobs-test-only') => fetch(url() + '/api/report/slurm', {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Status-Token': token},
    body: JSON.stringify(report)
  });
  const report = {sinfo: [], squeue: [{job_id: '1111', name: 'first recorded job', user: 'mindw'}], fun_jobs: historicalArchive};
  assert.equal((await (await get('/api/fun-jobs')).json()).archive, null);
  assert.equal((await post(report, 'wrong')).status, 401);
  assert.equal((await post(report)).status, 200);
  let response = await get('/api/fun-jobs');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  let data = await response.json();
  assert.deepEqual(data.archive, historicalClean);
  assert.equal(data.stale, false);
  const mainSnapshot = await (await get('/api/snapshot')).json();
  assert.equal(mainSnapshot.slurm.data.squeue[0].job_id, '1111');
  assert.equal(Object.hasOwn(mainSnapshot.slurm.data, 'fun_jobs'), false);
  // Finishing a job changes the queue, but does not delete its collector record.
  assert.equal((await post({...report, squeue: []})).status, 200);
  assert.deepEqual((await (await get('/api/fun-jobs')).json()).archive, historicalClean);
  // Corrupt optional history never takes the primary monitoring endpoint down.
  assert.equal((await post({...report, fun_jobs: {records: 'invalid'}})).status, 200);
  assert.equal((await (await get('/api/fun-jobs')).json()).archive.status, 'unavailable');
  assert.equal((await (await get('/api/snapshot')).json()).slurm.data.squeue.length, 1);
  for (const path of ['/fun-jobs.js', '/fun-jobs.css']) {
    const asset = await get(path);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /must-revalidate/);
    assert.ok(asset.headers.get('etag'));
  }
  await close(server);
  server = await listen();
  assert.equal((await (await get('/api/fun-jobs')).json()).archive, null);
  // A new process receives the durable collector archive without needing the
  // original job to still be running, matching the Render restart path.
  assert.equal((await post({...report, squeue: []})).status, 200);
  assert.deepEqual((await (await get('/api/fun-jobs')).json()).archive, historicalClean);
} finally { await close(server); }
console.log('PASS: four pattern categories, excluded symmetric numbers and repeating blocks, live/history archive validation, preserved import provenance and submission times, read/write access, optional failure isolation, no normal snapshot growth, static assets, finished-job retention and restart rehydration.');
