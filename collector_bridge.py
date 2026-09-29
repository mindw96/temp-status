"""Run an existing status agent against Lattice without editing its source.

Keep the JSON credential file readable only by its owner (chmod 600).
This wrapper is opt-in; it does not install services or edit existing agents.
"""
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys
from urllib.parse import urlparse


def slurm_number(value):
    """Read Slurm's optional numeric value without treating its set flag as data."""
    if isinstance(value, dict):
        if value.get("set") is not True or value.get("infinite") is not False:
            return None
        value = value.get("number")
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def slurm_identity(value):
    if isinstance(value, dict):
        value = slurm_number(value)
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value < 0 or int(value) != value:
            return ""
        return str(int(value))
    return str(value).strip()


def slurm_job_identities(job):
    """Only exact job IDs, SLUIDs and individual array task IDs are aliases."""
    step = job.get("step_id")
    step = step if isinstance(step, dict) else {}
    identities = {slurm_identity(value) for value in (
        job.get("job_id"), job.get("sluid"), step.get("sluid"), step.get("job_id"))}
    array_id, task_id = slurm_number(job.get("array_job_id")), slurm_number(job.get("array_task_id"))
    if (array_id is not None and array_id > 0 and array_id.is_integer()
            and task_id is not None and task_id.is_integer() and task_id < 4294967294):
        identities.add(f"{int(array_id)}_{int(task_id)}")
    elif array_id is not None and array_id > 0 and array_id.is_integer():
        task_range = job.get("array_task_string")
        if isinstance(task_range, str) and re.fullmatch(r"\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*(?:%\d+)?", task_range):
            identities.add(f"{int(array_id)}_[{task_range}]")
    return identities - {""}


def slurm_gpu_count(tres):
    """Read total GPU TRES without counting generic and typed totals twice."""
    if not isinstance(tres, str):
        return None
    counts = {}
    for entry in tres.split(","):
        key, separator, value = entry.strip().partition("=")
        key, value = key.strip(), value.strip()
        if key != "gres/gpu" and not key.startswith("gres/gpu:"):
            continue
        # A duplicate or malformed GPU entry makes this total ambiguous. Do not
        # substitute a partial sum or turn unavailable data into zero GPUs.
        if (not re.fullmatch(r"gres/gpu(?::[^\s,=]+)?", key)
                or separator != "=" or not re.fullmatch(r"[0-9]+", value)
                or key in counts):
            return None
        try:
            counts[key] = int(value)
        except ValueError:
            return None
    if "gres/gpu" in counts:
        return counts["gres/gpu"]
    return sum(counts.values()) if counts else None




MAX_GPU_INDICES = 256
_NODE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_ACTIVE_STATES = {"RUNNING", "R", "SUSPENDED", "S", "COMPLETING", "CG",
                  "CONFIGURING", "CF", "STAGE_OUT", "SO"}


def _allocation_integer(value):
    if isinstance(value, dict):
        if value.get("set") is not True or value.get("infinite") is not False:
            return None
        value = value.get("number")
    return value if type(value) is int and value >= 0 else None


def _allocation_active(job):
    state = job.get("job_state")
    states = state if isinstance(state, list) else re.split(r"[+,\s]+", state or "") if isinstance(state, str) else []
    states = {value.upper() for value in states if isinstance(value, str)}
    return bool(states & _ACTIVE_STATES) and not bool(states & {"PENDING", "PD"})


