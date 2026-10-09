#!/usr/bin/env python3
"""Read namespace GPU jobs and push a minimal snapshot; Python 3.8 stdlib only.

No workload logs, container environment, commands, or kubeconfig are published.
Only containers explicitly requesting GPUs are queried. UUIDs identify devices;
container-local GPU indices are deliberately omitted.
"""
import argparse
import concurrent.futures
import copy
import csv
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
import fcntl
import io
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


GPU_RESOURCE = "nvidia.com/gpu"
DEFAULT_ENDPOINT = "https://status.nlp.io.kr/api/a100/report"
PUBLIC_ERRORS = {"quota_unavailable", "storage_unavailable", "jobs_unavailable",
                 "pods_unavailable", "gpu_metrics_unavailable", "collection_timeout",
                 "collection_failed"}
ENV_NAMES = {"A100_REPORT_TOKEN", "A100_REPORT_URL", "A100_NAMESPACE",
             "A100_INTERVAL_SECONDS", "A100_STORAGE_INTERVAL_SECONDS",
             "A100_COMMAND_TIMEOUT_SECONDS", "A100_QUOTA_USER",
             "A100_GPFS_FILESYSTEM"}
QUANTITY = re.compile(r"^([+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))(n|u|m|k|K|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?[0-9]+)?$")
SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,253}$")
STOP = threading.Event()
CLOCK_OFFSET_SECONDS = 0.0


