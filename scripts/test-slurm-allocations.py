#!/usr/bin/env python3
"""Allocation identity regressions, independent of installed Slurm or SSH."""
import copy
import importlib.util
from pathlib import Path


root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("slurm_allocations", root / "collector_bridge.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
read = module.slurm_gpu_allocations


def job(detail="gpu:a6000:2(IDX:0,2)"):
    # Minimal producer fields from the actual Server2 job 54901 JSON report.
    return {"job_id": 54901, "job_state": ["RUNNING"], "nodes": "server2",
            "node_count": {"set": True, "infinite": False, "number": 1},
            "job_resources": {"nodes": {"count": 1, "list": "server2",
                               "allocation": [{"index": 0, "name": "server2"}]}},
            "gres_detail": [detail]}


def check(detail, count, expected):
    result = read(job(detail), count)
    assert result == expected, (detail, count, result)


check("gpu:a6000:2(IDX:0,2)", 2, [{"node": "server2", "gres_indices": [0, 2]}])
second = job("gpu:a6000:2(IDX:3,5)")
second["job_id"] = 54902
assert read(second, 2) == [{"node": "server2", "gres_indices": [3, 5]}]
check("gpu:4(IDX:0-2,5)", 4, [{"node": "server2", "gres_indices": [0, 1, 2, 5]}])
check("gpu:a100:2(IDX:0,2),gpu:v100:1(IDX:4),mps:10", 3,
      [{"node": "server2", "gres_indices": [0, 2, 4]}])
check("gpu:0(IDX:)", 0, [])
for detail in ("gpu:2", "gpu:2(IDX:N/A)", "gpu:2(IDX:0)", "gpu:1(IDX:0,1)",
               "gpu:2(IDX:0,0)", "gpu:2(IDX:2-0)", "gpu:2(IDX:0-1),gpu:1(IDX:1)",
               "gpu:2(IDX:0-999999999)", "gpu:2(IDX:-1,0)", "gpu:2(IDX:0,256)",
               "gpu:2(IDX:0,2", "gpu:2(IDX:0,2)),", "gpu:2(IDX:0,2),broken",
               "gpu:2(IDX:0,2),gpu:invalid", "gpu:2(IDX:0, 2)", "gpu:2(IDX:0,2:2)",
               "gpu:2(IDX:0,2),", "gpu:99999999999999999999(IDX:0,2)",
               "gpu:2(IDX:(0,2))", "", None, 1):
    check(detail, 2, None)
for count in (None, True, "2", 2.0, -1, 257, 1, 0):
    assert read(job(), count) is None

# No request or process metadata can create an allocation.
for state in (["PENDING"], ["RUNNING", "PENDING"], "PD", "COMPLETED", "FAILED", [], None):
    item = job()
    item.update(job_state=state, required_nodes="server2", batch_host="server2")
    assert read(item, 2) is None
for state in (["SUSPENDED"], ["COMPLETING"], "RUNNING+COMPLETING", "CF"):
    item = job()
    item["job_state"] = state
    assert read(item, 2) == [{"node": "server2", "gres_indices": [0, 2]}]
assert read({"job_state": "RUNNING", "gres_detail": []}, 0) == []
assert read({"job_state": "RUNNING"}, 0) == []
assert read({"job_state": "PENDING"}, 0) is None
assert read({"job_state": "RUNNING", "nodes": "server2", "gres_detail": ["gpu:2(IDX:0,2)"]}, 2) is None

# Fail closed for missing, contradictory and multi-node bindings.
for change in (
    {"nodes": "server4"}, {"nodes": "server[2-3]"}, {"node_count": 2},
    {"job_resources": {}}, {"job_resources": {"nodes": {"allocation": []}}},
    {"gres_detail": []}, {"gres_detail": ["gpu:1(IDX:0)", "gpu:1(IDX:2)"]},
):
    item = job()
    item.update(change)
    assert read(item, 2) is None, change
for field, value in (("count", 2), ("count", True), ("list", "server4")):
    item = job()
    item["job_resources"]["nodes"][field] = value
    assert read(item, 2) is None
for field, value in (("index", 1), ("name", "server2,server4"), ("name", "")):
    item = job()
    item["job_resources"]["nodes"]["allocation"][0][field] = value
    assert read(item, 2) is None
multi = job()
multi.update(nodes="server[2-3]", node_count=2, gres_detail=["gpu:1(IDX:0)", "gpu:1(IDX:2)"])
multi["job_resources"]["nodes"] = {"count": 2, "list": "server[2-3]", "allocation": [
    {"index": 0, "name": "server2"}, {"index": 1, "name": "server3"}]}
assert read(multi, 2) is None

original = job()
unchanged = copy.deepcopy(original)
read(original, 2)
assert original == unchanged
print("PASS: actual jobs 54901/54902; bounded GPU IDX ranges; typed GRES and total-count validation; inactive jobs, malformed details and ambiguous/missing node bindings fail closed.")
