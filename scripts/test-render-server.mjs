import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {gunzipSync, brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createRenderServer} from './render-server.mjs';

const token = 'render-http-test-only';
const cleanEnv = {...process.env};
delete cleanEnv.STATUS_REPORT_TOKEN;
const missing = spawnSync(process.execPath, ['scripts/render-server.mjs'], {env: cleanEnv, encoding: 'utf8', timeout: 5000});
assert.equal(missing.status, 1);
assert.match(missing.stderr, /STATUS_REPORT_TOKEN is required/);
assert.throws(() => createRenderServer({reportToken: '   '}), /STATUS_REPORT_TOKEN/);

async function listen() {
  // Pasting a secret copied from a file can include a trailing newline.
  const server = createRenderServer({reportToken: token + '\n'});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
async function close(server) {
  const closed = once(server, 'close');
  server.close(); server.closeAllConnections();
  await closed;
}
function raw(base, path, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, {method, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
let server = await listen();
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (kind, body, auth = token) => raw(base, '/api/report/' + kind, {
    method: 'POST', headers: {'Content-Type': 'application/json', ...(auth ? {'X-Status-Token': auth} : {})}, body: JSON.stringify(body)
  });
  const getSnapshot = async () => JSON.parse((await raw(base, '/api/snapshot')).body);
  assert.equal((await raw(base, '/healthz')).status, 200);
  let snapshot = await getSnapshot();
  assert.deepEqual(snapshot.nodes, []); assert.equal(snapshot.slurm, null); assert.deepEqual(snapshot.history, []);
  for (const kind of ['node', 'slurm', 'cloud-gpu']) {
    assert.equal((await post(kind, {}, null)).status, 401);
    assert.equal((await post(kind, {}, 'wrong-token')).status, 401);
  }
  const node = {server_name: 'test-node', cpu_percent: 20, gpus: [{id: 0, gpu_name: 'Test GPU', gpu_utilization: 40, vram_total_mb: 81920, vram_total_used_mb: 12288, processes: [{pid: 42, username: 'test-user', slurm_job_id: '123', slurm_job_name: 'test-job'}]}]};
  const slurm = {sinfo: [{name: 'test-node', state: 'mixed'}], squeue: [{job_id: '123', name: 'test-job', user: 'test-user', job_state: 'R'}]};
  const cloud = {server: {name: 'test-cloud', type: 'cloud'}, system: {cpu_count: 8}, gpus: [{index: 0, name: 'Cloud GPU', utilization_gpu: 80, memory_used: 100, memory_total: 81920, processes: []}]};
  assert.equal((await post('node', node)).status, 200);
  assert.equal((await post('slurm', slurm)).status, 200);
  assert.equal((await post('cloud-gpu', cloud)).status, 200);
  node.gpus[0].gpu_utilization = 77;
  assert.equal((await post('node', node)).status, 200);
  snapshot = await getSnapshot();
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.nodes.find(n => n.data.server_name === 'test-node').data.gpus[0].gpu_utilization, 77);
  assert.equal(snapshot.nodes.find(n => n.data.server_name === 'test-cloud').data.source_type, 'cloud');
  assert.equal(snapshot.slurm.data.squeue[0].job_id, '123');
  assert.deepEqual(snapshot.history, []);
  const compressed = await raw(base, '/api/snapshot', {headers: {'Accept-Encoding': 'gzip'}});
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.match(compressed.headers.vary, /Accept-Encoding/);
  assert.equal(JSON.parse(gunzipSync(compressed.body)).nodes.length, 2);
  const plain = await raw(base, '/api/snapshot', {headers: {'Accept-Encoding': 'gzip;q=0'}});
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body).nodes.length, 2);
  const br = await raw(base, '/api/snapshot', {headers: {'Accept-Encoding': 'gzip, br'}});
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(JSON.parse(brotliDecompressSync(br.body)).nodes.length, 2);
  assert.equal(br.headers.etag, undefined);
  assert.equal(br.headers['cache-control'], 'no-store');
  for (const [accept, expected] of [
    ['br;q=0, gzip;q=1', 'gzip'],
    ['br;q=0.2, gzip;q=0.8', 'gzip'],
    ['br;q=1, gzip;q=0.5', 'br'],
    ['br;q=0, gzip;q=0', undefined],
    ['br;q=0.5, identity;q=1', undefined],
    ['identity;q=0, br;q=1', 'br'],
    ['*;q=1, br;q=0', 'gzip'],
    ['br;q=bad, gzip;q=0', undefined],
    ['', undefined]
  ]) {
    const response = await raw(base, '/api/snapshot', {headers: {'Accept-Encoding': accept}});
    assert.equal(response.status, 200, accept);
    assert.equal(response.headers['content-encoding'], expected, accept);
    const decoded = expected === 'br' ? brotliDecompressSync(response.body) : expected === 'gzip' ? gunzipSync(response.body) : response.body;
    assert.equal(JSON.parse(decoded).nodes.length, 2);
  }
  const unacceptable = await raw(base, '/api/snapshot', {headers: {'Accept-Encoding': 'br;q=0, gzip;q=0, identity;q=0'}});
  assert.equal(unacceptable.status, 406);
  const html = await raw(base, '/', {headers: {'Accept-Encoding': 'gzip'}});
  assert.equal(html.status, 200); assert.equal(html.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(html.body).toString(), /Cluster overview/);
  const head = await raw(base, '/', {method: 'HEAD', headers: {'Accept-Encoding': 'gzip'}});
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], 'gzip');
  assert.equal(head.headers['content-length'], undefined);
  const htmlBytes = gunzipSync(html.body);
  assert.equal(html.headers.etag, `"${createHash('sha256').update(html.body).digest('hex')}"`);
  assert.equal(head.headers.etag, html.headers.etag);
  assert.equal(html.headers['cache-control'], 'public, max-age=0, must-revalidate');
  const unchanged = await raw(base, '/', {headers: {'Accept-Encoding': 'gzip', 'If-None-Match': html.headers.etag}});
  assert.equal(unchanged.status, 304); assert.equal(unchanged.body.length, 0);
  assert.equal(unchanged.headers.etag, html.headers.etag);
  assert.match(unchanged.headers.vary, /Accept-Encoding/);
  const weak = await raw(base, '/index.html', {headers: {'Accept-Encoding': 'gzip', 'If-None-Match': `"old-build", W/${html.headers.etag}`}});
  assert.equal(weak.status, 304); assert.equal(weak.body.length, 0);
  const old = await raw(base, '/', {headers: {'Accept-Encoding': 'gzip', 'If-None-Match': '"old-build"'}});
  assert.equal(old.status, 200); assert.deepEqual(old.body, html.body);
  const differentEncoding = await raw(base, '/', {headers: {'Accept-Encoding': 'br', 'If-None-Match': html.headers.etag}});
  assert.equal(differentEncoding.status, 200);
  assert.notEqual(differentEncoding.headers.etag, html.headers.etag);
  assert.deepEqual(brotliDecompressSync(differentEncoding.body), htmlBytes);
  const headNotModified = await raw(base, '/', {method: 'HEAD', headers: {'Accept-Encoding': 'br', 'If-None-Match': differentEncoding.headers.etag}});
  assert.equal(headNotModified.status, 304); assert.equal(headNotModified.body.length, 0);
  for (const path of ['/styles.css', '/app.js', '/gpu-jobs.js', '/live.js']) {
    const asset = await raw(base, path, {headers: {'Accept-Encoding': 'br'}});
    assert.equal(asset.status, 200);
    assert.notEqual(asset.headers.etag, differentEncoding.headers.etag);
    const cached = await raw(base, path + '?unchanged', {headers: {'Accept-Encoding': 'br', 'If-None-Match': asset.headers.etag}});
    assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
  }
  // A static validator must never suppress a report, API response, or error.
  node.gpus[0].gpu_utilization = 91;
  const previousReceivedAt = snapshot.nodes.find(n => n.data.server_name === 'test-node').receivedAt;
  const updated = await raw(base, '/api/report/node', {method: 'POST', headers: {'X-Status-Token': token, 'Content-Type': 'application/json', 'If-None-Match': '*'}, body: JSON.stringify(node)});
  assert.equal(updated.status, 200); assert.equal(updated.headers.etag, undefined);
  const fresh = await raw(base, '/api/snapshot', {headers: {'Accept-Encoding': 'br', 'If-None-Match': '*'}});
  assert.equal(fresh.status, 200); assert.equal(fresh.headers.etag, undefined);
  const freshSnapshot = JSON.parse(brotliDecompressSync(fresh.body));
  const freshNode = freshSnapshot.nodes.find(n => n.data.server_name === 'test-node');
  assert.equal(freshNode.data.gpus[0].gpu_utilization, 91);
  assert.ok(freshNode.receivedAt >= previousReceivedAt);
  assert.ok(freshSnapshot.serverTime >= freshNode.receivedAt);
  const health = await raw(base, '/healthz', {headers: {'If-None-Match': '*'}});
  assert.equal(health.status, 200); assert.equal(health.headers.etag, undefined);
  const missingAsset = await raw(base, '/missing.js', {headers: {'If-None-Match': '*'}});
  assert.equal(missingAsset.status, 404); assert.equal(missingAsset.headers.etag, undefined);

  assert.equal((await raw(base, '/api/missing')).status, 404);
  const oversized = await raw(base, '/api/report/node', {method: 'POST', headers: {'X-Status-Token': token, 'Content-Length': String(8 * 1024 * 1024 + 1)}, body: '{}'});
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).error, 'payload_too_large');
  const streamedOversize = await raw(base, '/api/report/node', {method: 'POST', headers: {'X-Status-Token': token, 'Transfer-Encoding': 'chunked'}, body: Buffer.alloc(8 * 1024 * 1024 + 1, 32)});
  assert.equal(streamedOversize.status, 413);
  assert.equal(JSON.parse(streamedOversize.body).error, 'payload_too_large');
  assert.equal((await getSnapshot()).nodes.length, 2);
  await close(server);
  server = await listen();
  const restarted = JSON.parse((await raw(`http://127.0.0.1:${server.address().port}`, '/api/snapshot')).body);
  assert.deepEqual(restarted.nodes, []); assert.equal(restarted.slurm, null); assert.deepEqual(restarted.history, []);
} finally {await close(server);}
console.log('PASS: required startup secret, HTTP authentication, node/Slurm/cloud reports, latest-only memory storage, Brotli/gzip negotiation, immutable asset ETags/304, live API freshness, HEAD/static assets, bounded uploads, and empty restart.');
