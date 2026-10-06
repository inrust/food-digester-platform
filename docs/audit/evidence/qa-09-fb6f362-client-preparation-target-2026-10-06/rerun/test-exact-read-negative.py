from pathlib import Path
import runpy
import sys
import json
import copy
import tempfile
import subprocess
import hashlib
p = Path(__file__).resolve().parent
helper = p / 'collect-exact-invocation.py'
original = json.loads((p / 'baseline-patch.third.json').read_text())
cases = [
    ('receipt-hash', 'PRIOR_GATEWAY_BINDING_REQUIRED', lambda d: d.update(sourceReceiptSha256='0' * 64)),
    ('duplicate-gateway', 'UNIQUE_GATEWAY_REQUIRED', lambda d: d['records'][0]['gateway'].append(copy.deepcopy(d['records'][0]['gateway'][0]))),
    ('wrong-status', 'GATEWAY_TIME_STATUS_REQUIRED', lambda d: d['records'][0]['gateway'][0].update(status='500')),
    ('outside-window', 'GATEWAY_TIME_STATUS_REQUIRED', lambda d: d['records'][0]['gateway'][0].update(requestTimeEpoch='0')),
    ('unknown-invocation', 'EXACT_INVOCATION_REQUIRED', lambda d: d['records'][0]['gateway'][0].update(integrationRequestId='untrusted')),
]
rows = []
oldargs = sys.argv[:]
oldrun = subprocess.run
try:
    def reject_network(*args, **kwargs):
        raise AssertionError('READ_QUERY_REACHED')
    subprocess.run = reject_network
    with tempfile.TemporaryDirectory(prefix='qa09-exact-log-negative-') as tmp:
        for name, expected, mutate in cases:
            d = copy.deepcopy(original)
            mutate(d)
            prior = Path(tmp) / 'prior.json'
            prior.write_text(json.dumps(d))
            sys.argv = [str(helper), str(p / 'sample.json'), str(Path(tmp) / 'out.json'), str(prior)]
            try:
                runpy.run_path(str(helper), run_name='__main__')
                raise AssertionError('INVALID_PRIOR_ACCEPTED')
            except ValueError as e:
                assert str(e) == expected
            rows.append({'id': name, 'result': 'PASS', 'rejection': expected, 'awsQueryIssued': False})
finally:
    sys.argv = oldargs
    subprocess.run = oldrun
out = {'gate': 'PASS', 'scope': 'LOCAL_EVIDENCE_HELPER_INVALID_PRIOR_REJECTION_NO_AWS_QUERY', 'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(), 'testSourceSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'checks': rows}
(p / 'exact-read-negative-tests.json').write_text(json.dumps(out, indent=2) + '\n')
print('5 negative checks PASS; no AWS query issued')
