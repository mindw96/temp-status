import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/gpu-jobs.js', import.meta.url), 'utf8');
const resolveGpuJobs = vm.runInNewContext(`${source}\nresolveGpuJobs;`);
const job = (id, name = `Job ${id}`, aliases = [], state = 'RUNNING') =>
  ({id, name, state, raw: {job_id_aliases: aliases}});
const plain = value => JSON.parse(JSON.stringify(value));

assert.deepEqual(plain(resolveGpuJobs([], [job('1')])), []);
assert.deepEqual(plain(resolveGpuJobs(null, null)), []);

// Preserve array suffixes, and use the exact collected alias when needed.
const arrayJob = job('123_4', 'Array task four', ['127']);
let rows = resolveGpuJobs([{pid: 1, slurm_job_id: '127'}], [job('123', 'Parent'), arrayJob]);
assert.equal(rows.length, 1);
assert.equal(rows[0].jobId, '123_4');
assert.equal(rows[0].job, arrayJob);
assert.equal(rows[0].name, 'Array task four');
rows = resolveGpuJobs([{pid: 1, slurm_job_id: '123_5'}], [arrayJob, job('123')]);
assert.equal(rows[0].jobId, '123_5');
assert.equal(rows[0].job, null);

// Slurm unique IDs are opaque strings, including values beyond JS integer range.
const sluid = '18446744073709551615';
const sluidJob = job('288', 'SLUID match', [sluid]);
rows = resolveGpuJobs([{pid: 2, slurm_job_ids: [sluid]}], [sluidJob]);
assert.equal(rows[0].job, sluidJob);
assert.equal(resolveGpuJobs([{slurm_job_id: sluid.slice(0, -1) + '4'}], [sluidJob])[0].job, null);

// Several processes for the same job produce one label; duplicate PIDs do not
// inflate the count, and separate jobs on one GPU remain separate records.
rows = resolveGpuJobs([
  {pid: 10, slurm_job_id: '1'}, {pid: 11, slurm_job_id: '1'},
  {pid: 10, slurm_job_id: '1'}, {pid: 12, slurm_job_id: '2'}
], [job('1'), job('2')]);
assert.deepEqual(plain(rows.map(({jobId, processCount}) => ({jobId, processCount}))), [
  {jobId: '1', processCount: 2}, {jobId: '2', processCount: 1}
]);

// Unknown IDs and process-provided names survive without a speculative match.
rows = resolveGpuJobs([
  {pid: 20, slurm_job_id: 'missing'},
  {pid: 21, slurm_job_id: 'missing', slurm_job_name: 'Reported name'},
  {pid: 22, slurm_job_ids: ['alternate', 'also-alternate'], slurm_job_name: 'Fallback'}
], []);
assert.deepEqual(plain(rows), [
  {jobId: 'missing', name: 'Reported name', job: null, processCount: 2, users: []},
  {jobId: 'alternate', name: 'Fallback', job: null, processCount: 1, users: []}
]);
assert.deepEqual(plain(resolveGpuJobs([
  {pid: 30, username: 'same-user', slurm_job_name: 'Do not infer this job'},
  {pid: 31, gpu_index: '0', node: 'devbox'}
], [{...job('1'), user: 'same-user', target: 'devbox', raw: {gpu_index: '0'}}])), [
  {jobId: null, name: null, job: null, processCount: 2, users: ['same-user']}
]);

// Aliases that collide cannot choose a job arbitrarily.
rows = resolveGpuJobs([{slurm_job_id: 'shared', slurm_job_name: 'Process fallback'}], [
  job('10', 'First', ['shared']), job('20', 'Second', ['shared'])
]);
assert.equal(rows[0].job, null);
assert.equal(rows[0].jobId, 'shared');
assert.equal(rows[0].name, 'Process fallback');

// The primary canonical ID beats another canonical alternate or shared alias.
const primaryJob = job('10', 'Primary', ['shared']);
rows = resolveGpuJobs([{slurm_job_id: '10', slurm_job_ids: ['20', 'shared']}], [
  primaryJob, job('20', 'Alternate', ['shared'])
]);
assert.equal(rows[0].job, primaryJob);
const alternateJob = job('20');
assert.equal(resolveGpuJobs([{slurm_job_id: 'opaque', slurm_job_ids: ['20']}], [
  alternateJob, job('30', 'Alias candidate', ['opaque'])
])[0].job, alternateJob);
assert.equal(resolveGpuJobs([{slurm_job_ids: ['10', '20', 'unique-alias']}], [
  primaryJob, alternateJob, job('30', 'Third', ['unique-alias'])
])[0].job, null);

// Pending and terminal jobs cannot become current GPU-process associations.
for (const state of ['PENDING', 'PD', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'CD', 'F', 'CA', 'TO']) {
  assert.equal(resolveGpuJobs([{slurm_job_id: '10'}], [job('10', 'Inactive', [], state)])[0].job, null, state);
}
for (const state of ['RUNNING', 'COMPLETING', 'SUSPENDED', 'CONFIGURING', 'R', 'CG', 'S', 'CF']) {
  const activeJob = job('10', 'Active', [], state);
  assert.equal(resolveGpuJobs([{slurm_job_id: '10'}], [activeJob])[0].job, activeJob, state);
}

