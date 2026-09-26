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
print('PASS: true available disk capacity, full/missing disks and monitored paths; 15-second reports, bounded failure backoff and recovery; credentials stay private.')