def _allocation_single_allocated_node(job):
    """A single allocated node has no ambiguous GRES-detail-to-node ordering."""
    resources = job.get("job_resources")
    resources = resources if isinstance(resources, dict) else {}
    nodes = resources.get("nodes")
    nodes = nodes if isinstance(nodes, dict) else {}
    allocation = nodes.get("allocation")
    if not isinstance(allocation, list) or len(allocation) != 1:
        return None
    entry = allocation[0]
    name = entry.get("name") if isinstance(entry, dict) else None
    if not isinstance(name, str) or not _NODE_NAME.fullmatch(name):
        return None
    # These fields all describe the allocation, never required_nodes/batch_host.
    for count in (nodes.get("count"), job.get("node_count")):
        if count is not None and _allocation_integer(count) != 1:
            return None
    for listed in (nodes.get("list"), job.get("nodes")):
        if listed is not None and listed != name:
            return None
    if entry.get("index") is not None and _allocation_integer(entry["index"]) != 0:
        return None
    return name


def _allocation_split_gres(text):
    """Split GRES entries without splitting commas inside an IDX bitmap."""
    if not isinstance(text, str) or len(text) > 16384:
        return None
    depth, start, entries = 0, 0, []
    for index, char in enumerate(text):
        if char == "(":
            depth += 1
            if depth > 1:
                return None
        elif char == ")":
            depth -= 1
            if depth < 0:
                return None
        elif char == "," and depth == 0:
            entries.append(text[start:index].strip())
            start = index + 1
    if depth:
        return None
    entries.append(text[start:].strip())
    return entries


def _allocation_gpu_indices(text):
    entries = _allocation_split_gres(text)
    if not entries:
        return None
    selected = set()
    for entry in entries:
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_/-]*)(?::([^:(),\s]+))?:(\d+)(?:\(([^()]*)\))?", entry)
        if match is None:
            return None
        if match[1] != "gpu":
            continue
        if len(match[3]) > 4:
            return None
        count = int(match[3])
        if count > MAX_GPU_INDICES or match[4] is None or not match[4].startswith("IDX:"):
            return None
        bitmap = match[4][4:]
        group = set()
        if not bitmap and count == 0:
            continue
        for item in bitmap.split(","):
            part = re.fullmatch(r"(\d{1,4})(?:-(\d{1,4}))?", item)
            if part is None:
                return None
            first, last = int(part[1]), int(part[2] or part[1])
            if first > last or last >= MAX_GPU_INDICES:
                return None
            for index in range(first, last + 1):
                if index in group or index in selected:
                    return None
                group.add(index)
        if len(group) != count:
            return None
        selected.update(group)
    return sorted(selected)


def slurm_gpu_allocations(job, allocated_gpus):
    """Return [{node, gres_indices}], [] for explicit zero, or None if unknown.

    allocated_gpus is the validated AllocTRES GPU total from the caller. A
    request count, process count or bare node name cannot identify allocated
    devices. Multi-node details are intentionally not zipped to node names:
    older/newer Slurm schemas can omit node slots without naming their owner.
    """
    if (not isinstance(job, dict) or not _allocation_active(job)
            or type(allocated_gpus) is not int or not 0 <= allocated_gpus <= MAX_GPU_INDICES):
        return None
    details = job.get("gres_detail")
    if allocated_gpus == 0 and details in (None, []):
        return []
    node = _allocation_single_allocated_node(job)
    if node is None or not isinstance(details, list) or len(details) != 1:
        return None
    indices = _allocation_gpu_indices(details[0])
    if indices is None or len(indices) != allocated_gpus:
        return None
    return [{"node": node, "gres_indices": indices}] if indices else []


