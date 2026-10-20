#!/usr/bin/env python3
"""Historical-ID imports: real files, mocked Slurm, no SSH or credentials."""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("backfill-fun-jobs.py")
spec = importlib.util.spec_from_file_location("fun_backfill", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bridge = module.bridge
NOW = datetime(2026, 10, 20, 7, 0, tzinfo=timezone.utc)
SUBMIT = 1787282958
UNSET = {"set": False, "infinite": False, "number": 0}


def row(job_id, user="mindw", name="previous training", submit=SUBMIT, **extra):
    value = {
        "job_id": int(job_id), "cluster": "lab-cluster", "name": name, "user": user,
        "array": {"job_id": 0, "task_id": dict(UNSET), "task": ""},
        "het": {"job_id": 0, "job_offset": dict(UNSET)},
        "time": {"submission": submit}, **extra,
    }
    return value


class BackfillTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "fun-jobs.json"
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({
            "fun_jobs_path": str(self.archive), "report_token": "secret-not-for-output"}))
        self.config.chmod(0o600)
        self.old = {
            "version": 1, "started_at": "2026-10-20T06:00:00.000Z",
            "records": [{
                "job_id": "1111", "name": "live discovery", "user": "original",
                "pattern": "repeat", "first_seen_at": "2026-10-20T06:01:00.000Z",
            }],
        }
        bridge._write_fun_jobs(self.archive, self.old)
        self.before = self.archive.read_bytes()
        self.commands = []

    def runner(self, jobs=None, response=None):
        first_batch = True

        def run(arguments, **options):
            nonlocal first_batch
            self.commands.append((arguments, options))
            if arguments[0] == "scontrol":
                return SimpleNamespace(returncode=0, stdout="ClusterName = lab-cluster\nMaxJobId = 67043328\n")
            if response is not None:
                value = response
            else:
                requested = set(arguments[arguments.index("-j") + 1].split(","))
                value = {"errors": [], "jobs": [
                    item for item in jobs or [] if (
                        (type(item.get("job_id")) is int and str(item["job_id"]) in requested)
                        or (first_batch and type(item.get("job_id")) is not int)
                    )
                ]}
            first_batch = False
            return SimpleNamespace(returncode=0, stdout=json.dumps(value))
        return run

    def invoke(self, jobs=None, apply=False, runner=None):
        return module.backfill(self.config, apply=apply,
                               runner=runner or self.runner(jobs), now=NOW)

    def test_candidates_and_bounded_readonly_query(self):
        expected = module.candidates(67043328)
        self.assertGreater(len(expected), 10000)
        for candidate in expected:
            self.assertIsNotNone(bridge.fun_job_pattern(candidate))
            self.assertLessEqual(int(candidate), 67043328)
        for candidate in ["1111", "1234", "4321", "1000", "1221", "1212",
                          "12345", "54321", "10000", "20000", "1234554321"]:
            self.assertIn(candidate, module.candidates(9999999999))
        self.invoke([row("22222")])
        requested = []
        for arguments, options in self.commands[1:]:
            self.assertEqual(arguments[:7], ["sacct", "-a", "-X", "-D", "-M", "lab-cluster", "-S"])
            self.assertIn("--json", arguments)
            self.assertIn("2000-01-01", arguments)
            batch = arguments[arguments.index("-j") + 1].split(",")
            self.assertLessEqual(len(batch), module.QUERY_BATCH_SIZE)
            requested.extend(batch)
            self.assertEqual(options["timeout"], 60)
            self.assertEqual(options["env"]["TZ"], "UTC")
        self.assertEqual(requested, expected)
        self.assertGreater(len(self.commands), 2)

    def test_all_four_digit_matches_are_candidates_with_exact_maximum(self):
        all_four_digits = {
            str(value) for value in range(1000, 10000) if bridge.fun_job_pattern(str(value))}
        self.assertEqual(set(module.candidates(9999)), all_four_digits)
        for maximum in [999, 1000, 1212, 9999, 10000, 12321, 12345, 54321, 100001]:
            self.assertEqual(set(module.candidates(maximum)), {
                str(value) for value in range(1000, maximum + 1)
                if bridge.fun_job_pattern(str(value))})

    def test_later_batch_failure_or_timeout_does_not_write_partial_import(self):
        for failure in ["error", "timeout"]:
            basic = self.runner([row("1000")])
            batches = 0

            def run(arguments, **options):
                nonlocal batches
                if arguments[0] == "sacct":
                    batches += 1
                    if batches == 2:
                        if failure == "timeout":
                            raise subprocess.TimeoutExpired("private query", 60)
                        return SimpleNamespace(returncode=0, stdout=json.dumps({
                            "errors": [{"description": "private details"}], "jobs": []}))
                return basic(arguments, **options)

            with self.subTest(failure=failure), self.assertRaises(module.BackfillError):
                self.invoke(apply=True, runner=run)
            self.assertEqual(batches, 2)
            self.assertEqual(self.archive.read_bytes(), self.before)
            self.assertFalse(Path(str(self.archive) + ".lock").exists())

    def test_cumulative_query_limits_apply_across_batches(self):
        with patch.object(module, "QUERY_BATCH_SIZE", 1), \
                patch.object(module, "MAX_QUERY_ROWS", 1):
            with self.assertRaises(module.BackfillError):
                self.invoke(apply=True, runner=self.runner([row("1000"), row("1001")]))
        self.assertEqual(self.archive.read_bytes(), self.before)
        self.assertFalse(Path(str(self.archive) + ".lock").exists())
        with patch.object(module, "MAX_QUERY_BYTES", 128):
            with self.assertRaises(module.BackfillError):
                self.invoke(apply=True)
        self.assertEqual(self.archive.read_bytes(), self.before)
        self.assertFalse(Path(str(self.archive) + ".lock").exists())

    def test_preview_does_not_create_lock_or_backup_or_write(self):
        result = self.invoke([row("22222")])
        self.assertTrue(result["ok"])
        self.assertEqual(result["added_count"], 0)
        self.assertEqual(result["would_add_count"], 1)
        self.assertEqual(result["archive_total"], 1)
        self.assertEqual(self.archive.read_bytes(), self.before)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()),
                         ["config.json", "fun-jobs.json"])
        self.assertNotIn("secret-not-for-output", json.dumps(result))

    def test_merge_backup_and_repeat_import_preserve_existing_records(self):
        result = self.invoke([row("1111", name="older reused ID"), row("22222")], apply=True)
        self.assertEqual(result["added_count"], 1)
        self.assertEqual(result["existing_ids"], ["1111"])
        backup = Path(result["backup_path"])
        self.assertEqual(backup.read_bytes(), self.before)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        self.assertEqual(result["backup_sha256"], hashlib.sha256(self.before).hexdigest())
        saved = bridge._read_fun_jobs(self.archive)
        self.assertEqual(saved["records"][0], self.old["records"][0])
        imported = saved["records"][1]
        self.assertEqual(imported["source"], "sacct")
        self.assertEqual(imported["first_seen_at"], "2026-10-20T07:00:00.000Z")
        self.assertLess(imported["submitted_at"], saved["started_at"])
        before_repeat = self.archive.read_bytes()
        with patch.object(module, "_backup", side_effect=AssertionError("unneeded backup")):
            repeated = self.invoke([row("22222"), row("1111")], apply=True)
        self.assertEqual(repeated["added_count"], 0)
        self.assertIsNone(repeated["backup_path"])
        self.assertEqual(self.archive.read_bytes(), before_repeat)
        # The normal live collector must read and preserve imported metadata.
        reported = bridge.collect_fun_jobs(str(self.archive), [])
        self.assertEqual(reported["status"], "ok")
        self.assertEqual(reported["records"], saved["records"])

    def test_requeue_and_reused_id_select_earliest_submission(self):
        result = self.invoke([
            row("22222", name="latest retry", submit=SUBMIT + 100),
            row("22222", name="original submission", submit=SUBMIT),
            row("22222", name="later reused ID", user="another", submit=SUBMIT + 10000),
        ])
        self.assertEqual(result["duplicate_rows"], 2)
        self.assertEqual(result["records"][0]["name"], "original submission")

    def test_arrays_heterogeneous_unknown_identity_and_non_scalar_ids_excluded(self):
        jobs = [
            row("22222", array={"job_id": 22222, "task_id": dict(UNSET), "task": ""}),
            row("33333", array={"job_id": 0, "task_id": {**UNSET, "set": True}, "task": ""}),
            row("44444", het={"job_id": 44444, "job_offset": dict(UNSET)}),
            row("55555", array=None),
            row("66666", het={"job_id": 0, "job_offset": {**UNSET, "set": True}}),
            {**row("77777"), "job_id": "77777.batch"},
            {**row("88888"), "job_id": "88888_3"},
            {**row("99999"), "job_id": True},
            row("12345", cluster="another"),
            row("23456"),
        ]
        result = self.invoke(jobs)
        self.assertEqual(result["matching_ids"], ["23456"])
        self.assertEqual(result["skipped"]["array_heterogeneous_or_unknown_identity"], 5)
        self.assertEqual(result["skipped"]["nonmatching_id"], 3)
        self.assertEqual(result["skipped"]["other_cluster"], 1)

    def test_unset_invalid_and_future_submission_rejected(self):
        jobs = [row("22222", submit=value) for value in [
            None, 0, -1, True, "1787282958", 1787282958.0, int(NOW.timestamp()) + 1,
        ]]
        result = self.invoke(jobs)
        self.assertEqual(result["would_add_count"], 0)
        self.assertEqual(result["skipped"], {"invalid_submission": len(jobs)})

    def test_accounting_errors_are_not_imported_or_exposed(self):
        for response in [
            {"errors": [{"description": "secret query output"}], "jobs": [row("22222")]},
            {"jobs": [row("22222")]}, {"errors": [], "jobs": None}, [],
        ]:
            with self.subTest(response=response):
                with self.assertRaises(module.BackfillError) as failure:
                    self.invoke(apply=True, runner=self.runner(response=response))
                self.assertNotIn("secret", str(failure.exception))
                self.assertEqual(self.archive.read_bytes(), self.before)
                self.assertFalse(Path(str(self.archive) + ".lock").exists())
        for error in [subprocess.TimeoutExpired("private command", 60), OSError("private error")]:
            with self.assertRaises(module.BackfillError) as failure:
                self.invoke(apply=True, runner=lambda *args, **kwargs: (_ for _ in ()).throw(error))
            self.assertNotIn("private", str(failure.exception))
        self.assertEqual(self.archive.read_bytes(), self.before)

    def test_bad_archive_missing_archive_clock_capacity_and_backup_failure(self):
        self.archive.write_text("{broken")
        with self.assertRaises(ValueError):
            self.invoke([row("22222")], apply=True)
        self.assertEqual(self.archive.read_text(), "{broken")
        self.archive.unlink()
        with self.assertRaises(module.BackfillError):
            self.invoke([row("22222")], apply=True)
        bridge._write_fun_jobs(self.archive, self.old)
        with patch.object(bridge, "MAX_FUN_JOBS", 1):
            with self.assertRaises(module.BackfillError):
                self.invoke([row("22222")], apply=True)
        with patch.object(module, "_backup", side_effect=OSError("backup failed")):
            with self.assertRaises(OSError):
                self.invoke([row("22222")], apply=True)
        self.assertEqual(self.archive.read_bytes(), self.before)
        old_clock = datetime(2026, 10, 19, tzinfo=timezone.utc)
        with self.assertRaises(module.BackfillError):
            module.backfill(self.config, apply=True, runner=self.runner([row("22222")]), now=old_clock)

    def test_failed_replace_keeps_original_and_recoverable_backup(self):
        with patch.object(bridge.os, "replace", side_effect=OSError("replace failed")):
            with self.assertRaises(OSError):
                self.invoke([row("22222")], apply=True)
        self.assertEqual(self.archive.read_bytes(), self.before)
        backups = list(self.root.glob("fun-jobs.json.before-sacct-*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.before)

    def test_latest_daemon_record_merged_after_query(self):
        basic_runner = self.runner([row("22222"), row("33333")])

        def run(arguments, **options):
            if arguments[0] == "sacct":
                bridge.collect_fun_jobs(str(self.archive), [
                    {"job_id": "22222", "name": "daemon wins", "user": "live-user"}])
            return basic_runner(arguments, **options)

        result = self.invoke(apply=True, runner=run)
        self.assertEqual(result["added_count"], 1)
        saved = bridge._read_fun_jobs(self.archive)
        self.assertEqual({item["job_id"] for item in saved["records"]}, {"1111", "22222", "33333"})
        live = next(item for item in saved["records"] if item["job_id"] == "22222")
        self.assertEqual(live["name"], "daemon wins")
        self.assertNotIn("source", live)

    def test_concurrent_collector_and_importer_merge_without_lost_updates(self):
        code = """
import importlib.util,json,sys,time
from datetime import datetime,timezone
s=importlib.util.spec_from_file_location('importer',sys.argv[1])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
original=m.bridge._write_fun_jobs
def slow_write(*args):
    time.sleep(.1)
    return original(*args)
m.bridge._write_fun_jobs=slow_write
if sys.argv[2]=='import':
    m.query_history=lambda runner: ('lab-cluster',['33333'],[json.loads(sys.argv[4])])
    result=m.backfill(sys.argv[3],apply=True,now=datetime(2026,10,20,7,tzinfo=timezone.utc))
    assert result['added_count']==1,result
else:
    result=m.bridge.collect_fun_jobs(sys.argv[3],[{'job_id':'44444','name':'concurrent','user':'live'}])
    assert result['status']=='ok',result
"""
        processes = [
            subprocess.Popen([sys.executable, "-c", code, str(SCRIPT), "import",
                              str(self.config), json.dumps(row("33333"))],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True),
            subprocess.Popen([sys.executable, "-c", code, str(SCRIPT), "collect", str(self.archive)],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True),
        ]
        for process in processes:
            stdout, stderr = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, (stdout, stderr))
        saved = bridge._read_fun_jobs(self.archive)
        self.assertEqual({item["job_id"] for item in saved["records"]}, {"1111", "33333", "44444"})

    def test_cli_defaults_to_preview_and_never_prints_config_tokens(self):
        binary = self.root / "bin"
        binary.mkdir()
        for command, body in {
            "scontrol": "print('ClusterName = lab-cluster\\nMaxJobId = 67043328')",
            "sacct": f"print({json.dumps({'errors': [], 'jobs': [row('22222')]})!r})",
        }.items():
            executable = binary / command
            executable.write_text(f"#!{sys.executable}\n{body}\n")
            executable.chmod(0o700)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--config", str(self.config)],
            capture_output=True, text=True, check=True,
            env={**os.environ, "PATH": str(binary) + os.pathsep + os.environ.get("PATH", "")})
        self.assertEqual(json.loads(result.stdout)["mode"], "preview")
        self.assertEqual(result.stderr, "")
        self.assertNotIn("secret-not-for-output", result.stdout)
        self.assertEqual(self.archive.read_bytes(), self.before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
