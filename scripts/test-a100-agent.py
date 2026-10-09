#!/usr/bin/env python3
"""Contract and failure tests for the namespace-only A100 collector."""
import copy
from email.utils import formatdate
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("a100_agent", Path(__file__).resolve().parents[1] / "agents/a100_agent.py")
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)

QUOTA = """mmlsquota:user:HEADER:version:reserved:reserved:filesystemName:quotaType:id:name:blockUsage:blockQuota:blockLimit:blockInDoubt:blockGrace:filesUsage:filesQuota:filesLimit:filesInDoubt:filesGrace:remarks:fid:filesetname:
mmlsquota:user:0:1:::gpfsai:USR:1017:nlp-lab:117530496:5368709120:5368709120:474912:none:225088:0:0:114:none::0::
"""


def fixtures():
    container = {"name": "main", "resources": {"requests": {"cpu": "1500m", "memory": "64Gi", "nvidia.com/gpu": "2"}}}
    job = {"metadata": {"name": "experiment", "uid": "job-id", "labels": {"owner": "mindw"}, "creationTimestamp": "2026-10-09T00:00:00Z"},
           "spec": {"parallelism": 1, "template": {"spec": {"containers": [container]}}}, "status": {"active": 1, "startTime": "2026-10-09T00:00:00Z"}}
    pod = {"metadata": {"name": "experiment-abc", "uid": "pod-id", "ownerReferences": [{"kind": "Job", "uid": "job-id", "name": "experiment"}]},
           "spec": {"containers": [copy.deepcopy(container)], "nodeName": "hawk04"},
           "status": {"phase": "Running", "startTime": "2026-10-09T00:05:00Z", "containerStatuses": [{"name": "main", "restartCount": 2, "state": {"running": {"startedAt": "2026-10-09T00:06:00Z"}}}]}}
    return job, pod


class Quantities(unittest.TestCase):
    def test_units(self):
        for value, expected in [("500m", .5), ("1000000n", .001), ("1500u", .0015),
                                ("64Gi", 64 * 2 ** 30), ("1.5Ti", 1.5 * 2 ** 40),
                                ("2G", 2000000000), ("1e3", 1000), (0, 0)]:
            self.assertEqual(agent.quantity(value), expected)
        for bad in [None, True, "-1", "NaN", "12garbage", "1e99999999", "inf"]:
            self.assertIsNone(agent.quantity(bad))

    def test_effective_pod_request(self):
        spec = {"containers": [{"resources": {"requests": {"cpu": "500m"}}}, {"resources": {"limits": {"cpu": 1}}}],
                "initContainers": [{"resources": {"requests": {"cpu": 4}}}], "overhead": {"cpu": "100m"}}
        self.assertEqual(agent.pod_resource(spec, "cpu"), 4.1)
        self.assertEqual(agent.pod_resource(spec, "memory"), 0)

    def test_actual_gpfs_hard_limit_not_pool(self):
        result = agent.parse_gpfs_quota(QUOTA, "nlp-lab", "gpfsai", "now")
        self.assertEqual(result["limit_bytes"], 5 * 2 ** 40)
        self.assertEqual(result["used_bytes"], 117530496 * 1024)
        self.assertEqual(result["collected_at"], "now")
        with self.assertRaises(ValueError):
            agent.parse_gpfs_quota(QUOTA, "another-user", "gpfsai", "now")
        with self.assertRaises(ValueError):
            agent.parse_gpfs_quota(QUOTA.replace(":5368709120:5368709120:", ":5368709120:0:"), "nlp-lab", "gpfsai", "now")