def slurm_job_request(job):
    """Keep requested and allocated TRES separate and retain minimum RAM scope."""
    tres = job.get("tres_req_str")
    fields = dict(re.findall(r"(?:^|,)\s*(cpu|mem)=([^,\s]+)", tres)) if isinstance(tres, str) else {}
    result = {}
    cpus = slurm_number(fields.get("cpu"))
    if cpus is None or not cpus.is_integer():
        cpus = slurm_number(job.get("cpus"))
    if cpus is not None and cpus.is_integer():
        result["req_cpus"] = str(int(cpus))
    for field, source in (("req_gpus", "tres_req_str"), ("alloc_gpus", "tres_alloc_str")):
        gpus = slurm_gpu_count(job.get(source))
        if gpus is not None:
            result[field] = str(gpus)

    node_memory = slurm_number(job.get("memory_per_node"))
    cpu_memory = slurm_number(job.get("memory_per_cpu"))
    # --mem=0 requests all memory on each node, rather than zero job memory.
    if node_memory == 0:
        result.update(req_mem="0M", req_mem_scope="node")
    else:
        memory = fields.get("mem", "")
        if re.fullmatch(r"\d+(?:\.\d+)?[KMGTPE]?", memory, re.IGNORECASE):
            result.update(req_mem=memory.upper() if re.search(r"[A-Za-z]", memory) else memory + "M",
                          req_mem_scope="total")
        elif node_memory is not None:
            result.update(req_mem=f"{node_memory:g}M", req_mem_scope="node")
        elif cpu_memory is not None:
            result.update(req_mem=f"{cpu_memory:g}M", req_mem_scope="cpu")
    allocations = slurm_gpu_allocations(job, slurm_gpu_count(job.get("tres_alloc_str")))
    if allocations is not None:
        result["gpu_allocations"] = allocations
    return result


def install_slurm_job_requests(module, kind):
    """Fill requests in one bulk query, including jobs beyond the source's cap."""
    if kind != "slurm" or not callable(getattr(module, "run_slurm_json", None)):
        return
    original_build_payload = module.build_payload

    def build_payload():
        payload = original_build_payload()
        jobs = payload.get("squeue") if isinstance(payload, dict) else None
        if not isinstance(jobs, list) or not jobs:
            return payload
        try:
            report = module.run_slurm_json(["squeue", "--json"], quiet=True)
        except Exception:
            return payload
        if not isinstance(report, dict) or report.get("errors") or not isinstance(report.get("jobs"), list):
            return payload
        by_id = {}
        for raw_job in report["jobs"]:
            if not isinstance(raw_job, dict):
                continue
            for identity in slurm_job_identities(raw_job):
                # Do not choose one job when the producer gives ambiguous IDs.
                by_id[identity] = None if identity in by_id else raw_job
        for job in jobs:
            if not isinstance(job, dict):
                continue
            # Source aliases can contain an array parent for an aggregate/sibling.
            # Match the displayed ID itself, never those inferred parent aliases.
            raw_job = by_id.get(slurm_identity(job.get("job_id")))
            if raw_job is not None:
                job.update(slurm_job_request(raw_job))
        return payload

    module.build_payload = build_payload


def install_storage_reporting(module, kind):
    """Attach monitored paths and cloud free space without editing source agents."""
    if kind not in ("node", "cloud-gpu"):
        return
    original_build_payload = module.build_payload

    def build_payload():
        payload = original_build_payload()
        if not isinstance(payload, dict):
            return payload
        if kind == "node":
            # Preserve the original psutil readings, including available space.
            for field, attribute in (("disk_path", "DISK_PATH"),
                                     ("subdisk_path", "SUBDISK_PATH")):
                path = getattr(module, attribute, None)
                if isinstance(path, str) and path:
                    payload[field] = path
            return payload

        system = payload.get("system")
        if not isinstance(system, dict):
            return payload
        path = getattr(module, "DISK_PATH", system.get("disk_path"))
        if not isinstance(path, str) or not path:
            return payload
        system["disk_path"] = path
        try:
            usage = shutil.disk_usage(path)
        except OSError:
            # A failed new reading must not masquerade as available capacity.
            for field in ("total_disk_gb", "used_disk_gb", "free_disk_gb", "disk_percent"):
                system[field] = None
        else:
            # Linux shutil.free uses f_bavail: total - used would include blocks
            # reserved for the administrator and overstate usable capacity.
            system.update({
                "total_disk_gb": round(usage.total / 1024 ** 3, 1),
                "used_disk_gb": round(usage.used / 1024 ** 3, 1),
                "free_disk_gb": round(usage.free / 1024 ** 3, 1),
                "disk_percent": round(100 * usage.used / (usage.used + usage.free), 1)
                if usage.used + usage.free else 0,
            })
        return payload

    module.build_payload = build_payload


