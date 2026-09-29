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


def slurm_job_request(job):
    """Prefer aggregate requested TRES; retain the scope of minimum RAM requests."""
    tres = job.get("tres_req_str")
    fields = dict(re.findall(r"(?:^|,)\s*(cpu|mem)=([^,\s]+)", tres)) if isinstance(tres, str) else {}
    result = {}
    cpus = slurm_number(fields.get("cpu"))
    if cpus is None or not cpus.is_integer():
        cpus = slurm_number(job.get("cpus"))
    if cpus is not None and cpus.is_integer():
        result["req_cpus"] = str(int(cpus))

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
