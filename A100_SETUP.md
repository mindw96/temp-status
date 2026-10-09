# A100 Kubernetes status

The A100 page is independent of the existing Slurm dashboard:

- Page: `https://status.nlp.io.kr/a100`
- Report receiver: `POST /api/a100/report`
- Public snapshot: `GET /api/a100/snapshot`
- Authentication: a **dedicated** `A100_REPORT_TOKEN`, sent as `X-Status-Token`.

The login node sends outbound HTTPS; no campus inbound port is opened. Existing
Slurm collectors, dashboard reports, and Kubernetes workloads remain unchanged.
This shares the existing Render service, so service restarts affect both pages.

## What the collector measures

`agents/a100_agent.py` requires Python 3.8+, `kubectl`, and the existing GPFS quota
command on the A100 login node. It uses only Python's standard library.

- Lists namespace Jobs **and** Pods. A Job waiting for GPU quota can exist before
  its first Pod; it is shown as Pending / WaitingForPod, not silently omitted.
- Reads the live `compute-resources` ResourceQuota. Its remaining GPU quota is
  not a statement that those physical GPUs can immediately run a new Pod.
- Runs read-only `nvidia-smi` in Running containers that explicitly request GPUs,
  with at most two concurrent execs. It does not execute in CPU-only containers
  because they can expose all host GPUs on this cluster.
- Collects GPU UUID, model, utilization, VRAM used, and VRAM capacity. GPU indices
  are intentionally omitted. Visible device count must match the container's
  GPU request before metrics are attributed to it.
- Gets actual lab storage usage and hard limit using
  `/usr/lpp/mmfs/bin/mmlsquota -u nlp-lab --block-size 1K -Y gpfsai`.
  GPFS `blockUsage` / `blockLimit` values are KiB. PVC capacity and whole-filesystem
  free space do not represent the lab's storage quota.
- Uses explicit `owner` or `student` labels, never a guessed name prefix.
- Publishes no workload logs, command lines, container environment, or credentials.

CPU and RAM values are **requested** resources, not utilization. Job requests
represent template resources times its requested concurrent Pod count. Resource
requests account for regular containers, init-container maxima and Pod overhead
for this Kubernetes 1.23 cluster. Job terminal conditions are authoritative;
failed Pod attempts do not automatically mark a retrying Job failed.

The report retains active workloads first and then the newest completed Jobs,
up to 500 rows and 64 Pod summaries per row, within the receiver's 1 MiB limit.
If active workloads alone exceed these bounds, collection is marked unavailable
instead of silently presenting an incomplete active workload list.

## Configuration

Create a private directory, for example `/home/nlp-lab/mindw/a100-status-agent`,
and copy `agents/a100_agent.py` there. Do not put secrets in this repository.
Create `config.env` in that directory with mode `600`:

```dotenv
A100_REPORT_URL=https://status.nlp.io.kr/api/a100/report
A100_REPORT_TOKEN=REPLACE_WITH_DEDICATED_RANDOM_TOKEN
A100_NAMESPACE=nlp-lab
A100_INTERVAL_SECONDS=30
A100_STORAGE_INTERVAL_SECONDS=300
A100_COMMAND_TIMEOUT_SECONDS=10
A100_QUOTA_USER=nlp-lab
A100_GPFS_FILESYSTEM=gpfsai
```

Set the same dedicated token as `A100_REPORT_TOKEN` in the existing Render
service's environment. There is no fallback to the Slurm collector token.
Never include a real token in a shell command argument, Git commit, screenshot,
or shared transcript. Tokens must be at least 32 non-whitespace characters.

The config reader accepts `KEY=value` or shell-quoted values, but performs no
shell evaluation or variable expansion. It checks file ownership and rejects
group/world-readable config files. HTTPS redirects are rejected to avoid
forwarding the token to another location.

## Validate before starting

These commands run on the A100 login node from the private agent directory:

```bash
# No token needed; this performs read-only collection and does not transmit.
/usr/bin/python3 a100_agent.py --dry-run

# Uses the private token and sends one real snapshot.
/usr/bin/python3 a100_agent.py --env-file config.env --once
```

Compare the output against `kubectl -n nlp-lab get jobs,pods`, the namespace
ResourceQuota, read-only `nvidia-smi` from a Running GPU container, and GPFS quota.
The normal test command in a development checkout is:

```bash
python3 scripts/test-a100-agent.py
```

## Keep it running

The existing login-node user systemd manager has lingering disabled. Use the
same user-cron supervision pattern as the existing internal status page,
preserving every pre-existing crontab entry. The collector stays running and
collects every 30 seconds; the once-per-minute cron entry only starts it when
the previous collector has exited:

```cron
* * * * * /usr/bin/python3 /home/nlp-lab/mindw/a100-status-agent/a100_agent.py --env-file /home/nlp-lab/mindw/a100-status-agent/config.env --lock-file /home/nlp-lab/mindw/a100-status-agent/a100-agent.lock --log-file /home/nlp-lab/mindw/a100-status-agent/agent.log
```

`fcntl` prevents concurrent sending processes. Logs rotate at 1 MiB with three
backups and contain fixed error codes and counts. No system-wide services or
shell startup files need modification.

## Freshness, failures, and retirement

The default GPU/job interval is 30 seconds and storage interval is 300 seconds.
Collection is bounded by a 25-second deadline, individual commands by 10 seconds,
and report requests by 15 seconds. POST failures back off up to five minutes.
After recovery the next collection is sent; there is no backlog or history.

The shared login node's OS clock was approximately four minutes behind the
receiver when deployment was checked. The agent does **not** change that clock.
Before its first collection and every five minutes, it makes a token-free HTTPS
GET to the configured receiver origin's `/healthz`, bypassing cache, and uses
the response `Date` to correct its own collection timestamps. Requests have a
five-second limit, redirects are rejected, and clock offsets over 24 hours or
excessive round-trip latency are rejected. A failed calibration is reported as
`collection_failed` and retried the next cycle. Previously stored source
timestamps and Kubernetes-provided lifecycle dates are never rewritten.

On a source failure, a previously successful value retains its original
`collected_at` timestamp and an explicit error. Missing values remain null.
`jobs_collected_at` is independent of report receipt time, so fresh transport
cannot make an old job listing look freshly queried. Terminal/deleted workloads
drop out when Kubernetes removes them; retained metrics are not reassigned to
new workloads. Storage polling failures are retried at its normal 300-second
interval to avoid hammering the shared filesystem.

The agent receives no commands from the report receiver. To retire the temporary
server, remove only its dedicated cron entry, stop the PID recorded in its
`a100-agent.lock` after checking its command, then revoke `A100_REPORT_TOKEN` in
Render. Keep or remove the A100 page separately. Do not delete or modify any
Kubernetes Job as part of retiring the monitor.
