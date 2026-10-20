// The collector owns the durable archive. This module validates its optional
// copy without letting an archive error interrupt ordinary Slurm reporting.
export const FUN_JOB_LIMIT = 1000;
const unavailable = () => ({version: 1, status: 'unavailable', started_at: null, records: []});

export function funJobPattern(id) {
  if (typeof id !== 'string' || id.length < 4 || id.length > 10
    || id[0] === '0' || /[^0-9]/.test(id)) return null;
  if (/^([0-9])\1+$/.test(id)) return 'repeat';
  const digits = [...id].map(Number);
  if (digits.slice(1).every((n, i) => n === digits[i] + 1)) return 'ascending';
  if (digits.slice(1).every((n, i) => n === digits[i] - 1)) return 'descending';
  return null;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.trim() !== value
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < 0) return null;
  const iso = new Date(time).toISOString();
  return iso.slice(0, 19) === value.slice(0, 19) ? iso : null;
}

export function normalizeFunJobs(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || !['ok', 'unavailable', 'full'].includes(value.status)
    || !Array.isArray(value.records) || value.records.length > FUN_JOB_LIMIT) return unavailable();
  const started = timestamp(value.started_at);
  if (!started && (value.status !== 'unavailable' || value.records.length)) return unavailable();
  const records = [], ids = new Set();
  for (const item of value.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return unavailable();
    const pattern = funJobPattern(item.job_id), seen = timestamp(item.first_seen_at);
    if (!pattern || pattern !== item.pattern || !seen || (started && seen < started)
      || ids.has(item.job_id) || typeof item.name !== 'string' || [...item.name].length > 500
      || typeof item.user !== 'string' || [...item.user].length > 80) return unavailable();
    ids.add(item.job_id);
    records.push({job_id: item.job_id, name: item.name, user: item.user, pattern, first_seen_at: seen});
  }
  records.sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at)
    || b.job_id.length - a.job_id.length || b.job_id.localeCompare(a.job_id));
  return {version: 1, status: value.status, started_at: started, records};
}

export function funJobsSnapshot(row, now = Date.now()) {
  const receivedAt = row && Number.isFinite(row.received_at) ? row.received_at : null;
  const archive = row ? normalizeFunJobs(JSON.parse(row.payload).fun_jobs) : null;
  return {serverTime: now, receivedAt, stale: receivedAt === null || now - receivedAt > 180000, archive};
}
