// A100 data has its own key and token. Only public monitoring fields are kept;
// Kubernetes specs, credentials, logs, annotations and command errors stay local.
export const A100_KEY = 'a100:cluster';
export const A100_MAX_BODY = 1024 * 1024;
export const A100_STALE_SECONDS = 180;
const ERROR_CODES = new Set([
  'quota_unavailable', 'storage_unavailable', 'jobs_unavailable', 'pods_unavailable',
  'gpu_metrics_unavailable', 'collection_timeout', 'collection_failed'
]);
const STATES = new Map(['Running', 'Pending', 'Succeeded', 'Failed', 'Suspended', 'Unknown']
  .map(state => [state.toLowerCase(), state]));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 128) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const numeric = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const integer = (value, max = 65536) => Number.isInteger(value) ? numeric(value, max) : null;
const errorCode = value => value == null || value === '' ? null
  : ERROR_CODES.has(value) ? value : 'collection_failed';
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function list(value, max, label) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
}
function identity(value, label) {
  const clean = string(value);
  if (!clean || typeof value !== 'string' || value.length > 128) throw new Error(`Invalid ${label}`);
  return clean;
}
function reading(value, fields) {
  const source = object(value) ? value : {};
  return {
    ...Object.fromEntries(fields.map(key => [key, numeric(source[key])])),
    collected_at: timestamp(source.collected_at), error: errorCode(source.error)
  };
}

export function validateA100Report(payload) {
  if (!object(payload) || payload.schema_version !== 1 || payload.cluster_id !== 'a100') {
    throw new Error('schema_version 1 and cluster_id a100 are required');
  }
  const collectedAt = timestamp(payload.collected_at);
  if (!collectedAt || Date.parse(collectedAt) > Date.now() + 300000) {
    throw new Error('Valid collected_at is required');
  }
  const ids = new Set();
  const jobs = list(payload.jobs, 500, 'jobs').map(job => {
    if (!object(job)) throw new Error('Invalid job');
    const id = identity(job.id, 'job id');
    if (ids.has(id)) throw new Error('Duplicate job id');
    ids.add(id);
    const pods = list(job.pods ?? [], 64, 'pods').map(pod => {
      if (!object(pod)) throw new Error('Invalid pod');
      return {name: identity(pod.name, 'pod name'), phase: STATES.get(string(pod.phase).toLowerCase()) || 'Unknown',
        restarts: integer(pod.restarts, Number.MAX_SAFE_INTEGER)};
    });
    const gpuIds = new Set();
    const gpus = list(job.gpus ?? [], 64, 'gpus').map(gpu => {
      if (!object(gpu)) throw new Error('Invalid GPU');
      const uuid = identity(gpu.uuid, 'GPU uuid');
      // Multiple Pods can observe the same GPU, but one job must not count it twice.
      if (gpuIds.has(uuid)) throw new Error('Duplicate GPU uuid in job');
      gpuIds.add(uuid);
      return {uuid, name: string(gpu.name, 120), utilization_pct: numeric(gpu.utilization_pct, 100),
        memory_used_mib: numeric(gpu.memory_used_mib, 1e9), memory_total_mib: numeric(gpu.memory_total_mib, 1e9),
        collected_at: timestamp(gpu.collected_at), pod: string(gpu.pod), container: string(gpu.container)};
    });
    return {
      id, name: string(job.name, 250), owner: string(job.owner, 80),
      status: STATES.get(string(job.status).toLowerCase()) || 'Unknown',
      // Kubernetes reason codes are identifiers, never arbitrary event messages.
      reason: typeof job.reason === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(job.reason) ? job.reason : '',
      requested_gpus: integer(job.requested_gpus), cpu_requested: numeric(job.cpu_requested, 1e6),
      ram_requested_bytes: numeric(job.ram_requested_bytes), created_at: timestamp(job.created_at),
      started_at: timestamp(job.started_at), finished_at: timestamp(job.finished_at),
      node: string(job.node), pods, gpus, metrics_error: errorCode(job.metrics_error)
    };
  });
  const quota = reading(payload.quota, ['gpu_used', 'gpu_limit']);
  quota.gpu_used = integer(quota.gpu_used);
  quota.gpu_limit = integer(quota.gpu_limit);
  return {
    schema_version: 1, cluster_id: 'a100', collected_at: collectedAt,
    jobs_collected_at: timestamp(payload.jobs_collected_at),
    errors: [...new Set(list(payload.errors ?? [], 32, 'errors').map(errorCode).filter(Boolean))],
    quota, storage: reading(payload.storage, ['used_bytes', 'limit_bytes']), jobs
  };
}

export function a100Snapshot(row, now = Date.now()) {
  const report = row ? JSON.parse(row.payload) : null;
  const received = typeof row?.received_at === 'number' && Number.isFinite(row.received_at) ? row.received_at : null;
  const collected = report ? Date.parse(report.collected_at) : NaN;
  return {
    server_time: new Date(now).toISOString(),
    received_at: received === null ? null : new Date(received).toISOString(),
    stale: !report || received === null || !Number.isFinite(collected)
      || now - received > A100_STALE_SECONDS * 1000 || now - collected > A100_STALE_SECONDS * 1000,
    stale_after_seconds: A100_STALE_SECONDS, report
  };
}
