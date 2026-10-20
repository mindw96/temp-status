#!/usr/bin/env python3
"""Persistent shared Job ID records; no SSH, network or installed Slurm needed."""
import importlib.util
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

BRIDGE = Path(__file__).resolve().parents[1] / "collector_bridge.py"
spec = importlib.util.spec_from_file_location("fun_job_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

for pattern, examples in {
    "repeat": ["1111", "2222", "3333", "55555", "9999999999"],
    "ascending": ["1234", "12345", "23456789"],
    "descending": ["4321", "98765", "9876543210"],
    "round": ["1000", "10000", "20000", "9000000000"],
}.items():
    for job_id in examples:
        assert bridge.fun_job_pattern(job_id) == pattern, job_id
for invalid in ["111", "123", "11111111111", "0000", "01234", "7890", "8901",
                "1221", "12321", "1001", "1234554321", "12211221",
                "1212", "1010", "123123", "1234512345",
                "12344", "12345_1", "12345_[1-20]", "12345.batch", "x1111",
                " 1111", "1111 ", "+1111", "１１１１", "", None, True, 1111, 1111.0, []]:
    assert bridge.fun_job_pattern(invalid) is None, invalid


def job(job_id, name="saved-job", user="mindw", **other):
    return {"job_id": job_id, "name": name, "user": user, **other}


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    path = root / "fun-jobs.json"
    collect = lambda jobs: bridge.collect_fun_jobs(str(path), jobs)
    empty = collect([])
    assert empty["status"] == "ok" and empty["records"] == []
    assert empty["started_at"].endswith("Z")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(Path(str(path) + ".lock").stat().st_mode) == 0o600
    first = collect([job("1111"), job("12345"), job("1111"), job(2222),
                     job("12345_1"), job("54320", job_id_aliases=["55555"])])
    assert [record["job_id"] for record in first["records"]] == ["1111", "12345", "2222"]
    assert first["started_at"] == empty["started_at"]
    assert first["records"][0]["name"] == "saved-job"
    original = path.read_bytes()
    with patch.object(bridge, "_write_fun_jobs", side_effect=AssertionError("Unneeded write")):
        repeated = collect([job("1111", name="changed"), job("12345"), job("2222")])
        gone = collect([])
    assert repeated == first and gone == first and path.read_bytes() == original

    # A fresh process must recover finished/disappeared records from disk.
    restart_script = (
        "import importlib.util,json,sys;"
        "s=importlib.util.spec_from_file_location('b',sys.argv[1]);"
        "b=importlib.util.module_from_spec(s);s.loader.exec_module(b);"
        "print(json.dumps(b.collect_fun_jobs(sys.argv[2],[])))")
    restarted = subprocess.run(
        [sys.executable, "-c", restart_script, str(BRIDGE), str(path)],
        capture_output=True, text=True, check=True)
    assert json.loads(restarted.stdout) == first and not restarted.stderr

    # Failed saves must not claim the new discovery persisted, nor erase old entries.
    with patch.object(bridge, "_write_fun_jobs", side_effect=OSError("not writable")):
        failed = collect([job("3333")])
    assert failed["status"] == "unavailable"
    assert failed["records"] == first["records"] and path.read_bytes() == original
    with patch.object(bridge.os, "replace", side_effect=OSError("atomic replace failed")):
        failed = collect([job("3333")])
    assert failed["status"] == "unavailable" and path.read_bytes() == original
    assert not list(root.glob(".fun-jobs.json.*"))
    assert bridge.collect_fun_jobs(str(root / "missing" / "archive.json"), [])["status"] == "unavailable"
    for invalid_path in ["relative.json", "", 123]:
        assert bridge.collect_fun_jobs(invalid_path, [])["status"] == "unavailable"

    class EarlierClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2000, 1, 1, tzinfo=timezone.utc)

    with patch.object(bridge, "datetime", EarlierClock):
        failed = collect([job("3333")])
    assert failed["status"] == "unavailable" and path.read_bytes() == original

    # Damaged or unsafe existing files are never automatically reset.
    for damaged in [b"{broken", b"[" * 1500,
                    json.dumps({"version": 1, "started_at": "bad", "records": []}).encode(),
                    json.dumps({"version": True, "started_at": first["started_at"], "records": []}).encode(),
                    json.dumps({"version": 1, "started_at": first["started_at"],
                                "records": first["records"] * 2}).encode()]:
        path.write_bytes(damaged)
        result = collect([job("4444")])
        assert result["status"] == "unavailable" and result["records"] == []
        assert path.read_bytes() == damaged
    path.write_bytes(original)
    path.chmod(0o644)
    assert collect([job("4444")])["status"] == "unavailable"
    assert path.read_bytes() == original
    path.chmod(0o600)
    symlink = root / "unsafe.json"
    symlink.symlink_to(path)
    assert bridge.collect_fun_jobs(str(symlink), [])["status"] == "unavailable"
    assert path.read_bytes() == original

    # A small test cap exercises the same full-archive boundary without fake IDs.
    capacity = root / "capacity.json"
    with patch.object(bridge, "MAX_FUN_JOBS", 2):
        full = bridge.collect_fun_jobs(str(capacity), [job("1111"), job("2222"), job("3333")])
        assert full["status"] == "full"
        assert [record["job_id"] for record in full["records"]] == ["1111", "2222"]
        saved = capacity.read_bytes()
        with patch.object(bridge, "_write_fun_jobs", side_effect=AssertionError("Unneeded write")):
            assert bridge.collect_fun_jobs(str(capacity), [job("3333")]) == full
        assert capacity.read_bytes() == saved

    # Only configured Slurm payloads are extended, and the original builder is called once.
    for kind, value in [("node", str(path)), ("cloud-gpu", str(path)), ("slurm", None)]:
        original_builder = lambda: {"squeue": [job("5555")]}
        agent = SimpleNamespace(build_payload=original_builder)
        bridge.install_fun_jobs(agent, kind, value)
        assert agent.build_payload is original_builder
    payload = {"sinfo": [{"name": "devbox"}], "squeue": [job("5555")]}
    calls = []

    def build():
        calls.append("build")
        return payload

    agent = SimpleNamespace(build_payload=build)
    bridge.install_fun_jobs(agent, "slurm", str(path))
    built = agent.build_payload()
    assert calls == ["build"] and built is payload
    assert built["fun_jobs"]["records"][-1]["job_id"] == "5555"
    assert built["sinfo"] == [{"name": "devbox"}] and built["squeue"] == [job("5555")]
    agent = SimpleNamespace(build_payload=lambda: None)
    bridge.install_fun_jobs(agent, "slurm", str(path))
    assert agent.build_payload() is None
    agent = SimpleNamespace(build_payload=lambda: {"squeue": []})
    bridge.install_fun_jobs(agent, "slurm", str(root / "missing" / "archive.json"))
    assert agent.build_payload() == {
        "squeue": [], "fun_jobs": {"version": 1, "status": "unavailable", "started_at": None, "records": []}}

    # Concurrent daemon/one-shot writers must merge after locking, not overwrite.
    parallel = root / "parallel.json"
    concurrent_script = """
import importlib.util,json,sys,time
s=importlib.util.spec_from_file_location('b',sys.argv[1])
b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
write=b._write_fun_jobs
def slow_write(*args):
    time.sleep(.08)
    return write(*args)
b._write_fun_jobs=slow_write
result=b.collect_fun_jobs(sys.argv[2],[{'job_id':sys.argv[3],'user':'mindw','name':'parallel'}])
assert result['status']=='ok',result
"""
    ids = ["1111", "2222", "3333", "4444", "12345"]
    processes = [subprocess.Popen(
        [sys.executable, "-c", concurrent_script, str(BRIDGE), str(parallel), job_id],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for job_id in ids]
    for process in processes:
        stdout, stderr = process.communicate(timeout=20)
        assert process.returncode == 0, (stdout, stderr)
        assert stdout == stderr == ""
    final = bridge.collect_fun_jobs(str(parallel), [])
    assert final["status"] == "ok" and len(final["records"]) == len(ids)
    assert {record["job_id"] for record in final["records"]} == set(ids)

    # The actual CLI's config path installs the hook before its one-shot POST.
    cli_archive = root / "cli.json"
    config = root / "config.json"
    config.write_text(json.dumps({
        "site_url": "https://dashboard.example", "auth_mode": "cloudflare",
        "report_token": "fake-test-credential", "fun_jobs_path": str(cli_archive)}))
    config.chmod(0o600)
    (root / "slurm_agent.py").write_text("""
import os
DASHBOARD_URL=os.environ['DASHBOARD_URL']
class Response:
    status_code=200
    def json(self): return {'ok':True}
class Session:
    headers={}
    def post(self,url,json,headers,timeout):
        assert url=='https://dashboard.example/api/report/slurm'
        assert headers=={'X-Status-Token':'fake-test-credential'}
        assert json['fun_jobs']['status']=='ok'
        assert json['fun_jobs']['records'][0]['job_id']=='55555'
        return Response()
SESSION=Session()
def request_headers(): return {'X-Status-Token':os.environ['SLURM_REPORT_TOKEN']}
def build_payload():
    return {'sinfo':[],'squeue':[{'job_id':'55555','name':'real-build','user':'mindw'}]}
""")
    cli = subprocess.run(
        [sys.executable, str(BRIDGE), "slurm", "--config", str(config),
         "--agent-dir", str(root), "--once"], capture_output=True, text=True, check=True)
    assert json.loads(cli.stdout) == {"kind": "slurm", "http_status": 200, "accepted": True}
    assert cli.stderr == "" and json.loads(cli_archive.read_text())["records"][0]["job_id"] == "55555"

    # Imported submission dates may predate collection, but import times may not.
    history = root / "history.json"
    history_archive = json.loads(cli_archive.read_text())
    historical_record = history_archive["records"][0]
    historical_record.update(source="sacct", submitted_at="2020-01-01T00:00:00Z")
    bridge._write_fun_jobs(history, history_archive)
    imported = bridge.collect_fun_jobs(str(history), [job("55555", name="changed")])
    assert imported["status"] == "ok" and imported["records"] == [historical_record]
    for invalid in [
        {"source": "other"}, {"submitted_at": "bad"},
        {"submitted_at": "2100-01-01T00:00:00Z"},
        {"submitted_at": "1969-01-01T00:00:00Z"},
        {"extra": "unknown"},
    ]:
        broken = {**history_archive, "records": [{**historical_record, **invalid}]}
        bridge._write_fun_jobs(history, broken)
        before = history.read_bytes()
        assert bridge.collect_fun_jobs(str(history), [])["status"] == "unavailable"
        assert history.read_bytes() == before
    for missing in ["source", "submitted_at"]:
        partial = {**historical_record}
        del partial[missing]
        bridge._write_fun_jobs(history, {**history_archive, "records": [partial]})
        assert bridge.collect_fun_jobs(str(history), [])["status"] == "unavailable"

print("Fun Job collector tests passed: patterns, persistence, failures, capacity and concurrent writers.")
