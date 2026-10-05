"""Exercise bridge configuration with fake agents; no network or GPU required."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import importlib.util
from types import SimpleNamespace
from unittest.mock import patch

BRIDGE = Path(__file__).resolve().parents[1] / 'collector_bridge.py'
FAKE_AGENT = '''
import os
DASHBOARD_URL = os.environ['DASHBOARD_URL']
class Response:
    status_code = 200
    def json(self): return {'ok': True}
class Session:
    headers = {}
    def post(self, url, json, headers, timeout):
        assert url == 'https://dashboard.example/api/report/' + os.environ['EXPECTED_KIND']
        assert headers == {'X-Status-Token': 'fake-test-credential'}
        assert json == {'test_payload': True}
        assert os.environ['REQUIRE_REPORT_TOKEN'] == '1'
        assert float(os.environ['REPORT_INTERVAL_SEC']) == 15
        assert os.environ['ENABLE_SACCT'] == '0'
        assert os.environ['SERVER_NAME'] == 'baro-1'
        if os.environ['EXPECTED_KIND'] == 'cloud-gpu':
            assert os.environ['DISK_PATH'] == '/home'
        return Response()
SESSION = Session()
def request_headers():
    key = 'CLOUD_GPU_REPORT_TOKEN' if os.environ['EXPECTED_KIND'] == 'cloud-gpu' else 'STATUS_REPORT_TOKEN'
    return {'X-Status-Token': os.environ[key]}
def build_payload(): return {'test_payload': True}
'''

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    config = root / 'config.json'
    config.write_text(json.dumps({'site_url': 'https://dashboard.example', 'auth_mode': 'cloudflare',
                                 'report_token': 'fake-test-credential', 'server_name': 'baro-1',
                                 'disk_path': '/home'}))
    config.chmod(0o600)
    for kind, filename in [('node', 'agent.py'), ('slurm', 'slurm_agent.py'), ('cloud-gpu', 'cloud_gpu_agent.py')]:
        (root / filename).write_text(FAKE_AGENT)
        result = subprocess.run([sys.executable, str(BRIDGE), kind, '--config', str(config),
                                 '--agent-dir', str(root), '--once'], capture_output=True, text=True,
                                env={**os.environ, 'EXPECTED_KIND': kind}, check=True)
        assert json.loads(result.stdout) == {'kind': kind, 'http_status': 200, 'accepted': True}
    config.chmod(0o644)
    result = subprocess.run([sys.executable, str(BRIDGE), 'cloud-gpu', '--config', str(config),
                             '--agent-dir', str(root), '--once'], capture_output=True, text=True)
    assert result.returncode != 0 and 'mode 600' in result.stderr
spec = importlib.util.spec_from_file_location('bridge', BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

# The source stops collecting per-job details at 200 jobs. One bulk request
# snapshot supplies all active jobs without adding one subprocess per job.
def optional(number, *, present=True, infinite=False):
    return {'set': present, 'infinite': infinite, 'number': number}


def enrich_requests(payload, report=None, error=None):
    calls = []

    def build_payload():
        calls.append('build')
        return payload

    def run_slurm_json(command, **kwargs):
        assert calls == ['build']
        assert command == ['squeue', '--json'] and kwargs == {'quiet': True}
        calls.append('query')
        if error:
            raise error
        return report

    agent = SimpleNamespace(build_payload=build_payload, run_slurm_json=run_slurm_json)
    bridge.install_slurm_job_requests(agent, 'slurm')
    result = agent.build_payload()
    assert result is payload
    return result, calls


many_jobs = {'squeue': [{'job_id': str(i), 'req_cpus': '', 'req_mem': '', 'req_gpus': ''}
                       for i in range(1, 210)],
             'sinfo': [{'hostname': 'server1', 'alloc_memory': 123}]}
many_report = {'jobs': [{'job_id': i, 'tres_req_str': 'cpu=4,mem=8G,node=1,gres/gpu=2',
                        'tres_alloc_str': 'cpu=64,mem=128G,gres/gpu=4', 'cpus': optional(64),
                        'time_limit': optional(1440)}
                       for i in range(1, 210)]}
enriched, calls = enrich_requests(many_jobs, many_report)
assert calls == ['build', 'query']
assert len(enriched['squeue']) == 209
assert all(job['req_cpus'] == '4' and job['req_mem'] == '8G'
           and job['req_mem_scope'] == 'total' and job['req_gpus'] == '2'
           and job['alloc_gpus'] == '4' and job['time_limit'] == '1-00:00:00'
           for job in enriched['squeue'])
# The original builder's node allocation calculation is not rerun or modified.
assert enriched['sinfo'] == [{'hostname': 'server1', 'alloc_memory': 123}]

assert bridge.slurm_job_request({'cpus': optional(12), 'memory_per_node': optional(4096)}) == {
    'req_cpus': '12', 'req_mem': '4096M', 'req_mem_scope': 'node'}
assert bridge.slurm_job_request({'memory_per_node': optional(0, present=False),
                                'memory_per_cpu': optional(2048)}) == {
    'req_mem': '2048M', 'req_mem_scope': 'cpu'}
assert bridge.slurm_job_request({'tres_req_str': 'cpu=2,mem=512000',
                                'memory_per_node': optional(0)}) == {
    'req_cpus': '2', 'req_mem': '0M', 'req_mem_scope': 'node'}
assert bridge.slurm_job_request({'tres_req_str': 'mem=512000',
                                'memory_per_node': optional(0, present=False)}) == {
    'req_mem': '512000M', 'req_mem_scope': 'total'}
assert bridge.slurm_job_request({'tres_req_str': 'mem=1.5G'}) == {
    'req_mem': '1.5G', 'req_mem_scope': 'total'}
# Allocated resources and unset/infinite optional wrappers cannot be used as
# requested resources; booleans, non-finite values and negative values are invalid.
for invalid in (optional(16, present=False), optional(16, infinite=True),
                {'set': True, 'number': 16}, {'set': False, 'number': 0},
                True, None, -1, float('inf'), float('nan'), 'NaN'):
    assert bridge.slurm_job_request({'cpus': invalid, 'memory_per_node': invalid,
                                    'memory_per_cpu': invalid, 'tres_alloc_str': 'cpu=64,mem=128G'}) == {}
assert bridge.slurm_job_request({'tres_req_str': 'cpu=invalid,mem=invalid',
                                'cpus': optional(6), 'memory_per_cpu': optional(1024)}) == {
    'req_cpus': '6', 'req_mem': '1024M', 'req_mem_scope': 'cpu'}

# Slurm reports the maximum run time in integer minutes. Infinite is a separate
# flag, including set=false, rather than an unset value or an enormous duration.
for minutes, expected in ((0, '00:00:00'), (1, '00:01:00'), (30, '00:30:00'),
                          (90, '01:30:00'), (1440, '1-00:00:00'),
                          (2160, '1-12:00:00'), (43200, '30-00:00:00')):
    for raw in (minutes, optional(minutes)):
        assert bridge.slurm_time_limit(raw) == expected
        assert bridge.slurm_job_request({'time_limit': raw, 'time_minimum': optional(1),
                                        'elapsed': 12, 'start_time': 100, 'end_time': 112}) == {
            'time_limit': expected}
for raw in (optional(0, present=False, infinite=True), optional(0, infinite=True),
            'Infinity', 4294967295):
    assert bridge.slurm_time_limit(raw) == 'UNLIMITED'
for invalid in (None, True, False, '', '90', '01:30:00', 'NOT_SET', 'NaN',
                -1, 1.5, float('inf'), float('nan'), 4294967294, 4294967296,
                optional(90, present=False), optional(4294967294), optional(4294967295),
                optional(True), optional(1.5), {'set': True, 'number': 90},
                {'set': 'false', 'infinite': True, 'number': 0}):
    assert bridge.slurm_time_limit(invalid) is None, invalid
    assert bridge.slurm_job_request({'time_limit': invalid}) == {}
assert bridge.slurm_job_request({'time_minimum': optional(90), 'elapsed': 30,
                                'start_time': 100, 'end_time': 5500}) == {}
# Pending and running jobs both carry the reported limit; do not derive it from
# elapsed time or predicted scheduling dates. Unavailable queries retain source.
timed_payload = {'squeue': [{'job_id': '21', 'state': 'PENDING'},
                           {'job_id': '22', 'state': 'RUNNING'},
                           {'job_id': '23', 'time_limit': '02:00:00'}]}
timed_report = {'jobs': [{'job_id': 21, 'time_limit': optional(1440)},
                         {'job_id': 22, 'time_limit': optional(90)},
                         {'job_id': 23, 'time_limit': optional(0, present=False)}]}
timed_result, timed_calls = enrich_requests(timed_payload, timed_report)
assert timed_calls == ['build', 'query']
assert [job['time_limit'] for job in timed_result['squeue']] == ['1-00:00:00', '01:30:00', '02:00:00']

# Job 54901 reserves two GPUs even when only one GPU has an observed process.
# Per-node GRES and its IDX values must not become NVIDIA device identities.
job_54901 = {'job_id': 54901, 'cpus': optional(16), 'memory_per_node': optional(122880),
             'tres_req_str': 'cpu=16,mem=120G,node=1,billing=16,gres/gpu=2',
             'tres_alloc_str': 'cpu=16,mem=120G,node=1,billing=16,gres/gpu=2',
             'tres_per_node': 'gres/gpu:a6000:2', 'gres_detail': ['gpu:a6000:2(IDX:0,2)']}
gpu_result, gpu_calls = enrich_requests({'squeue': [{'job_id': '54901', 'req_gpus': ''}]},
                                       {'jobs': [job_54901]})
assert gpu_calls == ['build', 'query']
assert gpu_result['squeue'] == [{'job_id': '54901', 'req_cpus': '16', 'req_mem': '120G',
                               'req_mem_scope': 'total', 'req_gpus': '2', 'alloc_gpus': '2'}]
for tres, expected in (
        ('cpu=16,gres/gpu=2', 2),
        ('gres/gpu=2,gres/gpu:a6000=2', 2),
        ('gres/gpu:a100=2,gres/gpu:v100=1', 3),
        ('gres/gpu:a100=2,gres/gpu:v100=1,gres/gpu=3', 3),
        ('gres/gpu=0', 0),
        ('gres/gpu:a100=0', 0),
        ('gres/gpuutil=100,gres/gpumem=4096,gres/mps=20,gres/gpu=2', 2),
        ('cpu=4,gres/gpuutil=100,gres/mps=20', None),
        ('', None), (None, None), (True, None),
        ('gres/gpu=2,gres/gpu=2', None),
        ('gres/gpu=1,gres/gpu=2', None),
        ('gres/gpu:a100=2,gres/gpu:a100=2', None),
        ('gres/gpu:a100=2,gres/gpu:v100=invalid', None),
        ('gres/gpu=invalid,gres/gpu:a100=2', None),
        ('gres/gpu=2,gres/gpu:v100=invalid', None),
        ('gres/gpu:=2', None),
        ('gres/gpu', None),
        ('gres/gpu:a100', None)):
    assert bridge.slurm_gpu_count(tres) == expected, tres
for invalid in ('-1', '1.5', '1e3', 'NaN', 'inf', 'true', '', '2=3'):
    assert bridge.slurm_gpu_count('gres/gpu=' + invalid) is None
assert bridge.slurm_job_request({'tres_req_str': 'gres/gpu=2', 'tres_alloc_str': ''}) == {'req_gpus': '2'}
assert bridge.slurm_job_request({'tres_req_str': '', 'tres_alloc_str': 'gres/gpu=2'}) == {'alloc_gpus': '2'}
assert bridge.slurm_job_request({'tres_req_str': 'gres/gpu=0', 'tres_alloc_str': 'gres/gpu=0'}) == {
    'req_gpus': '0', 'alloc_gpus': '0'}
assert bridge.slurm_job_request({'tres_per_node': 'gres/gpu:a6000:2',
                                'gres_detail': ['gpu:a6000:2(IDX:0,2)']}) == {}
# A failed or unavailable bulk GPU field preserves what the source did report.
gpu_original = {'squeue': [{'job_id': '54901', 'req_gpus': '2', 'alloc_gpus': '2'}]}
for raw_job in ({'job_id': 54901}, {'job_id': 54901, 'tres_req_str': 'gres/gpu=invalid',
                                 'tres_alloc_str': 'gres/gpu=1,gres/gpu=2'}):
    assert enrich_requests(json.loads(json.dumps(gpu_original)), {'jobs': [raw_job]})[0] == gpu_original

# Match numeric jobs, opaque SLUIDs, exact individual array tasks and exact
# aggregate expressions. Never let a source-provided parent alias match siblings.
identities_payload = {'squeue': [
    {'job_id': '500_0'}, {'job_id': '500_1'}, {'job_id': '500_[2-8%3]'},
    {'job_id': 'sD8DM3P9RE0E00'}, {'job_id': '602'},
    {'job_id': '500_9', 'job_id_aliases': ['500', 'sParent']},
    {'job_id': '500_[2-5]', 'job_id_aliases': ['500', 'sParent']},
    {'job_id': '700', 'req_cpus': 'original'},
]}
identity_report = {'jobs': [
    {'job_id': 601, 'array_job_id': optional(500), 'array_task_id': optional(0),
     'tres_req_str': 'cpu=1,mem=1G'},
    {'job_id': 602, 'array_job_id': optional(500), 'array_task_id': optional(1),
     'step_id': {'sluid': 'sD8DM3P9RE0E00'}, 'tres_req_str': 'cpu=2,mem=2G'},
    {'job_id': 500, 'array_job_id': optional(500), 'array_task_id': optional(0, present=False),
     'array_task_string': '2-8%3', 'step_id': {'sluid': 'sParent'}, 'tres_req_str': 'cpu=8,mem=8G'},
    {'job_id': 700, 'tres_req_str': 'cpu=3,mem=3G'},
    {'job_id': 700, 'tres_req_str': 'cpu=4,mem=4G'},
]}
identity_result, _ = enrich_requests(identities_payload, identity_report)
assert [job.get('req_cpus') for job in identity_result['squeue']] == ['1', '2', '8', '2', '2', None, None, 'original']
assert not any('req_mem' in job for job in identity_result['squeue'][5:])

original = {'squeue': [{'job_id': '123', 'req_cpus': '4', 'req_mem': '6G', 'req_mem_scope': 'total',
                        'time_limit': '01:00:00'}]}
for report in (None, {}, {'jobs': None}, {'jobs': []}, {'errors': ['query failed'], 'jobs': [{'job_id': 123}]},
               {'jobs': [{'job_id': 999, 'tres_req_str': 'cpu=8,mem=8G'}]},
               {'jobs': [{'job_id': 123, 'cpus': optional(4, present=False)}]}):
    payload = json.loads(json.dumps(original))
    assert enrich_requests(payload, report)[0] == original
assert enrich_requests(json.loads(json.dumps(original)), error=RuntimeError('Slurm unavailable'))[0] == original
for payload in (None, {}, {'squeue': []}):
    assert enrich_requests(payload, {'jobs': []})[1] == ['build']
non_slurm = SimpleNamespace(build_payload=lambda: original, run_slurm_json=lambda *_: None)
non_slurm_build = non_slurm.build_payload
bridge.install_slurm_job_requests(non_slurm, 'node')
assert non_slurm.build_payload is non_slurm_build

# A lab report already measures true available space. Keep its values and only
# attach the actual paths selected by the source module.
lab = SimpleNamespace(DISK_PATH='/', SUBDISK_PATH='/mnt/raid5', build_payload=lambda: {
    'total_disk_gb': 100, 'used_disk_gb': 80, 'free_disk_gb': 15,
    'total_subdisk_gb': 1000, 'used_subdisk_gb': 950, 'free_subdisk_gb': 0,
})
bridge.install_storage_reporting(lab, 'node')
with patch.object(bridge.shutil, 'disk_usage', side_effect=AssertionError('No second lab disk query')):
    lab_payload = lab.build_payload()
assert lab_payload['disk_path'] == '/'
assert lab_payload['subdisk_path'] == '/mnt/raid5'
assert lab_payload['free_disk_gb'] == 15
assert lab_payload['free_subdisk_gb'] == 0

# The cloud source omits free space. Sample all disk fields together so the free
# capacity does not accidentally include reserved blocks (100 - 80 != 15).
cloud = SimpleNamespace(DISK_PATH='/home', build_payload=lambda: {
    'system': {'total_disk_gb': 123, 'used_disk_gb': 99, 'disk_percent': 99, 'cpu_percent': 30},
    'gpus': [{'index': 0}],
})
bridge.install_storage_reporting(cloud, 'cloud-gpu')
gib = 1024 ** 3
with patch.object(bridge.shutil, 'disk_usage', return_value=SimpleNamespace(
        total=100 * gib, used=80 * gib, free=15 * gib)) as disk_usage:
    cloud_payload = cloud.build_payload()
disk_usage.assert_called_once_with('/home')
assert cloud_payload['system'] == {'total_disk_gb': 100, 'used_disk_gb': 80,
    'free_disk_gb': 15, 'disk_percent': 84.2, 'cpu_percent': 30, 'disk_path': '/home'}
assert cloud_payload['gpus'] == [{'index': 0}]
with patch.object(bridge.shutil, 'disk_usage', return_value=SimpleNamespace(
        total=100 * gib, used=95 * gib, free=0)):
    full_disk = cloud.build_payload()['system']
assert full_disk['free_disk_gb'] == 0 and full_disk['disk_percent'] == 100
with patch.object(bridge.shutil, 'disk_usage', side_effect=OSError('Mount unavailable')):
    failed_disk = cloud.build_payload()['system']
assert all(failed_disk[key] is None for key in (
    'total_disk_gb', 'used_disk_gb', 'free_disk_gb', 'disk_percent'))
assert failed_disk['cpu_percent'] == 30 and failed_disk['disk_path'] == '/home'
failed_agent = SimpleNamespace(build_payload=lambda: None)
bridge.install_storage_reporting(failed_agent, 'node')
assert failed_agent.build_payload() is None
slurm = SimpleNamespace(build_payload=lambda: {'squeue': []})
original_slurm = slurm.build_payload
bridge.install_storage_reporting(slurm, 'slurm')
assert slurm.build_payload is original_slurm
responses = iter([
    SimpleNamespace(status_code=503, headers={}),
    SimpleNamespace(status_code=503, headers={'Retry-After': '50000'}),
    SimpleNamespace(status_code=200, headers={}),
    RuntimeError('network unavailable'),
    SimpleNamespace(status_code=503, headers={'Retry-After': 'NaN'}),
    SimpleNamespace(status_code=200, headers={}),
])
def fake_post(*args, **kwargs):
    value = next(responses)
    if isinstance(value, Exception): raise value
    return value
module = SimpleNamespace(SESSION=SimpleNamespace(post=fake_post), REPORT_INTERVAL_SEC=15)
bridge.install_report_backoff(module, 15)
module.SESSION.post(); assert module.REPORT_INTERVAL_SEC == 30
module.SESSION.post(); assert module.REPORT_INTERVAL_SEC == 300
module.SESSION.post(); assert module.REPORT_INTERVAL_SEC == 15
try: module.SESSION.post()
except RuntimeError: pass
else: raise AssertionError('Network error must propagate')
assert module.REPORT_INTERVAL_SEC == 30
module.SESSION.post(); assert module.REPORT_INTERVAL_SEC == 60
module.SESSION.post(); assert module.REPORT_INTERVAL_SEC == 15
print('PASS: bulk Slurm requests beyond 200 jobs, minute-based finite/unlimited/unset time limits, separate requested/allocated GPU totals without typed duplication, total/scoped/all-node RAM, optional numeric flags, exact array identity and graceful failure; true available disk capacity, full/missing disks and monitored paths; 15-second reports, bounded failure backoff and recovery; credentials stay private.')