// Identity matching is literal, with no integer conversion or whitespace repair.
assert.equal(resolveGpuJobs([{slurm_job_id: '001'}], [job('1')])[0].job, null);
assert.equal(resolveGpuJobs([{slurm_job_id: ' 1'}], [job('1')])[0].job, null);
assert.equal(resolveGpuJobs([{slurm_job_id: 1}], [job('1')])[0].jobId, null);

// This helper returns data, not HTML, and must never mutate either input.
const hostileName = '<img src=x onerror=alert(1)> & "name"';
const safeJob = Object.freeze({...job('99', hostileName), raw: Object.freeze({job_id_aliases: Object.freeze([])})});
const processes = Object.freeze([Object.freeze({pid: 99, slurm_job_id: '99', slurm_job_ids: Object.freeze([])})]);
rows = resolveGpuJobs(processes, Object.freeze([safeJob]));
assert.equal(rows[0].name, hostileName);
assert.equal(resolveGpuJobs([{slurm_job_id: 'unknown', slurm_job_name: hostileName}], [])[0].name, hostileName);
assert.equal(resolveGpuJobs([{slurm_job_id: '1', slurm_job_name: 'Fallback'}], [job('1', '')])[0].name, 'Fallback');
const unnamedQueueJob = {...job('1', 'Unnamed job'), raw: {name: '', job_id_aliases: []}};
assert.equal(resolveGpuJobs([{slurm_job_id: '1', slurm_job_name: 'Actual training job'}], [unnamedQueueJob])[0].name, 'Actual training job');
assert.equal(resolveGpuJobs([{slurm_job_id: '1'}], [unnamedQueueJob])[0].name, null);

// A matched queue owner is authoritative even if GPU processes use another
// account; a display placeholder must not obscure real process usernames.
const ownedJob = {...job('1'), user: 'normalized-owner', raw: {user: 'queue-owner', job_id_aliases: []}};
rows = resolveGpuJobs([
  {pid: 1, slurm_job_id: '1', username: 'root'},
  {pid: 2, slurm_job_id: '1', username: 'process-user'}
], [ownedJob]);
assert.deepEqual(plain(rows[0].users), ['queue-owner']);
const normalizedOwnerJob = {...job('1'), user: 'known-owner'};
assert.deepEqual(plain(resolveGpuJobs([{slurm_job_id: '1', username: 'root'}], [normalizedOwnerJob])[0].users), ['known-owner']);
const ownerlessJob = {...job('1'), user: 'Unknown', raw: {user: '', job_id_aliases: []}};
rows = resolveGpuJobs([
  {pid: 1, slurm_job_id: '1', username: 'alice'},
  {pid: 2, slurm_job_id: '1', username: 'alice'},
  {pid: 3, slurm_job_id: '1', username: 'bob'}
], [ownerlessJob]);
assert.deepEqual(plain(rows[0].users), ['alice', 'bob']);

// Unmatched jobs and processes without job IDs still retain deduplicated users.
rows = resolveGpuJobs([
  {pid: 1, slurm_job_id: 'unknown', username: 'alice'},
  {pid: 2, slurm_job_id: 'unknown', username: 'alice'},
  {pid: 3, slurm_job_id: 'unknown', username: 'bob'},
  {pid: 4, username: 'charlie'}, {pid: 5, username: 'charlie'},
  {pid: 6, username: 'dana'}
], []);
assert.deepEqual(plain(rows.map(({jobId, users}) => ({jobId, users}))), [
  {jobId: 'unknown', users: ['alice', 'bob']}, {jobId: null, users: ['charlie', 'dana']}
]);
assert.deepEqual(plain(resolveGpuJobs([
  {slurm_job_id: '1'}, {slurm_job_id: '1', username: null},
  {slurm_job_id: '1', username: ''}, {slurm_job_id: '1', username: '   '},
  {slurm_job_id: '1', username: {invalid: 'username'}}
], [ownerlessJob])[0].users), []);

// Usernames are data, not HTML, and stay literal for the renderer to escape.
const hostileUser = '<img src=x onerror=alert(1)> & "user"';
assert.deepEqual(plain(resolveGpuJobs([{username: hostileUser}], [])[0].users), [hostileUser]);
const frozenOwnerJob = Object.freeze({...job('1'), raw: Object.freeze({user: hostileUser, job_id_aliases: Object.freeze([])})});
const frozenProcesses = Object.freeze([Object.freeze({pid: 1, slurm_job_id: '1', username: 'root'})]);
assert.deepEqual(plain(resolveGpuJobs(frozenProcesses, Object.freeze([frozenOwnerJob]))[0].users), [hostileUser]);

console.log('PASS: exact GPU job identities, array aliases, SLUIDs, precedence, ambiguity, process deduplication, active states, queue-owner preference, fallback users, literal names, and immutable inputs.');
