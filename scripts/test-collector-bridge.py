"""Exercise bridge configuration with fake agents; no network or GPU required."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import importlib.util
from types import SimpleNamespace

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
print('PASS: all collector kinds use 15-second reports; failed requests back off, quota Retry-After is bounded, success resumes normal cadence; credentials stay private.')