def utc_now():
    return datetime.fromtimestamp(time.time() + CLOCK_OFFSET_SECONDS, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def quantity(value):
    """Kubernetes Quantity in base units (cores or bytes); None for malformed."""
    if isinstance(value, bool) or value is None:
        return None
    match = QUANTITY.fullmatch(str(value))
    if not match:
        return None
    try:
        number, suffix = Decimal(match[1]), match[2] or ""
        binary = {"Ki": 10, "Mi": 20, "Gi": 30, "Ti": 40, "Pi": 50, "Ei": 60}
        decimal = {"n": -9, "u": -6, "m": -3, "": 0, "k": 3, "K": 3,
                   "M": 6, "G": 9, "T": 12, "P": 15, "E": 18}
        if suffix in binary:
            number *= Decimal(2) ** binary[suffix]
        elif suffix in decimal:
            number *= Decimal(10) ** decimal[suffix]
        else:
            exponent = int(suffix[1:])
            if abs(exponent) > 30:
                return None
            number *= Decimal(10) ** exponent
        if not number.is_finite() or number < 0 or number > 2 ** 63:
            return None
        return int(number) if number == int(number) else float(number)
    except (InvalidOperation, ValueError, OverflowError):
        return None


def resource(container, key):
    resources = container.get("resources") or {}
    requests, limits = resources.get("requests") or {}, resources.get("limits") or {}
    # Kubernetes defaults an omitted request to an explicit limit. Zero remains zero.
    return quantity(requests.get(key, limits.get(key, 0)))


def pod_resource(spec, key):
    containers = spec.get("containers") or []
    values = [resource(container, key) for container in containers]
    init = [resource(container, key) for container in spec.get("initContainers") or []]
    overhead = quantity((spec.get("overhead") or {}).get(key, 0))
    if any(value is None for value in values + init + [overhead]):
        return None
    return max([sum(values)] + init) + overhead


def owner_of(obj):
    metadata = obj.get("metadata") or {}
    labels = metadata.get("labels") or {}
    for key in ("owner", "student"):
        owner = labels.get(key)
        if isinstance(owner, str) and SAFE_ID.fullmatch(owner):
            return owner
    return None


def safe_reason(value):
    return value if isinstance(value, str) and SAFE_ID.fullmatch(value) else None


def pod_summary(pod):
    status = pod.get("status") or {}
    restarts = sum(int(container.get("restartCount") or 0)
                   for container in (status.get("containerStatuses") or [])
                   + (status.get("initContainerStatuses") or []))
    return {"name": pod["metadata"]["name"], "phase": status.get("phase", "Unknown"),
            "restarts": restarts}


def pod_reason(pod):
    status = pod.get("status") or {}
    for container in (status.get("initContainerStatuses") or []) + (status.get("containerStatuses") or []):
        state = container.get("state") or {}
        for kind in ("waiting", "terminated"):
            reason = safe_reason((state.get(kind) or {}).get("reason"))
            if reason and reason != "Completed":
                return reason
    return safe_reason(status.get("reason"))


def job_state(job, pods):
    status = job.get("status") or {}
    conditions = [item for item in status.get("conditions") or [] if item.get("status") == "True"]
    for condition, state in (("Complete", "Succeeded"), ("Failed", "Failed"), ("Suspended", "Suspended")):
        for item in conditions:
            if item.get("type") == condition:
                return state, safe_reason(item.get("reason"))
    if (job.get("spec") or {}).get("suspend"):
        return "Suspended", None
    phases = {(pod.get("status") or {}).get("phase") for pod in pods}
    if "Running" in phases:
        return "Running", next((pod_reason(p) for p in pods
                                if (p.get("status") or {}).get("phase") in {"Running", "Pending"}
                                and pod_reason(p)), None)
    if not pods:
        return "Pending", "WaitingForPod"
    if "Pending" in phases:
        return "Pending", next((pod_reason(p) for p in pods
                                if (p.get("status") or {}).get("phase") == "Pending"
                                and pod_reason(p)), None)
    # A failed attempt can be retried, and a successful attempt may be one of
    # several completions. Job conditions are authoritative for terminal states.
    if phases <= {"Failed", "Succeeded"}:
        return "Pending", "WaitingForJobController"
    return "Unknown", None


def gpu_targets(pods):
    targets = []
    for pod in pods:
        if (pod.get("status") or {}).get("phase") != "Running":
            continue
        status = pod.get("status") or {}
        states = {item.get("name"): item for item in
                  (status.get("containerStatuses") or []) + (status.get("initContainerStatuses") or [])}
        spec = pod.get("spec") or {}
        for container in (spec.get("containers") or []) + (spec.get("initContainers") or []):
            count = resource(container, GPU_RESOURCE)
            current = (states.get(container.get("name")) or {}).get("state") or {}
            if count is not None and count > 0 and "running" in current:
                targets.append((pod["metadata"]["name"], container["name"], int(count)))
    return targets


def make_jobs(job_items, pod_items):
    """Include Jobs before their first Pod, plus standalone interactive Pods."""
    by_uid, by_name, attached = {}, {}, set()
    for job in job_items:
        metadata = job.get("metadata") or {}
        by_uid[metadata.get("uid")] = job
        by_name[metadata.get("name")] = job
    grouped = {id(job): [] for job in job_items}
    for pod in pod_items:
        metadata = pod.get("metadata") or {}
        refs = [r for r in metadata.get("ownerReferences") or [] if r.get("kind") == "Job"]
        job = next((by_uid[r.get("uid")] for r in refs if r.get("uid") in by_uid), None)
        if job is None:
            # Name fallback only when no owner UID was supplied, never across a
            # deleted-and-recreated Job with the same name.
            name = (metadata.get("labels") or {}).get("job-name")
            if not refs:
                job = by_name.get(name)
        if job is not None:
            grouped[id(job)].append(pod)
            attached.add(id(pod))
    output, targets = [], {}
    objects = [(job, grouped[id(job)], True) for job in job_items]
    objects += [(pod, [pod], False) for pod in pod_items if id(pod) not in attached]
    for obj, pods, is_job in objects:
        meta, spec = obj.get("metadata") or {}, obj.get("spec") or {}
        template = spec.get("template") or {} if is_job else {}
        pod_spec = template.get("spec") or {} if is_job else spec
        parallelism = max(0, int(spec.get("parallelism", 1))) if is_job else 1
        completions = spec.get("completions") if is_job else None
        if completions is not None:
            parallelism = min(parallelism, max(0, int(completions)))
        if is_job:
            state, reason = job_state(obj, pods)
        else:
            state = (obj.get("status") or {}).get("phase", "Unknown")
            state = state if state in {"Running", "Pending", "Succeeded", "Failed", "Unknown"} else "Unknown"
            reason = pod_reason(obj)
        owner = owner_of(obj) or owner_of(template)
        if not owner:
            owners = {owner_of(p) for p in pods} - {None}
            owner = next(iter(owners)) if len(owners) == 1 else None
        resources = [pod_resource(pod_spec, key) for key in (GPU_RESOURCE, "cpu", "memory")]
        resources = [value * parallelism if value is not None else None for value in resources]
        status = obj.get("status") or {}
        pod_finishes = [((item.get("state") or {}).get("terminated") or {}).get("finishedAt")
                        for item in status.get("containerStatuses") or []] if not is_job else []
        pod_finishes = [item for item in pod_finishes if item]
        starts = [(p.get("status") or {}).get("startTime") for p in pods]
        starts = [item for item in starts if item]
        nodes = sorted({(p.get("spec") or {}).get("nodeName") for p in pods} - {None, ""})
        job_id = meta.get("uid") or (("job:" if is_job else "pod:") + meta["name"])
        # Job startTime includes quota waiting; only a Pod startTime represents
        # the start of an attempt. A no-Pod queued Job has no start timestamp.
        output.append({"id": job_id, "name": meta["name"], "owner": owner,
                       "status": state, "reason": reason, "requested_gpus": resources[0],
                       "cpu_requested": resources[1], "ram_requested_bytes": resources[2],
                       "created_at": meta.get("creationTimestamp"),
                       "started_at": min(starts) if starts else None,
                       "finished_at": status.get("completionTime") or next((c.get("lastTransitionTime") for c in status.get("conditions") or [] if c.get("type") == "Failed" and c.get("status") == "True"), None) or (max(pod_finishes) if pod_finishes and state in {"Succeeded", "Failed"} else None),
                       "node": ", ".join(nodes) if nodes else None,
                       "pods": [pod_summary(p) for p in pods], "gpus": [], "metrics_error": None})
        if state == "Running":
            targets[job_id] = gpu_targets(pods)
    output.sort(key=lambda job: (job["created_at"] or "", job["name"]), reverse=True)
    return output, targets


def parse_gpu_csv(text, expected, pod, container, collected_at):
    rows = []
    for fields in csv.reader(io.StringIO(text)):
        if not fields or not any(value.strip() for value in fields):
            continue
        if len(fields) != 5:
            raise ValueError("gpu_metrics_unavailable")
        uuid, name, utilization, used, total = [value.strip() for value in fields]
        if not re.fullmatch(r"(?:GPU|MIG)-[A-Za-z0-9_./-]{1,150}", uuid):
            raise ValueError("gpu_metrics_unavailable")
        values = []
        for value in (utilization, used, total):
            try:
                number = float(value)
                values.append(number if math.isfinite(number) and number >= 0 else None)
            except ValueError:
                values.append(None)
        if values[0] is not None and values[0] > 100:
            values[0] = None
        if values[2] is not None and values[2] <= 0:
            values[2] = None
        rows.append({"uuid": uuid, "name": name[:120], "utilization_pct": values[0],
                     "memory_used_mib": values[1], "memory_total_mib": values[2],
                     "collected_at": collected_at, "pod": pod, "container": container})
    # A CPU-only container can see every host GPU on this cluster. Even a GPU
    # container must match its request before metrics can be attributed safely.
    if len(rows) != expected or len({row["uuid"] for row in rows}) != len(rows):
        raise ValueError("gpu_metrics_unavailable")
    return rows


def parse_gpfs_quota(text, user, filesystem, collected_at):
    header = None
    for line in text.splitlines():
        fields = line.split(":")
        if len(fields) > 3 and fields[:3] == ["mmlsquota", "user", "HEADER"]:
            header = fields
        elif header and fields[:2] == ["mmlsquota", "user"]:
            row = dict(zip(header, fields))
            if row.get("name") != user or row.get("filesystemName") != filesystem:
                continue
            used, limit = quantity(row.get("blockUsage")), quantity(row.get("blockLimit"))
            if used is None or limit is None or limit <= 0:
                raise ValueError("storage_unavailable")
            return {"used_bytes": int(used * 1024), "limit_bytes": int(limit * 1024),
                    "collected_at": collected_at, "error": None}
    raise ValueError("storage_unavailable")


def bound_jobs(jobs):
    """Bound public history without ever silently dropping an active workload."""
    active = [job for job in jobs if job["status"] not in {"Succeeded", "Failed"}]
    completed = [job for job in jobs if job["status"] in {"Succeeded", "Failed"}]
    if len(active) > 500:
        raise CollectionError("jobs_unavailable")
    selected = active + completed[:500 - len(active)]
    for job in selected:
        current = [pod for pod in job["pods"] if pod["phase"] not in {"Succeeded", "Failed"}]
        previous = [pod for pod in job["pods"] if pod["phase"] in {"Succeeded", "Failed"}]
        if len(current) > 64 or len(job["gpus"]) > 64:
            raise CollectionError("jobs_unavailable")
        job["pods"] = current + previous[:64 - len(current)]
    # Leave room for the envelope/quota/storage beneath the receiver's 1 MiB cap.
    while len(json.dumps(selected, ensure_ascii=True).encode("utf-8")) > 900000:
        if len(selected) <= len(active):
            raise CollectionError("jobs_unavailable")
        selected.pop()
    return selected


class CollectionError(Exception):
    pass


class Collector:
    def __init__(self, namespace="nlp-lab", quota_user="nlp-lab", filesystem="gpfsai",
                 timeout=10, storage_interval=300, runner=None):
        self.namespace, self.quota_user, self.filesystem = namespace, quota_user, filesystem
        self.timeout, self.storage_interval = timeout, storage_interval
        self.runner = runner or self.run
        self.previous_jobs, self.jobs_collected_at = [], None
        self.storage = {"used_bytes": None, "limit_bytes": None, "collected_at": None,
                        "error": "storage_unavailable"}
        self.quota = {"gpu_used": None, "gpu_limit": None, "collected_at": None,
                      "error": "quota_unavailable"}
        self.last_storage_attempt = None
        self.gpu_cache = {}
        self.deadline = None

    def run(self, args):
        try:
            remaining = self.deadline - time.monotonic() if self.deadline else self.timeout
            if remaining <= 0:
                raise CollectionError("command_failed")
            result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    encoding="utf-8", errors="replace", timeout=min(self.timeout, remaining),
                                    check=False)
            if result.returncode or len(result.stdout) > 16 * 1024 * 1024:
                raise CollectionError("command_failed")
            return result.stdout
        except (subprocess.TimeoutExpired, OSError):
            raise CollectionError("command_failed")

    def kubectl(self, *args):
        return self.runner(["kubectl", "--request-timeout={}s".format(self.timeout),
                            "-n", self.namespace] + list(args))

    def get(self, kind, name=None):
        args = ["get", kind] + ([name] if name else []) + ["-o", "json"]
        value = json.loads(self.kubectl(*args))
        if not isinstance(value, dict):
            raise CollectionError("invalid_response")
        if name is None:
            items = value.get("items")
            if not isinstance(items, list) or len(items) > 1000:
                raise CollectionError("invalid_response")
            return items
        return value

    def collect_gpu(self, target):
        pod, container, expected = target
        output = self.kubectl("exec", pod, "-c", container, "--", "nvidia-smi",
                              "--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total",
                              "--format=csv,noheader,nounits")
        return parse_gpu_csv(output, expected, pod, container, utc_now())

    def collect(self):
        self.deadline = time.monotonic() + 25
        errors, pods, jobs = [], None, None
        # Independent metadata queries run together. GPU execs below have their
        # own pool capped at two, never one process per CPU or per cluster node.
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = {key: pool.submit(self.get, *args) for key, args in
                       [("pods", ("pods",)), ("jobs", ("jobs",)),
                        ("quota", ("resourcequota", "compute-resources"))]}
            for key, future in futures.items():
                try:
                    value = future.result()
                    if key == "pods":
                        pods = value
                    elif key == "jobs":
                        jobs = value
                    else:
                        status = value.get("status") or {}
                        used = quantity((status.get("used") or {}).get("requests." + GPU_RESOURCE))
                        limit = quantity((status.get("hard") or {}).get("requests." + GPU_RESOURCE))
                        if used is None or limit is None:
                            raise CollectionError("invalid_quota")
                        self.quota = {"gpu_used": used, "gpu_limit": limit,
                                      "collected_at": utc_now(), "error": None}
                except (CollectionError, ValueError, TypeError, KeyError):
                    error = key + "_unavailable"
                    errors.append(error)
                    if key == "quota":
                        self.quota["error"] = error
        if jobs is not None and pods is not None:
            try:
                assembled, targets = make_jobs(jobs, pods)
                jobs_collected_at = utc_now()
                current_keys = set()
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    futures = []
                    for job in assembled:
                        for target in targets.get(job["id"], []):
                            key = (job["id"],) + target
                            current_keys.add(key)
                            futures.append((job, key, pool.submit(self.collect_gpu, target)))
                        if job["status"] == "Running" and job["requested_gpus"] and not targets.get(job["id"]):
                            job["metrics_error"] = "gpu_metrics_unavailable"
                    for job, key, future in futures:
                        try:
                            metrics = future.result()
                            self.gpu_cache[key] = metrics
                            if any(row[field] is None for row in metrics for field in
                                   ("utilization_pct", "memory_used_mib", "memory_total_mib")):
                                job["metrics_error"] = "gpu_metrics_unavailable"
                        except (CollectionError, ValueError, TypeError, KeyError):
                            metrics = self.gpu_cache.get(key, [])
                            job["metrics_error"] = "gpu_metrics_unavailable"
                        job["gpus"].extend(copy.deepcopy(metrics))
                for job in assembled:
                    # Repeated visibility from two containers is ambiguous;
                    # never inflate a Job's GPU count or reject the whole report.
                    if len({row["uuid"] for row in job["gpus"]}) != len(job["gpus"]):
                        job["gpus"] = []
                        job["metrics_error"] = "gpu_metrics_unavailable"
                self.gpu_cache = {key: value for key, value in self.gpu_cache.items() if key in current_keys}
                self.previous_jobs = bound_jobs(assembled)
                self.jobs_collected_at = jobs_collected_at
            except (CollectionError, ValueError, TypeError, KeyError):
                errors.append("jobs_unavailable")
        now = time.monotonic()
        if self.last_storage_attempt is None or now - self.last_storage_attempt >= self.storage_interval:
            self.last_storage_attempt = now
            try:
                output = self.runner(["/usr/lpp/mmfs/bin/mmlsquota", "-u", self.quota_user,
                                      "--block-size", "1K", "-Y", self.filesystem])
                self.storage = parse_gpfs_quota(output, self.quota_user, self.filesystem, utc_now())
            except (CollectionError, ValueError, TypeError, KeyError):
                self.storage["error"] = "storage_unavailable"
        if self.storage["error"]:
            errors.append(self.storage["error"])
        if any(job["metrics_error"] for job in self.previous_jobs):
            errors.append("gpu_metrics_unavailable")
        if time.monotonic() >= self.deadline:
            errors.append("collection_timeout")
        return {"schema_version": 1, "cluster_id": "a100", "collected_at": utc_now(),
                "jobs_collected_at": self.jobs_collected_at,
                "errors": sorted(set(errors)), "quota": copy.deepcopy(self.quota),
                "storage": copy.deepcopy(self.storage), "jobs": copy.deepcopy(self.previous_jobs)}


