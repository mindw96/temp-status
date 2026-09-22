#!/usr/bin/env python3
"""Install additional Cloudflare collectors over existing SSH aliases.

Credentials travel through SSH stdin, never command arguments. Existing agent
sources and lattice services are not modified. Python 3.9+ is sufficient.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
from urllib.parse import urlsplit


REMOTE_SCRIPT = r'''
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

AGENT_DIR = Path("/home/mindw/status_agent")

def run(command, timeout=30):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Agent/systemd output can contain credentials or private telemetry.
        raise RuntimeError("Command failed: " + Path(command[0]).name +
                           " (exit " + str(result.returncode) + ")")
    return result.stdout

def check_report(command, kind):
    result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    response = None
    for line in reversed(result.stdout.splitlines()):
        try:
            response = json.loads(line)
            break
        except ValueError:
            pass
    response = response if isinstance(response, dict) and response.get("kind") == kind else {}
    http_status = response.get("http_status")
    if type(http_status) is not int or not 100 <= http_status <= 599:
        http_status = None
    safe = {"kind": kind, "http_status": http_status, "accepted": response.get("accepted") is True}
    if result.returncode or http_status != 200 or not safe["accepted"]:
        raise RuntimeError(kind + " one-shot report was not accepted: " + json.dumps(safe))

def unit_text(kind, base, python_bin):
    return "\n".join([
        "[Unit]", "Description=Cloudflare status " + kind + " collector",
        "After=network-online.target", "", "[Service]", "Type=simple",
        "WorkingDirectory=" + str(AGENT_DIR),
        "ExecStart=" + str(python_bin) + " -u " + str(base / "collector_bridge.py") +
        " " + kind + " --config " + str(base / "config.json"),
        "Restart=always", "RestartSec=10", "UMask=0077",
        "StandardOutput=null", "StandardError=null", "", "[Install]",
        "WantedBy=default.target", "",
    ])

def private_write(path, content):
    path.write_text(content)
    path.chmod(0o600)

def main():
    os.umask(0o077)
    payload = json.load(sys.stdin)
    base = AGENT_DIR / "cloudflare-status"
    python_bin = AGENT_DIR / ".venv/bin/python"
    kinds = ["node", "slurm"] if payload["slurm"] else ["node"]
    units = ["cloudflare-status-" + kind + ".service" for kind in kinds]
    # Server4's actual home is /data/mindw, unlike its status_agent location.
    unit_dir = Path.home() / ".config/systemd/user"
    for kind in kinds:
        source = AGENT_DIR / ("agent.py" if kind == "node" else "slurm_agent.py")
        if not source.is_file():
            raise RuntimeError("Missing original agent: " + str(source))
    if not python_bin.is_file():
        raise RuntimeError("Missing existing virtualenv: " + str(python_bin))
    run(["systemctl", "--user", "show-environment"])
    linger = run(["loginctl", "show-user", str(os.getuid()), "-p", "Linger", "--value"]).strip()
    if linger != "yes":
        raise RuntimeError("User lingering is disabled; enable it before installing collectors")
    with tempfile.TemporaryDirectory(prefix=".cloudflare-status-", dir=AGENT_DIR) as temp:
        stage = Path(temp)
        private_write(stage / "collector_bridge.py", payload["bridge"])
        private_write(stage / "config.json", json.dumps(payload["config"]))
        compile(payload["bridge"], "collector_bridge.py", "exec")
        for kind, unit in zip(kinds, units):
            private_write(stage / unit, unit_text(kind, base, python_bin))
        run(["systemd-analyze", "--user", "verify", *[str(stage / unit) for unit in units]])
        # All required real reports must be accepted before replacing any files.
        for kind in kinds:
            check_report([str(python_bin), str(stage / "collector_bridge.py"), kind,
                          "--config", str(stage / "config.json"), "--once"], kind)
        base.mkdir(mode=0o700, exist_ok=True)
        base.chmod(0o700)
        unit_dir.mkdir(parents=True, exist_ok=True)
        destinations = {stage / "collector_bridge.py": base / "collector_bridge.py",
                        stage / "config.json": base / "config.json"}
        destinations.update({stage / unit: unit_dir / unit for unit in units})
        if any(path.is_symlink() for path in destinations.values()):
            raise RuntimeError("Refusing to replace symlinked collector files")
        backup = Path(tempfile.mkdtemp(prefix="backup-" + time.strftime("%Y%m%d-%H%M%S-") , dir=base))
        prior = {}
        for destination in destinations.values():
            if destination.exists():
                saved = backup / destination.name
                shutil.copyfile(destination, saved)
                saved.chmod(0o600)
                prior[destination] = saved
            else:
                prior[destination] = None
        states = {}
        for unit in units:
            states[unit] = tuple(subprocess.run(["systemctl", "--user", action, "--quiet", unit],
                                               capture_output=True, timeout=15).returncode == 0
                                 for action in ("is-enabled", "is-active"))
        try:
            for source, destination in destinations.items():
                # copy to same filesystem before atomic replacement
                temporary = destination.with_name(destination.name + ".installing")
                private_write(temporary, source.read_text())
                os.replace(temporary, destination)
            run(["systemctl", "--user", "daemon-reload"])
            run(["systemctl", "--user", "enable", *units])
            run(["systemctl", "--user", "restart", *units])
            time.sleep(2)
            for unit in units:
                run(["systemctl", "--user", "is-active", "--quiet", unit])
        except Exception:
            # Restore credentials/unit definitions if a restart fails on rerun.
            for destination, saved in prior.items():
                if saved:
                    private_write(destination, saved.read_text())
                else:
                    destination.unlink(missing_ok=True)
            subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, timeout=30)
            for unit, (enabled, active) in states.items():
                subprocess.run(["systemctl", "--user", "enable" if enabled else "disable", unit],
                               capture_output=True, timeout=30)
                subprocess.run(["systemctl", "--user", "restart" if active else "stop", unit],
                               capture_output=True, timeout=30)
            raise
        print(json.dumps({"ok": True, "units": units, "unit_directory": str(unit_dir)}))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid tracebacks containing payloads, tokens or captured agent output.
        print("Collector installation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
'''


def read_token(path):
    if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError("Token file must be a regular file with mode 600 (chmod 600)")
    token = path.read_text().rstrip("\r\n")
    if not token or not token.isascii() or any(character.isspace() for character in token):
        raise ValueError("Token must be a single nonempty ASCII value without whitespace")
    return token


def build_payload(site, token, bridge, host):
    origin = urlsplit(site)
    if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password
            or origin.path not in ("", "/") or origin.query or origin.fragment):
        raise ValueError("--site must be an HTTPS origin, without a path")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", host):
        raise ValueError("Hosts must be SSH aliases, such as Server1")
    return {"bridge": bridge, "slurm": host == "Server1",
            "config": {"site_url": site.rstrip("/"), "report_token": token,
                       "auth_mode": "cloudflare"}}


def install(host, payload):
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o",
         "ServerAliveInterval=15", host, "python3 -c " + shlex.quote(REMOTE_SCRIPT)],
        input=json.dumps(payload), text=True, capture_output=True, timeout=240)
    if result.returncode:
        # Only the remote installer's controlled error line may be shown.
        detail = next((line for line in result.stderr.splitlines()
                       if line.startswith("Collector installation failed: ")), "SSH or remote setup failed")
        raise RuntimeError(host + ": " + detail)
    try:
        status = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError(host + ": did not receive installation confirmation") from None
    if status.get("ok") is not True:
        raise RuntimeError(host + ": installation was not confirmed")
    print(host + ": installed and running; one-shot reports accepted", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True)
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--hosts", nargs="+", default=["Server1", "Server2", "Server3", "Server4"])
    args = parser.parse_args()
    try:
        token = read_token(args.token_file)
        bridge = (Path(__file__).resolve().parents[1] / "collector_bridge.py").read_text()
        payloads = [(host, build_payload(args.site, token, bridge, host)) for host in args.hosts]
        for host, payload in payloads:
            print(host + ": validating reports and installing additional collectors…", flush=True)
            install(host, payload)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        # TimeoutExpired.__str__ includes the command, which contains no token.
        print("ERROR: " + ("SSH installation timed out" if isinstance(error, subprocess.TimeoutExpired)
                           else str(error)), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
