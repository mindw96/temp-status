"""Run an existing status agent against Lattice without editing its source.

Keep the JSON credential file readable only by its owner (chmod 600).
This wrapper is opt-in; it does not install services or edit existing agents.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("node", "slurm"))
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
    os.environ["DASHBOARD_URL"] = base_url + "/api/report/" + args.kind
    for key in ("NODE_REPORT_TOKEN", "SLURM_REPORT_TOKEN", "STATUS_REPORT_TOKEN"):
        os.environ[key] = config["report_token"]
    os.environ["REQUIRE_REPORT_TOKEN"] = "1"
    # This dashboard displays active jobs. Do not run redundant seven-day accounting queries.
    os.environ["ENABLE_SACCT"] = "0"
    if config.get("server_name"):
        os.environ["SERVER_NAME"] = config["server_name"]
    agent_path = Path(args.agent_dir) / ("agent.py" if args.kind == "node" else "slurm_agent.py")
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
    module.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
