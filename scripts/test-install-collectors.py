#!/usr/bin/env python3
"""Offline tests: no SSH connections, service changes or real reports."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load("installer", ROOT / "scripts/install-collectors.py")
bridge = load("bridge", ROOT / "collector_bridge.py")
TOKEN = "offline-test-token-123456789"
SITE = "https://example.workers.dev"


class InstallerTests(unittest.TestCase):
    def test_token_permissions_and_header_newlines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token"
            path.write_text(TOKEN + "\n")
            path.chmod(0o600)
            self.assertEqual(installer.read_token(path), TOKEN)
            path.write_text("before\nInjected-Header:value")
            with self.assertRaises(ValueError):
                installer.read_token(path)
            path.write_text(TOKEN)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                installer.read_token(path)
            with self.assertRaises(ValueError):
                installer.read_token(Path(directory))

    def test_refused_report_shows_http_401_without_agent_secrets(self):
        namespace = {"__name__": "offline_test"}
        exec(compile(installer.REMOTE_SCRIPT, "remote", "exec"), namespace)
        report = {"kind": "node", "http_status": 401, "accepted": False, "private": TOKEN}
        result = subprocess.CompletedProcess([], 1, TOKEN + "\n" + json.dumps(report) + "\n", TOKEN)
        with patch.object(namespace["subprocess"], "run", return_value=result):
            with self.assertRaises(RuntimeError) as error:
                namespace["check_report"](["python", "bridge.py"], "node")
        message = str(error.exception)
        self.assertIn('"http_status": 401', message)
        self.assertIn('"accepted": false', message)
        self.assertNotIn(TOKEN, message)
        self.assertNotIn("private", message)

    def test_payload_origin_host_and_controller(self):
        result = installer.build_payload(SITE + "/", TOKEN, "bridge source", "Server1")
        self.assertTrue(result["slurm"])
        self.assertEqual(result["config"], {"site_url": SITE, "report_token": TOKEN,
                                          "auth_mode": "cloudflare"})
        self.assertFalse(installer.build_payload(SITE, TOKEN, "source", "Server4")["slurm"])
        for site in ("http://bad.test", SITE + "/api", SITE + "?key=value", "https://user@bad.test"):
            with self.assertRaises(ValueError):
                installer.build_payload(site, TOKEN, "source", "Server1")
        with self.assertRaises(ValueError):
            installer.build_payload(SITE, TOKEN, "source", "-oProxyCommand=bad")

    def test_ssh_passes_token_only_through_stdin(self):
        payload = installer.build_payload(SITE, TOKEN, "source", "Server1")
        result = subprocess.CompletedProcess([], 0, '{"ok":true}\n', "")
        with patch.object(installer.subprocess, "run", return_value=result) as run:
            with contextlib.redirect_stdout(io.StringIO()):
                installer.install("Server1", payload)
        args, kwargs = run.call_args
        self.assertNotIn(TOKEN, " ".join(args[0]))
        self.assertEqual(json.loads(kwargs["input"])["config"]["report_token"], TOKEN)
        self.assertIn("BatchMode=yes", args[0])

    def remote_case(self, accepted, fail_restart=False):
        namespace = {"__name__": "offline_test"}
        exec(compile(installer.REMOTE_SCRIPT, "remote", "exec"), namespace)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agents, home = root / "agents", root / "actual-user-home"
            (agents / ".venv/bin").mkdir(parents=True)
            (agents / ".venv/bin/python").touch()
            for source in ("agent.py", "slurm_agent.py"):
                (agents / source).write_text("# existing agent")
            base = agents / "cloudflare-status"
            base.mkdir()
            old_config = '{"report_token":"old-secret"}'
            (base / "config.json").write_text(old_config)
            unit_dir = home / ".config/systemd/user"
            unit_dir.mkdir(parents=True)
            lattice_unit = unit_dir / "lattice-node.service"
            lattice_unit.write_text("existing Sites service")
            cloudflare_unit = unit_dir / "cloudflare-status-node.service"
            if fail_restart:
                cloudflare_unit.write_text("previous Cloudflare service")
            namespace["AGENT_DIR"] = agents
            commands = []

            def remote_run(command, timeout=30):
                commands.append(command)
                if command[0] == "loginctl":
                    return "yes\n"
                if fail_restart and "restart" in command:
                    raise RuntimeError("simulated service restart failure")
                return ""

            def remote_subprocess(command, **kwargs):
                if "--once" in command:
                    commands.append(command)
                    self.assertEqual((base / "config.json").read_text(), old_config)
                    kind = command[2]
                    output = json.dumps({"kind": kind, "http_status": 200 if accepted else 401,
                                         "accepted": accepted})
                    return subprocess.CompletedProcess(command, 0 if accepted else 1, output, "")
                return subprocess.CompletedProcess(command, 1, "", "")

            namespace["run"] = remote_run
            payload = installer.build_payload(SITE, TOKEN, "# bridge", "Server1")
            with patch("sys.stdin", io.StringIO(json.dumps(payload))), \
                    patch.object(Path, "home", return_value=home), \
                    patch.object(namespace["subprocess"], "run", side_effect=remote_subprocess), \
                    patch.object(namespace["time"], "sleep"), contextlib.redirect_stdout(io.StringIO()):
                if fail_restart:
                    with self.assertRaisesRegex(RuntimeError, "simulated service restart failure"):
                        namespace["main"]()
                elif accepted:
                    namespace["main"]()
                else:
                    with self.assertRaisesRegex(RuntimeError, "one-shot report was not accepted"):
                        namespace["main"]()
            self.assertEqual(lattice_unit.read_text(), "existing Sites service")
            self.assertFalse(any("lattice-" in part for cmd in commands for part in cmd))
            if fail_restart:
                self.assertEqual((base / "config.json").read_text(), old_config)
                self.assertEqual(cloudflare_unit.read_text(), "previous Cloudflare service")
                self.assertFalse((unit_dir / "cloudflare-status-slurm.service").exists())
            elif accepted:
                self.assertEqual(json.loads((base / "config.json").read_text())["report_token"], TOKEN)
                for kind in ("node", "slurm"):
                    unit = unit_dir / ("cloudflare-status-" + kind + ".service")
                    self.assertTrue(unit.is_file())
                    self.assertIn(str(base / "config.json"), unit.read_text())
                self.assertEqual((base / "config.json").stat().st_mode & 0o777, 0o600)
            else:
                self.assertEqual((base / "config.json").read_text(), old_config)
                self.assertFalse((unit_dir / "cloudflare-status-node.service").exists())
                self.assertFalse(any("restart" in command for command in commands))

    def test_rejected_report_preserves_previous_install(self):
        self.remote_case(accepted=False)

    def test_install_uses_actual_home_and_preserves_lattice(self):
        self.remote_case(accepted=True)

    def test_failed_restart_restores_existing_credentials_and_unit(self):
        self.remote_case(accepted=True, fail_restart=True)


class BridgeTests(unittest.TestCase):
    def test_cloudflare_once_needs_no_sites_token(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps({"site_url": SITE, "report_token": TOKEN, "auth_mode": "cloudflare"}))
            config.chmod(0o600)
            session = Mock()
            session.headers = {}
            session.post.return_value = types.SimpleNamespace(status_code=200, json=lambda: {"ok": True})
            module = types.SimpleNamespace(SESSION=session, DASHBOARD_URL=SITE + "/api/report/node",
                                           build_payload=lambda: {"server_name": "test", "gpus": []},
                                           request_headers=lambda: {"X-Status-Token": TOKEN})
            spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _: None))
            with patch("sys.argv", ["bridge", "node", "--config", str(config), "--once"]), \
                    patch.dict("os.environ", {}, clear=False), \
                    patch.object(bridge.importlib.util, "spec_from_file_location", return_value=spec), \
                    patch.object(bridge.importlib.util, "module_from_spec", return_value=module), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(bridge.main(), 0)
            self.assertNotIn("OAI-Sites-Authorization", session.headers)
            self.assertEqual(session.post.call_args.kwargs["headers"]["X-Status-Token"], TOKEN)

    def test_legacy_config_still_requires_sites_token(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps({"site_url": SITE, "report_token": TOKEN}))
            config.chmod(0o600)
            with patch("sys.argv", ["bridge", "node", "--config", str(config), "--once"]), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                bridge.main()
            self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
