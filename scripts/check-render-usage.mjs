import https from 'node:https';
import {brotliDecompressSync, gunzipSync} from 'node:zlib';

// Read-only capacity estimate from the actual encoded response body. This does
// not access Render billing or count HTTP/TLS headers, assets, or collector ACKs.
const url = new URL('/api/snapshot', process.argv[2] || 'https://temp-status.onrender.com');
const viewers = Number(process.argv[3] || 25);
if (url.protocol !== 'https:' || url.username || url.password
  || !Number.isInteger(viewers) || viewers < 1 || viewers > 10000) {
  throw new Error('Usage: node scripts/check-render-usage.mjs [https://site] [viewers]');
}

const {status, encoding, bytes} = await new Promise((resolve, reject) => {
  const request = https.get(url, {headers: {'Accept-Encoding': 'br, gzip'}}, response => {
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        response.destroy(new Error('Snapshot exceeded the measurement limit.'));
      } else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => resolve({status: response.statusCode,
      encoding: response.headers['content-encoding'] || 'identity', bytes: Buffer.concat(chunks)}));
  });
  request.setTimeout(20000, () => request.destroy(new Error('Snapshot request timed out.')));
  request.on('error', reject);
});
if (status !== 200) throw new Error(`Snapshot returned HTTP ${status}.`);
const decoded = encoding === 'br' ? brotliDecompressSync(bytes)
  : encoding === 'gzip' ? gunzipSync(bytes) : bytes;
const snapshot = JSON.parse(decoded);
if (!Array.isArray(snapshot.nodes)) throw new Error('Invalid snapshot response.');
const monthlyGB = (hours, interval) => Number((bytes.length * viewers * hours * 3600 / interval * 30 / 1e9).toFixed(3));
console.log(JSON.stringify({
  site: url.origin, measuredAt: new Date().toISOString(), encoding,
  encodedBodyBytes: bytes.length, decodedBodyBytes: decoded.length,
  reportingNodes: snapshot.nodes.length,
  gpuCount: snapshot.nodes.reduce((sum, node) => sum + node.data.gpus.length, 0),
  slurmJobs: snapshot.slurm?.data.squeue.length ?? null,
  assumptions: {viewers, days: 30, refreshSeconds: 120, constantPayloadSize: true},
  snapshotBodyGBPerMonth: {eightHoursPerDay: monthlyGB(8, 120), allDay: monthlyGB(24, 120)},
  previous30SecondPollingGBAllDay: monthlyGB(24, 30),
  billingUsageChecked: false,
  note: 'Estimate only. Add HTTP overhead, collector responses, assets, manual refreshes, bots, and other workspace services. Check Render Billing for actual usage.'
}, null, 2));
