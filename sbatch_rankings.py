#!/usr/bin/env python3
"""Read-only Slurm accounting exporter. Run as root; publish aggregates only.

Initial/reconciliation reads use a numeric ID inventory and bounded JSON batches.
No submit commands, job names or paths are persisted. Accepted sbatch submissions
are counted; array/heterogeneous components, steps, resizes and requeues are not
additional submissions. "All" covers accounting records retained by Slurm.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile
import time
from zoneinfo import ZoneInfo

UTC = timezone.utc
KST = ZoneInfo("Asia/Seoul")
MAX_BYTES = 64 * 1024 * 1024
MAX_RECORDS = 500_000
RECONCILE_SECONDS = 6 * 60 * 60
BATCH_SIZE = 500
USER_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,80}$")
SLUID_RE = re.compile(r"^s[0-9A-Z]{13}$")
# Explicit PENDING selection includes submitted jobs that never became eligible.
# With no state filter, sacct silently omits some of those accepted submissions.
ALL_STATES = ("BOOT_FAIL,CANCELLED,COMPLETED,DEADLINE,FAILED,NODE_FAIL,"
              "OUT_OF_MEMORY,PENDING,PREEMPTED,RUNNING,REQUEUED,RESIZING,"
              "REVOKED,SUSPENDED,TIMEOUT")


class CollectionError(Exception):
    """A bounded, non-sensitive reason the snapshot is unavailable."""


def valid_sluid(value):
    return (isinstance(value, str) and bool(SLUID_RE.fullmatch(value))
            and value != "s0000000000000")


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def number(value):
    if isinstance(value, dict):
        value = value.get("number") if value.get("set") and not value.get("infinite") else 0
    return value if type(value) is int and value >= 0 else 0


def _run(arguments):
    # Spool command output so an unexpectedly large accounting response cannot
    # consume unbounded Python memory. stderr/submit_line never reach logs.
    env = {**os.environ, "TZ": "UTC", "SLURM_TIME_FORMAT": "%Y-%m-%dT%H:%M:%S"}
    for key in list(env):
        if key.startswith("SACCT_"):
            del env[key]
    try:
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(arguments, stdout=output, stderr=subprocess.PIPE,
                                    env=env, timeout=60, check=False)
            if result.returncode:
                raise CollectionError("slurm_command_failed")
            if output.tell() > MAX_BYTES:
                raise CollectionError("slurm_response_too_large")
            output.seek(0)
            return output.read().decode("utf-8")
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise CollectionError("slurm_command_unavailable") from exc


def _json(arguments):
    try:
        value = json.loads(_run(arguments))
    except (ValueError, RecursionError) as exc:
        raise CollectionError("slurm_invalid_json") from exc
    if not isinstance(value, dict) or value.get("errors"):
        raise CollectionError("slurm_reported_error")
    if not isinstance(value.get("jobs"), list):
        raise CollectionError("slurm_missing_jobs")
    return value["jobs"]


def inventory(start, now):
    text = _run(["/usr/bin/sacct", "-a", "-X", "-D", "--array",
                 "-S", start, "-E", now.strftime("%Y-%m-%dT%H:%M:%S"),
                 "-s", ALL_STATES, "-nP", "--format=JobIDRaw"])
    values = set()
    for line in text.splitlines():
        item = line.strip()
        if not re.fullmatch(r"[1-9][0-9]{0,10}", item):
            raise CollectionError("slurm_invalid_inventory")
        values.add(int(item))
        if len(values) > MAX_RECORDS:
            raise CollectionError("slurm_inventory_too_large")
    return values


def queue_identity(job):
    user = job.get("user_name")
    job_id = number(job.get("job_id"))
    if not isinstance(user, str) or not USER_RE.fullmatch(user) or not job_id:
        raise CollectionError("queue_invalid_identity")
    return job_id, user


def compact_job(job):
    """Validate identity before dropping every nonessential accounting field."""
    if not isinstance(job, dict):
        raise CollectionError("accounting_invalid_record")
    job_id = number(job.get("job_id"))
    user = job.get("user")
    if user in (None, "") and type(job.get("user_id")) is int and job["user_id"] >= 0:
        user = str(job["user_id"])
    submitted = number(job.get("time", {}).get("submission"))
    sluid, original = job.get("sluid"), job.get("original_sluid")
    if (not job_id or not isinstance(user, str) or not USER_RE.fullmatch(user)
            or not submitted or not valid_sluid(sluid) or not valid_sluid(original)):
        raise CollectionError("accounting_invalid_identity")
    array = number(job.get("array", {}).get("job_id"))
    hetero = number(job.get("het", {}).get("job_id"))
    command = job.get("submit_line")
    if not isinstance(command, str):
        raise CollectionError("accounting_missing_submit_line")
    try:
        lexer = shlex.shlex(command, posix=True)
        lexer.whitespace_split = True
        executable = lexer.get_token()
    except ValueError:
        executable = None
    batch = bool(executable and os.path.basename(executable) == "sbatch")
    return {"id": job_id, "parent": array or hetero or job_id,
            "group": bool(array or hetero), "user": user, "submit": submitted,
            "sluid": sluid, "original": original,
            "restarts": number(job.get("restart_cnt")), "batch": batch,
            "resizing": "RESIZING" in job.get("state", {}).get("current", [])}


def compact_batch(jobs, now):
    """Restore legacy/null JSON fields from the same authoritative sacct rows.

    Slurm JSON omits the numeric UID when a Unix account no longer exists.
    Parsable output of identity fields (never SubmitLine) retains that UID.
    Matching the run SLUID, JobID and Submit prevents cross-linking reused IDs.
    """
    ids = set()
    for job in jobs:
        user = job.get("user")
        original = job.get("original_sluid")
        if (not isinstance(user, str) or not USER_RE.fullmatch(user)
                or not valid_sluid(original)):
            job_id = number(job.get("job_id"))
            if not job_id:
                raise CollectionError("accounting_invalid_identity")
            ids.add(job_id)
    identities = {}
    if ids:
        text = _run(["/usr/bin/sacct", "-a", "-X", "-D", "--array",
                     "-S", "2000-01-01", "-E", now.strftime("%Y-%m-%dT%H:%M:%S"),
                     "-j", ",".join(map(str, sorted(ids))), "-nP",
                     "--format=JobIDRaw,UID,SLUID,OriginalSLUID,Submit,Restarts"])
        for line in text.splitlines():
            fields = line.split("|")
            if len(fields) != 6:
                raise CollectionError("accounting_invalid_identity_fields")
            job_id, uid, sluid, original, submitted, restarts = fields
            if (not re.fullmatch(r"[1-9][0-9]{0,10}", job_id)
                    or not re.fullmatch(r"[0-9]{1,10}", uid)
                    or not valid_sluid(sluid)
                    or not re.fullmatch(r"[0-9]{1,10}", restarts)):
                raise CollectionError("accounting_invalid_identity_fields")
            try:
                stamp = int(datetime.strptime(submitted, "%Y-%m-%dT%H:%M:%S")
                            .replace(tzinfo=UTC).timestamp())
            except ValueError as exc:
                raise CollectionError("accounting_invalid_identity_fields") from exc
            key = (int(job_id), sluid, stamp)
            value = {"uid": int(uid), "original": original, "restarts": int(restarts)}
            if key in identities and identities[key] != value:
                raise CollectionError("accounting_conflicting_identity")
            identities[key] = value
    result = []
    for job in jobs:
        item = dict(job)
        identity = identities.get((number(item.get("job_id")), item.get("sluid"),
                                   number(item.get("time", {}).get("submission"))))
        user = item.get("user")
        if not isinstance(user, str) or not USER_RE.fullmatch(user):
            if identity is None:
                raise CollectionError("accounting_missing_legacy_uid")
            item["user"] = str(identity["uid"])
        original = item.get("original_sluid")
        original_missing = False
        if not valid_sluid(original):
            if identity is None:
                raise CollectionError("accounting_missing_legacy_identity")
            candidate = identity["original"]
            if valid_sluid(candidate):
                item["original_sluid"] = candidate
            elif candidate in ("", "Unknown", "None", "(null)", "0", "s0000000000000"):
                # OriginalSLUID is optional in legacy records. The real run
                # SLUID remains unique; restart_cnt still excludes requeues.
                # Later resize rows referencing this SLUID join it normally.
                item["original_sluid"] = item.get("sluid")
                original_missing = True
            else:
                raise CollectionError("accounting_invalid_legacy_original")
            item["restart_cnt"] = identity["restarts"]
        record = compact_job(item)
        if original_missing:
            record["legacy_original_missing"] = True
        result.append(record)
    return result


def submission_events(records):
    """Reduce run records to actual sbatch submissions.

    OriginalSLUID joins resizes. Restarted runs join the preceding initial run
    for the same parent/user. A fresh restart-count-zero SLUID is a new scalar
    submission, so JobID reuse is preserved. Array/heterogeneous initial
    components share parent/user/submission time and count once.
    """
    original_runs = {}
    for record in records:
        if not record["batch"]:
            continue
        key = (record["user"], record["parent"], record["original"])
        previous = original_runs.get(key)
        if previous is None or record["submit"] < previous["submit"]:
            original_runs[key] = record
    groups = defaultdict(list)
    for record in original_runs.values():
        groups[(record["user"], record["parent"])].append(record)
    events = []
    for (user, _), runs in groups.items():
        initial = [run for run in runs if run["restarts"] == 0]
        if not initial:
            # The original submission has been purged; attributing a restart to
            # today's submissions would be false. Keep the source unavailable.
            raise CollectionError("original_submission_missing")
        if (len(initial) > 1
                and any(run.get("legacy_original_missing") for run in initial)
                and any(run.get("resizing") for run in runs)):
            raise CollectionError("accounting_ambiguous_legacy_resize")
        seen = set()
        for run in initial:
            key = ("group", run["submit"]) if run["group"] else ("scalar", run["original"])
            if key not in seen:
                seen.add(key)
                events.append((user, run["submit"]))
    return events


def aggregate(records, now):
    events = submission_events(records)
    local = now.astimezone(KST)
    today = local.replace(hour=0, minute=0, second=0, microsecond=0)
    starts = {"today": today, "week": today - timedelta(days=today.weekday()),
              "month": today.replace(day=1), "all": None}
    valid = [(user, stamp) for user, stamp in events if stamp <= now.timestamp()]
    earliest = min((stamp for _, stamp in valid), default=None)
    periods = {}
    for key, start in starts.items():
        counts = Counter(user for user, stamp in valid
                         if start is None or stamp >= start.timestamp())
        ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        periods[key] = {"start": (iso(start) if start else
                                  iso(datetime.fromtimestamp(earliest, UTC)) if earliest else None),
                        "total": sum(counts.values()), "users": len(counts),
                        "top": [{"user": user, "count": count}
                                for user, count in ranked[:5]]}
    return {"version": 1, "status": "ok", "collected_at": iso(now),
            "timezone": "Asia/Seoul",
            "history_start": iso(datetime.fromtimestamp(earliest, UTC)) if earliest else None,
            "periods": periods}


def read_cache(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {"version": 1, "last_success": 0, "last_full": 0, "records": {}}
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_BYTES):
            raise CollectionError("unsafe_cache")
        try:
            cache = json.load(stream)
        except (ValueError, RecursionError) as exc:
            raise CollectionError("invalid_cache") from exc
    if (not isinstance(cache, dict) or cache.get("version") != 1
            or type(cache.get("last_success")) not in (int, float)
            or type(cache.get("last_full")) not in (int, float)
            or not isinstance(cache.get("records"), dict)
            or len(cache["records"]) > MAX_RECORDS):
        raise CollectionError("invalid_cache")
    for key, record in cache["records"].items():
        if (not isinstance(record, dict) or key != record.get("sluid")
                or type(record.get("batch")) is not bool
                or type(record.get("group")) is not bool
                or not isinstance(record.get("user"), str)
                or not USER_RE.fullmatch(record["user"])
                or not isinstance(record.get("original"), str)
                or not re.fullmatch(r"s[0-9A-Z]{13}", record["original"])
                or any(type(record.get(k)) is not int or record[k] < 0
                       for k in ("id", "parent", "submit", "restarts"))):
            raise CollectionError("invalid_cache_record")
    return cache


def atomic_json(path, value, mode):
    parent = path.parent
    info = parent.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise CollectionError("unsafe_output_directory")
    blob = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()
    if len(blob) > MAX_BYTES:
        raise CollectionError("cache_too_large")
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        dir_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def refresh(cache, now):
    if now.timestamp() < cache["last_success"]:
        raise CollectionError("clock_moved_backwards")
    full = (not cache["last_full"]
            or now.timestamp() - cache["last_full"] >= RECONCILE_SECONDS)
    start = ("2000-01-01" if full else
             datetime.fromtimestamp(max(0, cache["last_success"] - 600), UTC)
             .strftime("%Y-%m-%dT%H:%M:%S"))
    queue = _json(["/usr/bin/squeue", "-a", "--json"])
    live = {queue_identity(job) for job in queue}
    ids = inventory(start, now) | {job_id for job_id, _ in live}
    seen = set()
    incoming = {}
    ordered_ids = sorted(ids)
    for offset in range(0, len(ordered_ids), BATCH_SIZE):
        batch = ordered_ids[offset:offset + BATCH_SIZE]
        # With explicit IDs, sacct also returns jobs that are not yet eligible.
        jobs = _json(["/usr/bin/sacct", "-a", "-X", "-D", "--array",
                      "-S", "2000-01-01", "-E", now.strftime("%Y-%m-%dT%H:%M:%S"),
                      "-j", ",".join(map(str, batch)), "--json"])
        for record in compact_batch(jobs, now):
            seen.add((record["id"], record["user"]))
            incoming[record["sluid"]] = record
    if not live.issubset(seen):
        raise CollectionError("accounting_scope_incomplete")
    # Full reconciliation reflects records still retained by the accounting DB.
    records = incoming if full else {**cache["records"], **incoming}
    if len(records) > MAX_RECORDS:
        raise CollectionError("accounting_too_large")
    result = aggregate(records.values(), now)
    updated = {"version": 1, "last_success": now.timestamp(),
               "last_full": now.timestamp() if full else cache["last_full"],
               "records": records}
    return updated, result


def run_once(cache_path, output_path, now=None):
    now = now or datetime.now(UTC)
    cache = None
    try:
        if os.geteuid() != 0:
            raise CollectionError("root_accounting_reader_required")
        cache = read_cache(cache_path)
        updated, result = refresh(cache, now)
        atomic_json(cache_path, updated, 0o600)
        atomic_json(output_path, result, 0o644)
        return True
    except (CollectionError, OSError, ValueError, TypeError, KeyError) as exc:
        try:
            previous_time = (datetime.fromtimestamp(cache["last_success"], UTC)
                             if cache and cache["last_success"] else now)
            fallback = (aggregate(cache["records"].values(), previous_time)
                        if cache else aggregate([], now))
        except (CollectionError, ValueError, TypeError, KeyError):
            fallback = aggregate([], now)
        fallback["status"] = "unavailable"
        fallback["collected_at"] = (
            iso(datetime.fromtimestamp(cache["last_success"], UTC))
            if cache and cache["last_success"] else None)
        if fallback["collected_at"] is None:
            fallback["history_start"] = None
            for period in fallback["periods"].values():
                period["start"] = None
        reason = str(exc) if isinstance(exc, CollectionError) else "export_failed"
        fallback["error_code"] = reason
        try:
            atomic_json(output_path, fallback, 0o644)
        except (CollectionError, OSError):
            pass
        # Fixed reasons only: never log a Slurm response, command or traceback.
        print(json.dumps({"status": "unavailable", "reason": reason}), flush=True)
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=Path("/var/lib/nlp-status-ranking/sbatch-rankings.json"))
    parser.add_argument("--cache", type=Path,
                        default=Path("/var/lib/nlp-status-ranking/cache.json"))
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if (not args.output.is_absolute() or not args.cache.is_absolute()
            or args.output == args.cache or not 15 <= args.interval <= 3600):
        parser.error("absolute, distinct paths and interval 15..3600 required")
    if os.geteuid() != 0:
        parser.error("run the read-only exporter as root to include every Slurm user")
    # The installer owns this directory; reject symlinked/unsafe lock files.
    lock_path = args.cache.with_name(args.cache.name + ".lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
            parser.error("unsafe exporter lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            started = time.monotonic()
            success = run_once(args.cache, args.output)
            if args.once:
                return 0 if success else 1
            time.sleep(max(1, args.interval - (time.monotonic() - started)))


if __name__ == "__main__":
    raise SystemExit(main())
