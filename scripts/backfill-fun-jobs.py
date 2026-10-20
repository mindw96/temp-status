#!/usr/bin/env python3
"""Preview, or explicitly import, matching historical IDs from local Slurm.

This is a one-time accounting query, never part of the reporting loop. The
existing private archive is merged under the collector's lock and backed up
before any change. Credentials and raw accounting output are never printed.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


_spec = importlib.util.spec_from_file_location(
    "fun_jobs_bridge", Path(__file__).resolve().parents[1] / "collector_bridge.py")
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)


class BackfillError(Exception):
    """A safe diagnostic that contains no command output or credentials."""


def _private_bytes(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > maximum):
            raise BackfillError("Expected an owner-only regular file with mode 600.")
        return stream.read(maximum + 1)


def archive_path(config_path):
    config = json.loads(_private_bytes(config_path, 1024 * 1024))
    value = config.get("fun_jobs_path") if isinstance(config, dict) else None
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise BackfillError("The existing config must specify an absolute fun_jobs_path.")
    return Path(value)


def candidates(max_job_id):
    ids = set()
    for length in range(4, 11):
        for digit in "123456789":
            ids.add(digit * length)
        for start in range(1, 10):
            for delta in (-1, 1):
                digits = [start + delta * index for index in range(length)]
                if all(0 <= digit <= 9 for digit in digits):
                    ids.add("".join(map(str, digits)))
    return sorted((value for value in ids if int(value) <= max_job_id), key=int)


def _command(arguments, runner, timeout):
    environment = dict(os.environ, LC_ALL="C", TZ="UTC")
    try:
        result = runner(arguments, capture_output=True, text=True,
                        timeout=timeout, check=False, env=environment)
    except (OSError, subprocess.TimeoutExpired):
        raise BackfillError("A read-only Slurm query failed or timed out.") from None
    if result.returncode != 0:
        raise BackfillError("A read-only Slurm query returned an error.")
    if len(result.stdout) > 32 * 1024 * 1024:
        raise BackfillError("Slurm query output exceeded the one-time import limit.")
    return result.stdout


def query_history(runner=subprocess.run):
    configuration = _command(["scontrol", "show", "config"], runner, 20)
    values = {}
    for line in configuration.splitlines():
        match = re.fullmatch(r"\s*(ClusterName|MaxJobId)\s*=\s*(\S+)\s*", line)
        if match:
            if match[1] in values:
                raise BackfillError("Slurm configuration contains duplicate identity fields.")
            values[match[1]] = match[2]
    cluster = values.get("ClusterName", "")
    maximum = values.get("MaxJobId", "")
    if (not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", cluster)
            or not re.fullmatch(r"[1-9][0-9]{0,9}", maximum)
            or int(maximum) > 4294967294):
        raise BackfillError("Slurm ClusterName or MaxJobId could not be verified.")
    wanted = candidates(int(maximum))
    if not wanted:
        raise BackfillError("No matching IDs are within Slurm's configured ID range.")
    output = _command([
        "sacct", "-a", "-X", "-D", "-M", cluster,
        "-S", "2000-01-01", "-E", "now", "-j", ",".join(wanted), "--json",
    ], runner, 60)
    try:
        response = json.loads(output)
    except (ValueError, RecursionError):
        raise BackfillError("Slurm accounting did not return valid JSON.") from None
    if (not isinstance(response, dict) or response.get("errors") != []
            or not isinstance(response.get("jobs"), list)):
        raise BackfillError("Slurm accounting returned errors or an unsupported response.")
    if len(response["jobs"]) > 100000:
        raise BackfillError("Slurm accounting returned too many rows for a one-time import.")
    return cluster, wanted, response["jobs"]


def _unset_number(value):
    return (isinstance(value, dict) and value.get("set") is False
            and value.get("infinite") is False)


def _scalar_job(row):
    """JSON job_id alone would incorrectly admit array and heterogeneous jobs."""
    array, heterogeneous = row.get("array"), row.get("het")
    return (isinstance(array, dict) and type(array.get("job_id")) is int
            and array["job_id"] == 0 and _unset_number(array.get("task_id"))
            and array.get("task") == ""
            and isinstance(heterogeneous, dict) and type(heterogeneous.get("job_id")) is int
            and heterogeneous["job_id"] == 0
            and _unset_number(heterogeneous.get("job_offset")))


def select_records(rows, cluster, wanted, now):
    wanted = set(wanted)
    selected, skipped = {}, Counter()
    matching_rows = 0
    for row in rows:
        if not isinstance(row, dict):
            skipped["invalid_row"] += 1
            continue
        if row.get("cluster") != cluster:
            skipped["other_cluster"] += 1
            continue
        raw_id = row.get("job_id")
        if (type(raw_id) is not int or str(raw_id) not in wanted
                or not bridge.fun_job_pattern(str(raw_id))):
            skipped["nonmatching_id"] += 1
            continue
        if not _scalar_job(row):
            skipped["array_heterogeneous_or_unknown_identity"] += 1
            continue
        times = row.get("time")
        submission = times.get("submission") if isinstance(times, dict) else None
        # Zero denotes an unknown/unset Slurm timestamp, not a 1970 submission.
        if (type(submission) is not int or submission <= 0
                or submission > now.timestamp()):
            skipped["invalid_submission"] += 1
            continue
        if not isinstance(row.get("name"), str) or not isinstance(row.get("user"), str):
            skipped["invalid_metadata"] += 1
            continue
        submitted_at = datetime.fromtimestamp(submission, timezone.utc).isoformat(
            timespec="milliseconds").replace("+00:00", "Z")
        job_id = str(raw_id)
        record = {
            "job_id": job_id, "name": row["name"][:500], "user": row["user"][:80],
            "pattern": bridge.fun_job_pattern(job_id),
            "source": "sacct", "submitted_at": submitted_at,
        }
        matching_rows += 1
        previous = selected.get(job_id)
        if previous is None or (
                record["submitted_at"], record["user"], record["name"]) < (
                previous["submitted_at"], previous["user"], previous["name"]):
            selected[job_id] = record
    records = sorted(selected.values(), key=lambda row: (row["submitted_at"], int(row["job_id"])))
    return records, {
        "row_count": len(rows), "matching_rows": matching_rows,
        "duplicate_rows": matching_rows - len(records), "skipped": dict(sorted(skipped.items())),
    }


def _existing_archive(path):
    archive = bridge._read_fun_jobs(path)
    if archive is None:
        raise BackfillError("The collector must initialize its archive before importing history.")
    return archive


def _plan(archive, records, now):
    if now < bridge._fun_jobs_timestamp(archive["started_at"]):
        raise BackfillError("The import clock is earlier than archive collection start.")
    existing = {row["job_id"] for row in archive["records"]}
    fresh = [dict(row) for row in records if row["job_id"] not in existing]
    if len(archive["records"]) + len(fresh) > bridge.MAX_FUN_JOBS:
        raise BackfillError("The archive has insufficient capacity; nothing was imported.")
    imported_at = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for row in fresh:
        row["first_seen_at"] = imported_at
    return fresh, sorted(existing.intersection(row["job_id"] for row in records), key=int)


def _backup(path):
    original = _private_bytes(path, bridge.MAX_FUN_JOBS_BYTES)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    with tempfile.NamedTemporaryFile(
            mode="wb", prefix=f"{path.name}.before-sacct-{timestamp}-",
            suffix=".json", dir=path.parent, delete=False) as stream:
        backup = Path(stream.name)
        os.fchmod(stream.fileno(), 0o600)
        stream.write(original)
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return backup, hashlib.sha256(original).hexdigest()


def backfill(config_path, apply=False, runner=subprocess.run, now=None):
    path = archive_path(Path(config_path))
    cluster, wanted, rows = query_history(runner)
    now = now or datetime.now(timezone.utc)
    records, counts = select_records(rows, cluster, wanted, now)
    backup, checksum = None, None
    if apply:
        lock_fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(lock_fd, "a") as lock:
            info = os.fstat(lock.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise BackfillError("The archive lock is not owned by this user.")
            os.fchmod(lock.fileno(), 0o600)
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            # Querying happens outside the lock; merge the latest daemon state.
            archive = _existing_archive(path)
            fresh, existing_ids = _plan(archive, records, now)
            if fresh:
                backup, checksum = _backup(path)
                updated = {**archive, "records": archive["records"] + fresh}
                bridge._write_fun_jobs(path, updated)
    else:
        archive = _existing_archive(path)
        fresh, existing_ids = _plan(archive, records, now)
    return {
        "ok": True, "mode": "apply" if apply else "preview", "cluster": cluster,
        "candidate_count": len(wanted), **counts,
        "matching_ids": [row["job_id"] for row in records], "existing_ids": existing_ids,
        "would_add_count": len(fresh), "added_count": len(fresh) if apply else 0,
        "archive_total": len(archive["records"]) + (len(fresh) if apply else 0),
        "records": fresh, "backup_path": str(backup) if backup else None,
        "backup_sha256": checksum,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Existing private collector JSON config")
    parser.add_argument("--apply", action="store_true", help="Back up and merge; otherwise only preview")
    args = parser.parse_args()
    try:
        result = backfill(args.config, apply=args.apply)
    except BackfillError as error:
        result = {"ok": False, "error": str(error)}
    except (OSError, ValueError, TypeError, OverflowError, RecursionError):
        result = {"ok": False, "error": "The private archive or config could not be safely read or updated."}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
