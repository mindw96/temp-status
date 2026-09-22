'use strict';

// Resolve reported process identities only. GPU positions, users, and node names
// are not sufficient evidence of a Slurm allocation.
function resolveGpuJobs(processes, jobs) {
  const isId = value => typeof value === 'string' && value.length > 0;
  const activeStates = new Set(['RUNNING', 'COMPLETING', 'SUSPENDED', 'CONFIGURING', 'R', 'CG', 'S', 'CF']);
  const activeJobs = (Array.isArray(jobs) ? jobs : []).filter(job =>
    job && isId(job.id) && activeStates.has(job.state)
  );
  const groups = new Map();

  for (const process of Array.isArray(processes) ? processes : []) {
    if (!process || typeof process !== 'object') continue;
    const primary = isId(process.slurm_job_id) ? process.slurm_job_id : null;
    const alternates = [...new Set((Array.isArray(process.slurm_job_ids) ? process.slurm_job_ids : []).filter(isId))];
    const ids = new Set([primary, ...alternates].filter(isId));
    let matchedJob = null;

    if (ids.size) {
      // Stop at the first non-empty tier. Multiple candidates at that tier are
      // ambiguous; a lower-precedence alias must not break the tie.
      const tiers = [
        () => primary ? activeJobs.filter(job => job.id === primary) : [],
        () => activeJobs.filter(job => alternates.includes(job.id)),
        () => activeJobs.filter(job => Array.isArray(job.raw?.job_id_aliases)
          && job.raw.job_id_aliases.some(alias => isId(alias) && ids.has(alias)))
      ];
      for (const candidatesAtTier of tiers) {
        const candidates = candidatesAtTier();
        if (!candidates.length) continue;
        if (candidates.length === 1) matchedJob = candidates[0];
        break;
      }
    }

    const jobId = matchedJob?.id ?? primary ?? alternates[0] ?? null;
    const processName = typeof process.slurm_job_name === 'string' && process.slurm_job_name.length
      ? process.slurm_job_name : null;
    // The normalized display name may be a placeholder. Prefer the original
    // queue name so an empty queue field can fall back to a process report.
    const queueName = matchedJob?.raw && Object.hasOwn(matchedJob.raw, 'name')
      ? matchedJob.raw.name : matchedJob?.name;
    const name = jobId === null ? null
      : typeof queueName === 'string' && queueName.length ? queueName : processName;
    const key = jobId === null ? 'unidentified' : `${matchedJob ? 'matched' : 'unknown'}:${jobId}`;
    let group = groups.get(key);
    if (!group) {
      group = {record: {jobId, name, job: matchedJob, processCount: 0}, pids: new Set()};
      groups.set(key, group);
    } else if (group.record.name === null && name !== null) {
      group.record.name = name;
    }

    const pid = process.pid;
    const knownPid = typeof pid === 'number' && Number.isInteger(pid) && pid >= 0
      || typeof pid === 'string' && /^\d+$/.test(pid);
    if (!knownPid || !group.pids.has(String(pid))) {
      group.record.processCount += 1;
      if (knownPid) group.pids.add(String(pid));
    }
  }

  return [...groups.values()].map(group => group.record);
}
