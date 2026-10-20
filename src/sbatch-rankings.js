// Rankings are a small, optional summary from the trusted Slurm collector.
// Invalid accounting data must never interrupt ordinary GPU/queue reporting.
export const SBATCH_RANKING_STALE_MS = 180000;
const FUTURE_ALLOWANCE_MS = 60000;
const PERIODS = ['today', 'week', 'month', 'all'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const unavailable = () => ({
  version: 1, status: 'unavailable', collected_at: null, timezone: 'Asia/Seoul', history_start: null,
  periods: Object.fromEntries(PERIODS.map(key => [key, {start: null, total: 0, users: 0, top: []}]))
});

function timestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < 0) return null;
  const iso = new Date(time).toISOString();
  return iso.slice(0, 19) === value.slice(0, 19) ? iso : null;
}

function calendarStarts(collectedAt) {
  // KST uses UTC+09:00. Move the clock before reading UTC calendar components,
  // then convert each local midnight back to UTC. Weeks begin on Monday.
  const offset = 9 * 60 * 60 * 1000;
  const local = new Date(Date.parse(collectedAt) + offset);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const monday = midnight - ((local.getUTCDay() + 6) % 7) * 86400000;
  return {
    today: new Date(midnight - offset).toISOString(),
    week: new Date(monday - offset).toISOString(),
    month: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offset).toISOString()
  };
}

export function normalizeSbatchRankings(value, now = Date.now()) {
  if (value === undefined || value === null) return null;
  if (!object(value) || value.version !== 1 || !['ok', 'unavailable'].includes(value.status)
    || value.timezone !== 'Asia/Seoul' || !object(value.periods)) return unavailable();
  const collected = timestamp(value.collected_at), historyStart = timestamp(value.history_start);
  if ((value.collected_at !== null && !collected) || (value.history_start !== null && !historyStart)
    || (value.status === 'ok' && !collected)
    || (collected && Date.parse(collected) > now + FUTURE_ALLOWANCE_MS)
    || (historyStart && (!collected || historyStart > collected))) return unavailable();
  const starts = collected ? calendarStarts(collected) : null, periods = {};
  for (const key of PERIODS) {
    const period = value.periods[key];
    if (!object(period) || !count(period.total) || !count(period.users)
      || period.users > period.total || !Array.isArray(period.top)
      || period.top.length !== Math.min(period.users, 5)) return unavailable();
    const start = timestamp(period.start), expected = key === 'all' ? historyStart : starts?.[key] ?? null;
    if ((period.start !== null && !start) || start !== expected
      || (!collected && (period.total || period.users))
      || (period.total > 0 && !historyStart)) return unavailable();
    const users = new Set(), top = [];
    let subtotal = 0;
    for (const entry of period.top) {
      if (!object(entry) || typeof entry.user !== 'string' || !entry.user
        || entry.user.trim() !== entry.user || [...entry.user].length > 80
        || /[\u0000-\u001f\u007f]/.test(entry.user) || users.has(entry.user)
        || !count(entry.count) || entry.count === 0 || entry.count > period.total) return unavailable();
      users.add(entry.user);
      subtotal += entry.count;
      if (!Number.isSafeInteger(subtotal) || subtotal > period.total) return unavailable();
      top.push({user: entry.user, count: entry.count});
    }
    if ((period.users <= 5 && subtotal !== period.total)
      || (period.users > 5 && period.total - subtotal < period.users - 5)) return unavailable();
    top.sort((a, b) => b.count - a.count || (a.user < b.user ? -1 : a.user > b.user ? 1 : 0));
    periods[key] = {start, total: period.total, users: period.users, top};
  }
  if ((!periods.all.total && historyStart)
    || ['today', 'week', 'month'].some(key => periods[key].total > periods.all.total
      || periods[key].users > periods.all.users)
    || periods.today.total > periods.week.total || periods.today.users > periods.week.users
    || periods.today.total > periods.month.total || periods.today.users > periods.month.users) return unavailable();
  return {version: 1, status: value.status, collected_at: collected, timezone: 'Asia/Seoul',
    history_start: historyStart, periods};
}

export function sbatchRankingsSnapshot(row, now = Date.now()) {
  const receivedAt = Number.isSafeInteger(row?.received_at) && row.received_at >= 0 ? row.received_at : null;
  let rankings = null;
  if (row) {
    try { rankings = normalizeSbatchRankings(JSON.parse(row.payload).sbatch_rankings, now); }
    catch { rankings = unavailable(); }
  }
  const collected = rankings?.collected_at ? Date.parse(rankings.collected_at) : null;
  // A freshly delivered report may contain old cached accounting data. Check
  // both clocks and period rollover before presenting the ranking as current.
  const stale = !rankings || rankings.status !== 'ok' || receivedAt === null || collected === null
    || receivedAt > now + FUTURE_ALLOWANCE_MS || now - receivedAt > SBATCH_RANKING_STALE_MS
    || now - collected > SBATCH_RANKING_STALE_MS
    || calendarStarts(rankings.collected_at).today !== calendarStarts(new Date(now).toISOString()).today;
  return {serverTime: now, receivedAt, stale, rankings};
}