def load_env(path):
    if not path:
        return
    source = Path(path)
    mode = source.stat()
    if not stat.S_ISREG(mode.st_mode) or mode.st_mode & 0o077 or mode.st_uid != os.getuid():
        raise ValueError("Configuration must be owned by this user and have mode 600")
    for line in source.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key.strip() not in ENV_NAMES:
            raise ValueError("Unrecognized configuration entry")
        parts = shlex.split(value, comments=True)
        if len(parts) != 1:
            raise ValueError("Configuration values must be single strings")
        os.environ[key.strip()] = parts[0]


def env_number(key, default, minimum, maximum):
    try:
        value = int(os.environ.get(key, str(default)))
    except ValueError:
        raise ValueError("Invalid numeric configuration: " + key)
    if not minimum <= value <= maximum:
        raise ValueError("Numeric configuration outside supported range: " + key)
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the dedicated token to a redirect destination.
        return None


class ReceiverClock:
    """Calibrate collector timestamps without changing the shared login clock."""
    def __init__(self, endpoint, interval=300, opener=None):
        parsed = urllib.parse.urlsplit(endpoint)
        self.url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/healthz", "", ""))
        self.interval = interval
        self.opener = opener or urllib.request.build_opener(NoRedirect)
        self.last_success = None
        self.error = "collection_failed"

    def calibrate(self):
        global CLOCK_OFFSET_SECONDS
        now = time.monotonic()
        if self.last_success is not None and now - self.last_success < self.interval and not self.error:
            return True
        request = urllib.request.Request(self.url, headers={"Cache-Control": "no-cache, no-store",
                                                            "Pragma": "no-cache"}, method="GET")
        try:
            start_wall, start_mono = time.time(), time.monotonic()
            with self.opener.open(request, timeout=5) as response:
                if response.status != 200:
                    raise ValueError("clock_unavailable")
                header = response.headers.get("Date")
                response.read(4096)
            end_wall, end_mono = time.time(), time.monotonic()
            elapsed = end_mono - start_mono
            if elapsed < 0 or elapsed > 5 or abs((end_wall - start_wall) - elapsed) > 2:
                raise ValueError("clock_unavailable")
            authority = parsedate_to_datetime(header)
            if authority.tzinfo is None:
                raise ValueError("clock_unavailable")
            offset = authority.timestamp() - (start_wall + elapsed / 2)
            if not math.isfinite(offset) or abs(offset) > 86400:
                raise ValueError("clock_unavailable")
            CLOCK_OFFSET_SECONDS = offset
            self.last_success = end_mono
            self.error = None
            return True
        except (OSError, urllib.error.URLError, ValueError, TypeError, OverflowError, AttributeError):
            # Keep any previously verified correction. Reattempt each collector
            # cycle after failure; do not silently call unverified time fresh.
            self.error = "collection_failed"
            return False


