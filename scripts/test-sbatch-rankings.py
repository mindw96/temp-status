#!/usr/bin/env python3
"""Meaningful accounting and availability checks, without Slurm or root."""
import importlib.util
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import tempfile
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "sbatch_rankings.py"
spec = importlib.util.spec_from_file_location("rankings", SOURCE)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def timestamp(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def compact(job_id, user="mindw", when="2026-10-20T02:00:00Z", sequence=None, **extra):
    sequence = job_id if sequence is None else sequence
    value = {"id": job_id, "parent": job_id, "group": False, "user": user,
             "submit": timestamp(when), "sluid": f"s{sequence:013d}",
             "original": f"s{sequence:013d}", "restarts": 0, "batch": True}
    return {**value, **extra}


def raw(value, command="sbatch train.sh"):
    return {"job_id": value["id"], "user": value["user"],
            "time": {"submission": value["submit"]},
            "sluid": value["sluid"], "original_sluid": value["original"],
            "restart_cnt": value["restarts"],
            "array": {"job_id": value["parent"] if value["group"] else 0},
            "het": {"job_id": 0}, "submit_line": command}


now = datetime.fromisoformat("2026-10-20T07:00:00+00:00")
records = [
    compact(1, when="2026-10-19T15:00:00Z"),   # Today 00:00 KST.
    compact(2, when="2026-10-19T14:59:59Z"),   # Yesterday.
    compact(3, when="2026-10-18T15:00:00Z"),   # Monday 00:00.
    compact(4, when="2026-10-18T14:59:59Z"),   # Previous week.
    compact(5, when="2026-09-30T15:00:00Z"),   # October 1 KST.
    compact(6, when="2026-09-30T14:59:59Z"),   # September.
]
summary = r.aggregate(records, now)
assert [summary["periods"][key]["total"] for key in ("today", "week", "month", "all")] == [1, 3, 5, 6]
assert summary["periods"]["today"]["start"] == "2026-10-19T15:00:00Z"
assert summary["periods"]["week"]["start"] == "2026-10-18T15:00:00Z"
assert summary["periods"]["month"]["start"] == "2026-09-30T15:00:00Z"
assert summary["periods"]["all"]["start"] == summary["history_start"]
assert r.aggregate([], now)["periods"]["all"]["start"] is None
# January rollover and Monday year boundary.
new_year = datetime.fromisoformat("2027-01-03T15:01:00+00:00")
empty = r.aggregate([], new_year)
assert empty["periods"]["week"]["start"] == "2027-01-03T15:00:00Z"
assert empty["periods"]["month"]["start"] == "2026-12-31T15:00:00Z"

# Resize records keep OriginalSLUID while Submit changes; requeues change it.
first = compact(10)
resized = compact(10, sequence=11, original=first["original"], when="2026-10-20T03:00:00Z")
requeued = compact(10, sequence=12, restarts=1, when="2026-10-20T04:00:00Z")
reused = compact(10, sequence=13, when="2026-10-20T05:00:00Z")
assert len(r.submission_events([first, resized, requeued])) == 1
assert len(r.submission_events([first, resized, requeued, reused])) == 2
# Array tasks and heterogeneous components share a submission, not a run SLUID.
array = [compact(20 + n, parent=20, group=True) for n in range(4)]
array += [compact(21, parent=20, group=True, sequence=30, restarts=1)]
assert len(r.submission_events(array)) == 1
assert len(r.submission_events(array + [compact(40, batch=False)])) == 1
try:
    r.submission_events([requeued])
    raise AssertionError("An orphan requeue cannot be dated as a fresh submission")
except r.CollectionError as exc:
    assert str(exc) == "original_submission_missing"
# A command containing newlines, pipes or unbalanced later arguments remains
# machine-safe JSON; only the original executable class is retained.
for line in ['sbatch --wrap="printf x\\ny | head"', '/usr/bin/sbatch --wrap="unclosed']:
    reduced = r.compact_job(raw(first, line))
    assert reduced["batch"] and "submit_line" not in reduced
assert not r.compact_job(raw(first, "srun python train.py"))["batch"]
assert not r.compact_job(raw(first, "env sbatch x"))["batch"]
assert r.compact_job(raw(first, '"/usr/bin/sbatch" file.sh'))["batch"]
deleted_user = {**raw(first), "user": None, "user_id": 3001}
assert r.compact_job(deleted_user)["user"] == "3001"

# Count descending, stable username tie-break, exactly five people when present.
people = [compact(i + 100, user=name) for i, name in enumerate(["f", "e", "d", "c", "b", "a"])]
people += [compact(200, user="f")]
period = r.aggregate(people, now)["periods"]["today"]
assert period == {"start": "2026-10-19T15:00:00Z", "total": 7, "users": 6,
                  "top": [{"user": "f", "count": 2}, {"user": "a", "count": 1},
                          {"user": "b", "count": 1}, {"user": "c", "count": 1},
                          {"user": "d", "count": 1}]}

initial = {"version": 1, "last_success": 0, "last_full": 0, "records": {}}
queue = [{"job_id": 10, "user_name": "mindw"}]
calls = []


def fake_json(arguments):
    calls.append(arguments)
    return queue if arguments[0].endswith("squeue") else [raw(first)]


with patch.object(r, "_json", side_effect=fake_json), patch.object(r, "inventory", return_value={10}) as inventory:
    cache, result = r.refresh(initial, now)
    assert result["periods"]["all"]["total"] == 1
    assert inventory.call_args.args[0] == "2000-01-01"
    assert len(calls) == 2 and calls[1][calls[1].index("-j") + 1] == "10"
    assert "-s" not in calls[1]  # An explicit state filter hides not-yet-eligible jobs.
    calls.clear()
    later = now.replace(second=30)
    updated, result = r.refresh(cache, later)
    assert inventory.call_args.args[0] == "2026-10-20T06:50:00"
    assert updated["last_full"] == cache["last_full"]
    assert len(updated["records"]) == 1
    calls.clear()
    reconciled, _ = r.refresh(cache, now.replace(hour=14))
    assert inventory.call_args.args[0] == "2000-01-01"
    assert reconciled["last_full"] > cache["last_full"]

# Missing another current user's accounting record must never become a Top 5
# of just the current SSH account, even when sacct exits successfully.
with patch.object(r, "_json", side_effect=[
        queue + [{"job_id": 99, "user_name": "kimhj"}], [raw(first)]]), \
        patch.object(r, "inventory", return_value={10}):
    try:
        r.refresh(initial, now)
        raise AssertionError("Restricted accounting scope passed")
    except r.CollectionError as exc:
        assert str(exc) == "accounting_scope_incomplete"
with patch.object(r, "_run", return_value='{"jobs":[],"errors":[{"error":"restricted"}]}'):
    try:
        r._json(["sacct"])
        raise AssertionError("A successful process with JSON errors passed")
    except r.CollectionError:
        pass
with patch.object(r, "_run", return_value="10\n10.batch\n"):
    try:
        r.inventory("2000-01-01", now)
        raise AssertionError("Unsafe inventory row passed")
    except r.CollectionError:
        pass

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "cache.json"
    r.atomic_json(path, cache, 0o600)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert r.read_cache(path) == cache
    output = Path(directory) / "sbatch-rankings.json"
    r.atomic_json(output, summary, 0o644)
    assert stat.S_IMODE(output.stat().st_mode) == 0o644
    before = path.read_bytes()
    writes = []
    with patch.object(r.os, "geteuid", return_value=0), \
            patch.object(r, "read_cache", return_value=cache), \
            patch.object(r, "refresh", side_effect=r.CollectionError("slurm_command_failed")), \
            patch.object(r, "atomic_json", side_effect=lambda *args: writes.append(args)), \
            patch("builtins.print"):
        assert not r.run_once(path, output, now.replace(day=21))
    assert path.read_bytes() == before and len(writes) == 1 and writes[0][0] == output
    failed = writes[0][1]
    assert failed["status"] == "unavailable" and failed["collected_at"] == r.iso(now)
    assert failed["periods"] == r.aggregate(cache["records"].values(), now)["periods"]
    path.chmod(0o644)
    try:
        r.read_cache(path)
        raise AssertionError("Unsafe cache permissions passed")
    except r.CollectionError:
        pass
    path.chmod(0o600)
    path.write_text("{broken")
    try:
        r.read_cache(path)
        raise AssertionError("Damaged cache reset silently")
    except r.CollectionError:
        pass

unknown_writes = []
with patch.object(r.os, "geteuid", return_value=501), \
        patch.object(r, "atomic_json", side_effect=lambda *args: unknown_writes.append(args)), \
        patch("builtins.print"):
    assert not r.run_once(Path("/unused/cache"), Path("/unused/output"), now)
unknown = unknown_writes[0][1]
assert unknown["status"] == "unavailable" and unknown["collected_at"] is None
assert all(period["start"] is None and period["top"] == [] for period in unknown["periods"].values())

print("sbatch ranking collector checks passed: KST boundaries, deduplication, scope, cache, failures")