class Jobs(unittest.TestCase):
    def test_queued_job_without_pod_visible(self):
        job, _ = fixtures()
        rows, targets = agent.make_jobs([job], [])
        self.assertEqual(rows[0]["status"], "Pending")
        self.assertEqual(rows[0]["reason"], "WaitingForPod")
        self.assertIsNone(rows[0]["started_at"])
        self.assertEqual(rows[0]["requested_gpus"], 2)
        self.assertEqual(rows[0]["cpu_requested"], 1.5)
        self.assertEqual(targets, {})

    def test_multi_gpu_and_owner_only_from_labels(self):
        job, pod = fixtures()
        rows, targets = agent.make_jobs([job], [pod])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["owner"], "mindw")
        self.assertEqual(rows[0]["pods"][0]["restarts"], 2)
        self.assertEqual(targets["job-id"], [("experiment-abc", "main", 2)])
        del job["metadata"]["labels"]
        job["metadata"]["name"] = "mindw-inferred-is-wrong"
        rows, _ = agent.make_jobs([job], [pod])
        self.assertIsNone(rows[0]["owner"])

    def test_cpu_only_never_queries_exposed_host_gpus(self):
        _, pod = fixtures()
        del pod["spec"]["containers"][0]["resources"]["requests"]["nvidia.com/gpu"]
        self.assertEqual(agent.gpu_targets([pod]), [])
        pod["spec"]["containers"][0]["resources"]["limits"] = {"nvidia.com/gpu": "1"}
        self.assertEqual(agent.gpu_targets([pod]), [("experiment-abc", "main", 1)])
        pod["status"]["containerStatuses"][0]["state"] = {"waiting": {"reason": "CrashLoopBackOff"}}
        self.assertEqual(agent.gpu_targets([pod]), [])

    def test_terminal_states_and_retry(self):
        job, pod = fixtures()
        job["status"]["conditions"] = [{"type": "Failed", "status": "True", "reason": "BackoffLimitExceeded"}]
        self.assertEqual(agent.job_state(job, [pod]), ("Failed", "BackoffLimitExceeded"))
        job["status"]["conditions"] = [{"type": "Complete", "status": "True"}]
        self.assertEqual(agent.job_state(job, [pod])[0], "Succeeded")
        job["status"]["conditions"] = []
        pod["status"]["phase"] = "Failed"
        self.assertEqual(agent.job_state(job, [pod]), ("Pending", "WaitingForJobController"))
        job["spec"]["suspend"] = True
        self.assertEqual(agent.job_state(job, [pod])[0], "Suspended")

    def test_old_pod_not_attached_to_recreated_job(self):
        job, pod = fixtures()
        job["metadata"]["uid"] = "replacement-id"
        pod["metadata"]["labels"] = {"job-name": "experiment"}
        rows, _ = agent.make_jobs([job], [pod])
        self.assertEqual(len(rows), 2)
        queued = next(row for row in rows if row["id"] == "replacement-id")
        self.assertEqual(queued["status"], "Pending")

    def test_completed_standalone_pod_ends_elapsed_time(self):
        _, pod = fixtures()
        pod["status"]["phase"] = "Succeeded"
        pod["status"]["containerStatuses"][0]["state"] = {"terminated": {"reason": "Completed", "finishedAt": "2026-10-09T01:00:00Z"}}
        rows, _ = agent.make_jobs([], [pod])
        self.assertEqual(rows[0]["finished_at"], "2026-10-09T01:00:00Z")

    def test_failed_attempt_does_not_mark_healthy_retry(self):
        job, current = fixtures()
        previous = copy.deepcopy(current)
        previous["status"]["phase"] = "Failed"
        previous["status"]["containerStatuses"][0]["state"] = {"terminated": {"reason": "OOMKilled"}}
        self.assertEqual(agent.job_state(job, [previous, current]), ("Running", None))
        current["status"]["phase"] = "Pending"
        current["status"]["containerStatuses"][0]["state"] = {"waiting": {"reason": "ContainerCreating"}}
        self.assertEqual(agent.job_state(job, [previous, current]), ("Pending", "ContainerCreating"))

    def test_history_bound_never_silently_removes_active_jobs(self):
        active = {"id": "active", "status": "Running", "pods": [], "gpus": []}
        completed = [{"id": str(i), "status": "Succeeded", "pods": [], "gpus": []} for i in range(600)]
        rows = agent.bound_jobs(completed + [active])
        self.assertEqual(len(rows), 500)
        self.assertEqual(rows[0]["id"], "active")
        with self.assertRaises(agent.CollectionError):
            agent.bound_jobs([copy.deepcopy(active) for _ in range(501)])


