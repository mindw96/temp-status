import assert from 'node:assert/strict';
import {once} from 'node:events';
import {normalizeSbatchRankings, sbatchRankingsSnapshot} from '../src/sbatch-rankings.js';
import {createRenderServer} from './render-server.mjs';
import worker from '../dist/server/index.js';
import {localDB} from './local-db.mjs';

const collected = '2026-10-20T04:00:00.000Z', now = Date.parse(collected);
const history = '2026-08-01T00:00:00.000Z';
const period = (start, entries) => ({
  start, total: entries.reduce((sum, entry) => sum + entry.count, 0), users: entries.length, top: entries
});
const summary = {
  version: 1, status: 'ok', timezone: 'Asia/Seoul', collected_at: collected, history_start: history,
  periods: {
    today: period('2026-10-19T15:00:00.000Z', [{user: 'mindw', count: 2}, {user: 'kimjh', count: 2}]),
    week: period('2026-10-18T15:00:00.000Z', [{user: 'mindw', count: 7}, {user: 'kimjh', count: 2}]),
    month: period('2026-09-30T15:00:00.000Z', [{user: 'mindw', count: 10}, {user: 'kimjh', count: 6}]),
    all: {...period(history, [{user: 'zeta', count: 12}, {user: 'alpha', count: 15},
      {user: 'kimjh', count: 20}, {user: 'beta', count: 15}, {user: 'mindw', count: 25}]), total: 90, users: 6}
  }
};
const clean = normalizeSbatchRankings(summary, now);
assert.equal(clean.status, 'ok');
assert.deepEqual(clean.periods.today.top.map(entry => entry.user), ['kimjh', 'mindw']);
assert.deepEqual(clean.periods.all.top, [
  {user: 'mindw', count: 25}, {user: 'kimjh', count: 20}, {user: 'alpha', count: 15},
  {user: 'beta', count: 15}, {user: 'zeta', count: 12}
]);
assert.equal(normalizeSbatchRankings(undefined, now), null);
assert.equal(normalizeSbatchRankings(null, now), null);
assert.deepEqual(normalizeSbatchRankings({...summary, status: 'unavailable'}, now),
  {...clean, status: 'unavailable'});
const missing = {version: 1, status: 'unavailable', timezone: 'Asia/Seoul',
  collected_at: null, history_start: null,
  periods: Object.fromEntries(['today', 'week', 'month', 'all'].map(key => [key,
    {start: null, total: 0, users: 0, top: []}]))};
assert.deepEqual(normalizeSbatchRankings(missing, now), missing);
const zero = {...summary, history_start: null,
  periods: Object.fromEntries(Object.entries(summary.periods).map(([key, value]) => [key,
    {start: key === 'all' ? null : value.start, total: 0, users: 0, top: []}]))};
assert.deepEqual(normalizeSbatchRankings(zero, now), zero);

function changePeriod(key, fields) {
  return {...summary, periods: {...summary.periods, [key]: {...summary.periods[key], ...fields}}};
}
for (const invalid of [
  [], {}, true, {...summary, version: 2}, {...summary, status: 'partial'},
  {...summary, timezone: 'UTC'}, {...summary, periods: []},
  {...summary, collected_at: null}, {...summary, collected_at: '2026-02-30T00:00:00Z'},
  {...summary, collected_at: '2026-10-20T13:00:00+09:00'},
  {...summary, collected_at: '2026-10-20T04:01:01.000Z'},
  {...summary, history_start: '2026-10-20T04:00:01.000Z'},
  {...summary, history_start: null},
  {...summary, periods: {...summary.periods, week: undefined}},
  changePeriod('today', {start: '2026-10-20T00:00:00.000Z'}),
  changePeriod('week', {start: '2026-10-17T15:00:00.000Z'}), // Sunday is not this week's start.
  changePeriod('all', {start: null}),
  changePeriod('today', {total: -1}), changePeriod('today', {total: '4'}),
  changePeriod('today', {total: 4.1}), changePeriod('today', {total: Number.MAX_SAFE_INTEGER + 1}),
  changePeriod('today', {total: 5}), // Both users are present, so their counts must sum exactly.
  changePeriod('today', {users: 1}), changePeriod('today', {users: true}),
  changePeriod('today', {top: [{user: 'mindw', count: 2}, {user: 'mindw', count: 2}]}),
  changePeriod('today', {top: [{user: 'mindw', count: 4}, {user: 'kimjh', count: 1}]}),
  changePeriod('today', {top: []}),
  changePeriod('all', {total: 87}), // The sixth user must have at least one submission.
  changePeriod('all', {top: [...summary.periods.all.top, {user: 'sixth', count: 3}]}),
  changePeriod('all', {top: summary.periods.all.top.slice(0, 4)}),
  ...['', ' mindw', 'mindw ', 'x'.repeat(81), 'line\nbreak', 'nul\0byte', null]
    .map(user => changePeriod('today', {top: [{user, count: 2}, {user: 'kimjh', count: 2}]})),
  ...[0, -1, 2.1, '2', true, null, Number.MAX_SAFE_INTEGER + 1]
    .map(count => changePeriod('today', {top: [{user: 'mindw', count}, {user: 'kimjh', count: 2}]})),
  {...missing, collected_at: collected}, // Cached data needs the original period boundaries.
  {...missing, history_start: history},
  changePeriod('week', {total: 1, users: 1, top: [{user: 'mindw', count: 1}]}),
]) assert.deepEqual(normalizeSbatchRankings(invalid, now), missing, JSON.stringify(invalid));
const extras = structuredClone(summary);
extras.shell_command = 'must not be forwarded';
extras.periods.today.top[0].job_name = 'private job name';
assert.deepEqual(normalizeSbatchRankings(extras, now), clean);