def slurm_gpu_minor_order(config):
    """Read an unambiguous explicit NVIDIA File order from the local GRES file.

    GRES indices enumerate configured devices; they are not NVML GPU indices.
    Unsupported conditional, included, MIG or count-only configurations are left
    unavailable rather than assigning ownership to a guessed physical device.
    """
    if not isinstance(config, str):
        return None
    minors = []
    for line in config.splitlines():
        try:
            tokens = shlex.split(line, comments=True)
        except ValueError:
            return None
        if not tokens:
            continue
        fields = {}
        for token in tokens:
            key, separator, value = token.partition("=")
            key = key.lower()
            if separator != "=" or not key or not value or key in fields:
                return None
            fields[key] = value
        if "include" in fields or "nodename" in fields:
            return None
        if "autodetect" in fields and fields["autodetect"].lower() not in ("off", "nvml", "nvidia"):
            return None
        if fields.get("name", "").lower() != "gpu":
            continue
        if ("multiplefiles" in fields or "file" not in fields
                or "countonly" in fields.get("flags", "").lower().split(",")):
            return None
        devices = fields["file"]
        files = list(re.finditer(r"/dev/nvidia(\d+|\[[0-9,-]+\])", devices))
        if not files or ",".join(match.group() for match in files) != devices:
            return None
        line_minors = []
        for match in files:
            expression = match.group(1).strip("[]")
            for item in expression.split(","):
                values = item.split("-")
                if (len(values) not in (1, 2) or any(not re.fullmatch(r"[0-9]+", value) for value in values)
                        or any(len(value) > 5 for value in values)):
                    return None
                start, end = int(values[0]), int(values[-1])
                if not 0 <= start <= end <= 65535 or end - start >= 256:
                    return None
                line_minors.extend(range(start, end + 1))
                if len(line_minors) > 256:
                    return None
        count = fields.get("count")
        if count is not None and (not re.fullmatch(r"[0-9]{1,3}", count) or int(count) != len(line_minors)):
            return None
        minors.extend(line_minors)
        if len(minors) > 256:
            return None
    # Slurm requires device File entries in increasing numeric order. A changed
    # or unsupported configuration must not silently reshuffle existing jobs.
    if not minors or any(previous >= current for previous, current in zip(minors, minors[1:])):
        return None
    return minors


def install_slurm_gpu_mapping(module, kind):
    """Attach the verified GRES index while retaining the agent's NVML identity."""
    if kind != "node":
        return
    original_build_payload = module.build_payload

    def build_payload():
        payload = original_build_payload()
        gpus = payload.get("gpus") if isinstance(payload, dict) else None
        if not isinstance(gpus, list):
            return payload
        for gpu in gpus:
            if isinstance(gpu, dict):
                gpu.pop("slurm_gres_index", None)
        try:
            minors = slurm_gpu_minor_order(Path("/etc/slurm/gres.conf").read_text())
        except (OSError, UnicodeError):
            return payload
        if minors is None or len(minors) != len(gpus):
            return payload
        by_minor = {}
        for gpu in gpus:
            if not isinstance(gpu, dict):
                return payload
            minor = slurm_number(gpu.get("minor_number"))
            if minor is None or not minor.is_integer() or minor in by_minor:
                return payload
            by_minor[int(minor)] = gpu
        if set(by_minor) != set(minors):
            return payload
        for index, minor in enumerate(minors):
            by_minor[minor]["slurm_gres_index"] = index
        return payload

    module.build_payload = build_payload