class Metrics(unittest.TestCase):
    def test_all_gpus_returned_without_index_assumptions(self):
        text = "GPU-a, NVIDIA A100-SXM4-80GB, 99, 40960, 81920\nGPU-b, NVIDIA A100-SXM4-80GB, 0, 4, 81920\n"
        rows = agent.parse_gpu_csv(text, 2, "p", "c", "time")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]["utilization_pct"], 0)
        self.assertEqual(rows[1]["memory_used_mib"], 4)
        self.assertNotIn("index", rows[0])
        with self.assertRaises(ValueError):
            agent.parse_gpu_csv(text, 1, "p", "c", "time")

    def test_unavailable_metrics_are_null(self):
        rows = agent.parse_gpu_csv("GPU-a, A100, [N/A], N/A, 81920\n", 1, "p", "c", "time")
        self.assertIsNone(rows[0]["utilization_pct"])
        self.assertIsNone(rows[0]["memory_used_mib"])
        with self.assertRaises(ValueError):
            agent.parse_gpu_csv("No devices found", 1, "p", "c", "time")

    def test_collection_preserves_timestamp_on_failure(self):
        job, pod = fixtures()
        fail = set()
        calls = []

        def run(args):
            calls.append(args)
            if args[0].endswith("mmlsquota"):
                if "storage" in fail:
                    raise agent.CollectionError("storage_unavailable")
                return QUOTA
            if "exec" in args:
                if "gpu" in fail:
                    raise agent.CollectionError("gpu_metrics_unavailable")
                return "GPU-a, A100, 99, 40000, 81920\nGPU-b, A100, 0, 4, 81920\n"
            kind = args[args.index("get") + 1]
            if kind in fail:
                raise agent.CollectionError("command_failed")
            values = {"pods": {"items": [pod]}, "jobs": {"items": [job]}, "resourcequota": {"status": {"hard": {"requests.nvidia.com/gpu": "8"}, "used": {"requests.nvidia.com/gpu": "2"}}}}
            return json.dumps(values[kind])

        collector = agent.Collector(runner=run, storage_interval=300)
        with patch.object(agent, "utc_now", return_value="first"):
            first = collector.collect()
        self.assertEqual(first["errors"], [])
        self.assertEqual(first["jobs"][0]["gpus"][0]["collected_at"], "first")
        fail.update({"gpu", "resourcequota", "storage"})
        collector.last_storage_attempt = None
        with patch.object(agent, "utc_now", return_value="second"):
            second = collector.collect()
        self.assertEqual(second["collected_at"], "second")
        self.assertEqual(second["quota"]["collected_at"], "first")
        self.assertEqual(second["storage"]["collected_at"], "first")
        self.assertEqual(second["jobs"][0]["gpus"][0]["collected_at"], "first")
        self.assertEqual(second["jobs"][0]["metrics_error"], "gpu_metrics_unavailable")
        self.assertEqual(second["jobs_collected_at"], "second")
        fail.add("pods")
        with patch.object(agent, "utc_now", return_value="third"):
            third = collector.collect()
        self.assertEqual(third["jobs_collected_at"], "second")
        self.assertIn("pods_unavailable", third["errors"])
        self.assertTrue(set(third["errors"]) <= agent.PUBLIC_ERRORS)

    def test_storage_cached_for_five_minutes(self):
        def run(args):
            if args[0].endswith("mmlsquota"):
                self.storage_calls += 1
                return QUOTA
            if "resourcequota" in args:
                return json.dumps({"status": {"hard": {"requests.nvidia.com/gpu": "8"}, "used": {"requests.nvidia.com/gpu": "0"}}})
            return '{"items":[]}'
        self.storage_calls = 0
        collector = agent.Collector(runner=run)
        collector.collect()
        collector.collect()
        self.assertEqual(self.storage_calls, 1)