// KST's day/week/month start changes together at this Sunday-to-Monday rollover.
const boundary = {...summary, collected_at: '2026-05-31T15:00:00.000Z', history_start: '2026-01-01T00:00:00.000Z',
  periods: Object.fromEntries(['today', 'week', 'month', 'all'].map(key => [key,
    period(key === 'all' ? '2026-01-01T00:00:00.000Z' : '2026-05-31T15:00:00.000Z',
      [{user: 'one', count: 1}])]))};
assert.equal(normalizeSbatchRankings(boundary, Date.parse(boundary.collected_at)).status, 'ok');
const row = {payload: JSON.stringify({sbatch_rankings: summary}), received_at: now};
assert.equal(sbatchRankingsSnapshot(row, now).stale, false);
assert.equal(sbatchRankingsSnapshot(row, now + 180000).stale, false);
assert.equal(sbatchRankingsSnapshot({...row, received_at: now + 180001}, now + 180001).stale, true);
assert.equal(sbatchRankingsSnapshot({...row, received_at: now - 180001}, now).stale, true);
assert.equal(sbatchRankingsSnapshot({...row, received_at: now + 60001}, now).stale, true);
assert.equal(sbatchRankingsSnapshot({...row, received_at: null}, now).stale, true);
assert.equal(sbatchRankingsSnapshot({...row, payload: JSON.stringify({sbatch_rankings: {...summary, status: 'unavailable'}})}, now).stale, true);
assert.equal(sbatchRankingsSnapshot({...row, payload: '{}'}, now).rankings, null);
assert.equal(sbatchRankingsSnapshot({...row, payload: '{'}, now).rankings.status, 'unavailable');
assert.deepEqual(sbatchRankingsSnapshot(undefined, now), {serverTime: now, receivedAt: null, stale: true, rankings: null});
const beforeMidnight = {...summary, collected_at: '2026-10-20T14:59:59.000Z'};
assert.equal(sbatchRankingsSnapshot({payload: JSON.stringify({sbatch_rankings: beforeMidnight}),
  received_at: Date.parse(beforeMidnight.collected_at)}, Date.parse('2026-10-20T15:00:00Z')).stale, true);

const storage = localDB();
try {
  const request = (method = 'GET', headers = {}) => new Request('https://local.test/api/sbatch-rankings', {method, headers});
  const env = {DB: storage, STATUS_REPORT_TOKEN: 'test-only'};
  assert.equal((await worker.fetch(request(), env, {})).status, 401);
  assert.equal((await worker.fetch(request(), {...env, SNAPSHOT_AUTH_MODE: 'invalid'}, {})).status, 503);
  assert.equal((await worker.fetch(request('POST'), {...env, SNAPSHOT_AUTH_MODE: 'public'}, {})).status, 405);
  assert.equal((await worker.fetch(request('GET', {'oai-authenticated-user-id': 'test'}), env, {})).status, 200);
  assert.equal((await worker.fetch(request(), {...env, SNAPSHOT_AUTH_MODE: 'public', DB: null}, {})).status, 503);
} finally { storage.raw.close(); }

async function listen() {
  const server = createRenderServer({reportToken: 'sbatch-rankings-test-only'});
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
  const post = (report, token = 'sbatch-rankings-test-only') => fetch(url() + '/api/report/slurm', {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Status-Token': token},
    body: JSON.stringify(report)
  });
  const report = {sinfo: [], squeue: [{job_id: '123', user: 'mindw'}], sbatch_rankings: summary};
  let data = await (await get('/api/sbatch-rankings')).json();
  assert.equal(data.rankings, null);
  assert.equal(data.stale, true);
  assert.equal((await post(report, 'wrong')).status, 401);
  assert.equal((await post(report)).status, 200);
  let response = await get('/api/sbatch-rankings');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  data = await response.json();
  assert.deepEqual(data.rankings, clean);
  assert.equal(typeof data.receivedAt, 'number');
  // An empty live queue must not erase accounting counts.
  assert.equal((await post({...report, squeue: []})).status, 200);
  assert.deepEqual((await (await get('/api/sbatch-rankings')).json()).rankings, clean);
  let main = await (await get('/api/snapshot')).json();
  assert.equal(Object.hasOwn(main.slurm.data, 'sbatch_rankings'), false);
  assert.equal((await post({...report, sbatch_rankings: {periods: 'broken'}})).status, 200);
  assert.equal((await (await get('/api/sbatch-rankings')).json()).rankings.status, 'unavailable');
  main = await (await get('/api/snapshot')).json();
  assert.equal(main.slurm.data.squeue[0].job_id, '123');
  assert.equal((await post({...report, sbatch_rankings: {...summary, status: 'unavailable'}})).status, 200);
  data = await (await get('/api/sbatch-rankings')).json();
  assert.deepEqual(data.rankings, {...clean, status: 'unavailable'});
  assert.equal(data.stale, true);
  for (const path of ['/sbatch-rankings.js', '/sbatch-rankings.css']) {
    const asset = await get(path);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /must-revalidate/);
    assert.ok(asset.headers.get('etag'));
  }
  await close(server);
  server = await listen();
  assert.equal((await (await get('/api/sbatch-rankings')).json()).rankings, null);
  assert.equal((await post({...report, squeue: []})).status, 200);
  assert.deepEqual((await (await get('/api/sbatch-rankings')).json()).rankings, clean);
} finally { await close(server); }
console.log('PASS: bounded Top 5 summaries, KST calendar boundaries, deterministic ties, invalid optional data isolation, source/report freshness and rollover, cached unavailable counts, read/write authorization, snapshot size isolation, static assets and restart rehydration.');