def post_report(endpoint, token, report):
    request = urllib.request.Request(endpoint, data=json.dumps(report, allow_nan=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "X-Status-Token": token},
                                     method="POST")
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=15) as response:
            if not 200 <= response.status < 300:
                raise CollectionError("report_rejected")
            response.read(4096)
    except urllib.error.HTTPError as error:
        raise CollectionError("report_http_{}".format(error.code))
    except (urllib.error.URLError, OSError):
        raise CollectionError("report_connection_failed")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", help="Owner-only mode 600 configuration file")
    parser.add_argument("--once", action="store_true", help="Collect/send once and exit")
    parser.add_argument("--dry-run", action="store_true", help="Collect once, print safe JSON, never POST")
    parser.add_argument("--lock-file", help="Daemon lock path; default next to env file or script")
    parser.add_argument("--log-file", help="Optional rotating log, 1 MiB x 3 backups")
    args = parser.parse_args(argv)
    try:
        load_env(args.env_file)
        interval = env_number("A100_INTERVAL_SECONDS", 30, 30, 3600)
        storage_interval = env_number("A100_STORAGE_INTERVAL_SECONDS", 300, 60, 86400)
        timeout = env_number("A100_COMMAND_TIMEOUT_SECONDS", 10, 3, 15)
        endpoint, token = os.environ.get("A100_REPORT_URL", DEFAULT_ENDPOINT), os.environ.get("A100_REPORT_TOKEN", "")
        url = urllib.parse.urlsplit(endpoint)
        if url.scheme != "https" or not url.netloc or url.username or url.password or url.query or url.fragment:
            raise ValueError("Report URL must be an HTTPS URL without credentials, query, or fragment")
        if not args.dry_run and (not token or len(token) < 32 or any(char.isspace() for char in token)):
            raise ValueError("A100_REPORT_TOKEN must be a dedicated token of at least 32 non-whitespace characters")
        namespace = os.environ.get("A100_NAMESPACE", "nlp-lab")
        quota_user = os.environ.get("A100_QUOTA_USER", "nlp-lab")
        filesystem = os.environ.get("A100_GPFS_FILESYSTEM", "gpfsai")
        if not all(SAFE_ID.fullmatch(value) for value in (namespace, quota_user, filesystem)):
            raise ValueError("Invalid namespace, quota user, or filesystem name")
    except (ValueError, OSError) as error:
        parser.error(str(error))
    os.umask(0o077)
    handler = RotatingFileHandler(args.log_file, maxBytes=1024 * 1024, backupCount=3) if args.log_file else logging.StreamHandler()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=[handler])
    collector = Collector(namespace, quota_user, filesystem, timeout, storage_interval)
    receiver_clock = ReceiverClock(endpoint)
    lock = None
    if not args.dry_run:
        lock_path = args.lock_file or str(Path(args.env_file or __file__).resolve().parent / "a100-agent.lock")
        lock = open(lock_path, "a+")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            logging.error("Another A100 collector already holds the lock")
            return 1
        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()) + "\n")
        lock.flush()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda signum, frame: STOP.set())
    failures = 0
    try:
        while not STOP.is_set():
            started = time.monotonic()
            try:
                if not receiver_clock.calibrate():
                    logging.warning("clock_calibration_unavailable")
                report = collector.collect()
                if receiver_clock.error:
                    report["errors"] = sorted(set(report["errors"] + [receiver_clock.error]))
                if args.dry_run:
                    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
                    return 0
                if STOP.is_set():
                    break
                post_report(endpoint, token, report)
                failures = 0
                logging.info("Report sent: jobs=%d errors=%s", len(report["jobs"]), ",".join(report["errors"]) or "none")
            except CollectionError as error:
                failures += 1
                logging.warning("Report failed: %s", str(error))
            except Exception:
                # Raw command errors, URLs, payloads and stack traces may contain
                # private data. The collector's log contains fixed codes only.
                failures += 1
                logging.error("collection_failed")
            if args.once:
                return 1 if failures else 0
            delay = min(300, interval * (2 ** min(failures, 4)))
            STOP.wait(max(1, delay - (time.monotonic() - started)))
    finally:
        if lock:
            lock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
