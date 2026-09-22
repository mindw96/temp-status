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
import stat
import sys
from urllib.parse import urlparse


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