def install_report_backoff(module, interval):
    """Let the original agent loop slow down on failed or quota-limited posts."""
    original_post = module.SESSION.post
    failures = 0

    def post(*args, **kwargs):
        nonlocal failures
        try:
            response = original_post(*args, **kwargs)
        except Exception:
            failures += 1
            module.REPORT_INTERVAL_SEC = min(300, interval * 2 ** min(failures, 8))
            raise
        if 200 <= response.status_code < 300:
            failures = 0
            module.REPORT_INTERVAL_SEC = interval
        else:
            failures += 1
            try:
                retry_after = float(getattr(response, 'headers', {}).get('Retry-After', 0))
            except (TypeError, ValueError):
                retry_after = 0
            if not math.isfinite(retry_after):
                retry_after = 0
            module.REPORT_INTERVAL_SEC = max(interval, min(300, max(
                retry_after, interval * 2 ** min(failures, 8))))
        return response

    module.SESSION.post = post


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("node", "slurm", "cloud-gpu"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--agent-dir", default="/home/mindw/status_agent")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    config_path = Path(args.config)
    if stat.S_IMODE(config_path.stat().st_mode) & 0o077:
        parser.error("Credential file must have mode 600")
    config = json.loads(config_path.read_text())
    base_url = config["site_url"].rstrip("/")
    url = urlparse(base_url)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path:
        parser.error("site_url must be an HTTPS origin")
    auth_mode = config.get("auth_mode", "sites")
    if auth_mode not in ("sites", "cloudflare"):
        parser.error("auth_mode must be sites or cloudflare")
    required_keys = ("report_token", "sites_bypass_token") if auth_mode == "sites" else ("report_token",)
    for key in required_keys:
        if not isinstance(config.get(key), str) or not config[key]:
            parser.error(f"Missing {key}")
    interval = config.get('report_interval_sec', 15 if auth_mode == 'cloudflare' else 5)
    if (isinstance(interval, bool) or not isinstance(interval, (int, float))
            or not math.isfinite(interval) or not 1 <= interval <= 300):
        parser.error('report_interval_sec must be a number from 1 to 300')
    os.environ['REPORT_INTERVAL_SEC'] = str(interval)
    os.environ["DASHBOARD_URL"] = base_url + "/api/report/" + args.kind
    for key in ("NODE_REPORT_TOKEN", "SLURM_REPORT_TOKEN", "STATUS_REPORT_TOKEN"):
        os.environ[key] = config["report_token"]
    if args.kind == "cloud-gpu":
        os.environ["CLOUD_GPU_REPORT_TOKEN"] = config["report_token"]
        if config.get("disk_path"):
            os.environ["DISK_PATH"] = config["disk_path"]
    os.environ["REQUIRE_REPORT_TOKEN"] = "1"
    # This dashboard displays active jobs. Do not run redundant seven-day accounting queries.
    os.environ["ENABLE_SACCT"] = "0"
    if config.get("server_name"):
        os.environ["SERVER_NAME"] = config["server_name"]
    agent_files = {"node": "agent.py", "slurm": "slurm_agent.py", "cloud-gpu": "cloud_gpu_agent.py"}
    agent_path = Path(args.agent_dir) / agent_files[args.kind]
    spec = importlib.util.spec_from_file_location("lattice_source_agent", agent_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    install_storage_reporting(module, args.kind)
    install_slurm_gpu_mapping(module, args.kind)
    install_slurm_job_requests(module, args.kind)
    if auth_mode == "sites":
        module.SESSION.headers.update({"OAI-Sites-Authorization": "Bearer " + config["sites_bypass_token"]})
    if args.once:
        payload = module.build_payload()
        if payload is None:
            print("Collection failed", file=sys.stderr)
            return 1
        result = module.SESSION.post(module.DASHBOARD_URL, json=payload, headers=module.request_headers(), timeout=20)
        try:
            accepted = result.status_code == 200 and result.json().get("ok") is True
        except ValueError:
            accepted = False
        print(json.dumps({"kind": args.kind, "http_status": result.status_code, "accepted": accepted}))
        return 0 if accepted else 1
    install_report_backoff(module, interval)
    module.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