class Configuration(unittest.TestCase):
    def test_credentials_require_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.env"
            path.write_text("A100_NAMESPACE=nlp-lab\nA100_INTERVAL_SECONDS=30\n")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                agent.load_env(path)
            path.chmod(0o600)
            with patch.dict(os.environ):
                agent.load_env(path)
                self.assertEqual(os.environ["A100_NAMESPACE"], "nlp-lab")


class ClockCalibration(unittest.TestCase):
    def response(self, authority):
        response = Mock()
        response.status = 200
        response.headers = {"Date": formatdate(authority, usegmt=True)}
        response.read.return_value = b'{"status":"ok"}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=None)
        return response

    def test_wrong_os_clock_is_corrected_without_token(self):
        authority, behind = 1791533633, 246
        opener = Mock()
        opener.open.return_value = self.response(authority)
        clock = agent.ReceiverClock("https://status.example/api/a100/report", opener=opener)
        with patch.object(agent, "CLOCK_OFFSET_SECONDS", 0), \
                patch.object(agent.time, "time", side_effect=[authority - behind, authority - behind + .2, authority - behind + .3]), \
                patch.object(agent.time, "monotonic", side_effect=[100, 100, 100.2]):
            self.assertTrue(clock.calibrate())
            self.assertAlmostEqual(agent.CLOCK_OFFSET_SECONDS, 245.9, places=5)
            self.assertEqual(agent.utc_now(), agent.datetime.fromtimestamp(authority, agent.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"))
        request = opener.open.call_args[0][0]
        self.assertEqual(request.full_url, "https://status.example/healthz")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(opener.open.call_args[1]["timeout"], 5)
        self.assertFalse(any("token" in key.lower() or "authorization" in key.lower() for key, _ in request.header_items()))
        self.assertIn("no-store", request.get_header("Cache-control"))

    def test_refresh_after_five_minutes_and_keep_original_source_dates(self):
        authority = 1791533633
        opener = Mock()
        opener.open.return_value = self.response(authority)
        clock = agent.ReceiverClock("https://status.example/api/a100/report", opener=opener)
        collector = agent.Collector()
        collector.storage["collected_at"] = "2026-10-09T08:00:00Z"
        with patch.object(agent, "CLOCK_OFFSET_SECONDS", 0), \
                patch.object(agent.time, "time", side_effect=[authority - 246, authority - 245.8, authority + 55, authority + 55.2]), \
                patch.object(agent.time, "monotonic", side_effect=[100, 100, 100.2, 101, 401, 401, 401.2]):
            self.assertTrue(clock.calibrate())
            self.assertTrue(clock.calibrate())
            self.assertEqual(opener.open.call_count, 1)
            opener.open.return_value = self.response(authority + 301)
            self.assertTrue(clock.calibrate())
            self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(collector.storage["collected_at"], "2026-10-09T08:00:00Z")

    def test_bad_dates_latency_and_large_skew_rejected(self):
        authority = 1791533633
        for elapsed, delta, header in [(6, 0, None), (.2, 86402, None), (.2, 0, "invalid date")]:
            opener = Mock()
            response = self.response(authority + delta)
            if header:
                response.headers["Date"] = header
            opener.open.return_value = response
            clock = agent.ReceiverClock("https://status.example/api/a100/report", opener=opener)
            with patch.object(agent, "CLOCK_OFFSET_SECONDS", 245.0), \
                    patch.object(agent.time, "time", side_effect=[authority, authority + elapsed]), \
                    patch.object(agent.time, "monotonic", side_effect=[100, 100, 100 + elapsed]):
                self.assertFalse(clock.calibrate())
                self.assertEqual(clock.error, "collection_failed")
                self.assertEqual(agent.CLOCK_OFFSET_SECONDS, 245.0)

    def test_failed_calibration_retries_next_cycle(self):
        opener = Mock()
        opener.open.side_effect = OSError("private connection detail")
        clock = agent.ReceiverClock("https://status.example/api/a100/report", opener=opener)
        self.assertFalse(clock.calibrate())
        self.assertFalse(clock.calibrate())
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(clock.error, "collection_failed")


if __name__ == "__main__":
    unittest.main()
