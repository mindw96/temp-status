"""Exercise bridge configuration with fake agents; no network or GPU required."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

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
print('PASS: node, Slurm and cloud agents use expected endpoints, credentials and settings; config permissions enforced.')
