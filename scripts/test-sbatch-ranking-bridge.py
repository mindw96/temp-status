#!/usr/bin/env python3
"""Reading the aggregate must never interrupt ordinary node/Slurm reports."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    "bridge", Path(__file__).resolve().parents[1] / "collector_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "ranking.json"
    aggregate = {
        "version": 1, "status": "ok", "collected_at": "2026-10-20T00:00:00.000Z",
        "timezone": "Asia/Seoul", "history_start": "2026-01-01T00:00:00.000Z",
        "periods": {"today": {"top": [{"user": "mindw", "count": 1}]}},
        "private_records": [{"command": "must never leave the collector"}],
    }
    path.write_text(json.dumps(aggregate))
    path.chmod(0o644)
    for kind, value in [("node", str(path)), ("cloud-gpu", str(path)), ("slurm", None)]:
        original = lambda: {"squeue": []}
        module = SimpleNamespace(build_payload=original)
        bridge.install_sbatch_rankings(module, kind, value)
        assert module.build_payload is original
    module = SimpleNamespace(build_payload=lambda: {"sinfo": [], "squeue": []})
    bridge.install_sbatch_rankings(module, "slurm", str(path))
    result = module.build_payload()
    assert result["sinfo"] == [] and result["squeue"] == []
    assert result["sbatch_rankings"] == {
        key: value for key, value in aggregate.items() if key != "private_records"}
    # The source time stays old; receiving this report must not imply fresh counts.
    assert result["sbatch_rankings"]["collected_at"] == aggregate["collected_at"]
    path.chmod(0o666)
    assert module.build_payload()["sbatch_rankings"]["status"] == "unavailable"
    path.chmod(0o644)
    path.write_text("{broken")
    assert module.build_payload()["sbatch_rankings"]["status"] == "unavailable"
    path.write_text(" " * 65537)
    assert module.build_payload()["sbatch_rankings"]["status"] == "unavailable"
    path.unlink()
    path.symlink_to(Path(directory) / "missing")
    assert module.build_payload()["sbatch_rankings"]["status"] == "unavailable"
    module = SimpleNamespace(build_payload=lambda: None)
    bridge.install_sbatch_rankings(module, "slurm", str(path))
    assert module.build_payload() is None

print("PASS: ranking aggregate isolation, unavailable states, source time and node opt-out")
