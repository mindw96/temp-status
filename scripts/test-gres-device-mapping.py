"""Verify GRES device mapping without reading Slurm or changing physical GPUs."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


BRIDGE = Path(__file__).resolve().parents[1] / "collector_bridge.py"
spec = importlib.util.spec_from_file_location("bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def mapped(payload, config="Name=gpu File=/dev/nvidia[0-3]", error=None, kind="node"):
    agent = SimpleNamespace(build_payload=lambda: payload)
    bridge.install_slurm_gpu_mapping(agent, kind)
    with patch.object(bridge.Path, "read_text", return_value=config, side_effect=error) as read:
        result = agent.build_payload()
    assert result is payload
    return result, read.call_count


server3 = {"server_name": "ubuntu", "gpus": [
    {"id": index, "minor_number": minor, "uuid": f"GPU-{index}",
     "gpu_utilization": index * 10, "vram_total_used_mb": index + 4,
     "processes": [] if index == 0 else [{"pid": index, "username": "user"}]}
    for index, minor in enumerate((2, 3, 0, 1))]}
result, reads = mapped(copy.deepcopy(server3))
assert reads == 1
assert [gpu["slurm_gres_index"] for gpu in result["gpus"]] == [2, 3, 0, 1]
for original, actual in zip(server3["gpus"], result["gpus"]):
    assert {key: value for key, value in actual.items() if key != "slurm_gres_index"} == original

# GPU count / File ordering determine GRES indices, not the numeric minor itself.
noncontiguous = {"gpus": [{"id": 0, "minor_number": 3}, {"id": 1, "minor_number": 0},
                          {"id": 2, "minor_number": 2}]}
result, _ = mapped(noncontiguous, "Name=gpu File=/dev/nvidia[0,2-3] Count=3")
assert [gpu["slurm_gres_index"] for gpu in result["gpus"]] == [2, 0, 1]

for config, expected in (
        ("# comment\nName=gpu Type=a6000 File=/dev/nvidia[0-7] # comment", list(range(8))),
        ("AutoDetect=nvml\nName=gpu Type=a6000 File=/dev/nvidia[0-7]", list(range(8))),
        ("AutoDetect=nvidia\nName=gpu File=/dev/nvidia[0-1]", [0, 1]),
        ("Name=gpu File=/dev/nvidia0\nName=gpu File=/dev/nvidia2", [0, 2]),
        ("Name=gpu File=/dev/nvidia0,/dev/nvidia[2-3]", [0, 2, 3]),
        ("Name=gpu File=/dev/nvidia[0-1]\nName=mps Count=200 File=/dev/nvidia[0-1]", [0, 1])):
    assert bridge.slurm_gpu_minor_order(config) == expected, config

for invalid in (
        "", "# none", "AutoDetect=nvml", "Name=gpu Count=4", "Name=gpu File=/dev/nvidia[0-3] Count=3",
        "Name=gpu File=/dev/nvidia[0-3] Count=4.0", "Name=gpu File=/dev/nvidia[0-3] Count=4K",
        "Name=gpu File=/dev/nvidia[0-3] Count=0", "Name=gpu File=/dev/nvidia[0-3] Count=-4",
        "Name=gpu File=/dev/nvidia[0-3] Count=4 Count=4",
        "Name=gpu File=/dev/nvidia[0-3]\nInclude /etc/slurm/extra-gres.conf",
        "Include=/etc/slurm/extra-gres.conf\nName=gpu File=/dev/nvidia[0-3]",
        "NodeName=server[1-4] Name=gpu File=/dev/nvidia[0-3]",
        "Name=gpu File=/dev/nvidia[0-3] MultipleFiles=/dev/nvidia-caps/nvidia-cap0",
        "Name=gpu MultipleFiles=/dev/nvidia-caps/nvidia-cap[0-3]",
        "Name=gpu File=/dev/nvidia[0-3] Flags=CountOnly",
        "Name=gpu File=/dev/nvidia[0-3]\nName=gpu Count=2",
        "Name=gpu File=/dev/nvidia[0-3]\nName=gpu File=/dev/nvidia3",
        "Name=gpu File=/dev/nvidia[0-3]\nName=gpu File=/dev/nvidia1",
        "Name=gpu File=/dev/nvidia[0,1,1,3]", "Name=gpu File=/dev/nvidia[3-0]",
        "Name=gpu File=/dev/nvidia[0,2,1,3]", "Name=gpu File=/dev/nvidia[0--3]",
        "Name=gpu File=/dev/nvidia[0,,3]", "Name=gpu File=/dev/nvidia[0-999999999999]",
        "Name=gpu File=/dev/nvidia[0-256]", "Name=gpu File=/dev/nvidia[0-3", "Name=gpu File=/dev/nvidia0oops",
        "Name=gpu File=/dev/dri/renderD[0-3]", 'Name=gpu File="/dev/nvidia[0-3]',
        "AutoDetect=rsmi\nName=gpu File=/dev/nvidia[0-3]", None):
    assert bridge.slurm_gpu_minor_order(invalid) is None, invalid
    payload = copy.deepcopy(server3)
    for gpu in payload["gpus"]:
        gpu["slurm_gres_index"] = 123
    result, _ = mapped(payload, invalid)
    assert all("slurm_gres_index" not in gpu for gpu in result["gpus"]), invalid

# Unknown or duplicate node readings cannot produce a partial/ambiguous map.
for minors in ((0, 1, 2), (0, 1, 2, 4), (0, 1, 2, 2), (0, 1, 2, None),
               (0, 1, 2, True), (0, 1, 2, -1), (0, 1, 2, 3.5),
               (0, 1, 2, float("inf")), (0, 1, 2, "not known"), (0, 1, 2, {})):
    payload = {"gpus": [{"id": i, "minor_number": minor, "slurm_gres_index": 99}
                        for i, minor in enumerate(minors)]}
    result, _ = mapped(payload)
    assert all("slurm_gres_index" not in gpu for gpu in result["gpus"]), minors

for error in (FileNotFoundError(), PermissionError(), UnicodeError()):
    payload = copy.deepcopy(server3)
    for gpu in payload["gpus"]:
        gpu["slurm_gres_index"] = 99
    result, _ = mapped(payload, error=error)
    assert all("slurm_gres_index" not in gpu for gpu in result["gpus"])

# Every report re-reads configuration and removes an obsolete successful map.
payload = copy.deepcopy(server3)
agent = SimpleNamespace(build_payload=lambda: payload)
bridge.install_slurm_gpu_mapping(agent, "node")
with patch.object(bridge.Path, "read_text", side_effect=["Name=gpu File=/dev/nvidia[0-3]", "AutoDetect=nvml"]) as read:
    assert all("slurm_gres_index" in gpu for gpu in agent.build_payload()["gpus"])
    assert all("slurm_gres_index" not in gpu for gpu in agent.build_payload()["gpus"])
    assert read.call_count == 2

for kind in ("slurm", "cloud-gpu"):
    payload = copy.deepcopy(server3)
    result, reads = mapped(payload, kind=kind)
    assert result == server3 and reads == 0
for payload in (None, {}, {"test_payload": True}, {"gpus": None}):
    _, reads = mapped(payload)
    assert reads == 0

print("GRES device mapping tests passed")
