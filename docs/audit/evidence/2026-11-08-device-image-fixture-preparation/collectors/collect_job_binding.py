"""Read existing job source; never start/update a job or execute fetched commands."""
import hashlib
import importlib.util
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
ROOT = Path(__file__).resolve().parents[5]
spec = importlib.util.spec_from_file_location('reader', Path(__file__).with_name('collect_readonly.py'))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
identity = reader.aws('sts', 'get-caller-identity')
assert identity['status'] == 'OBSERVED'
reader.guard_identity(identity['data'])
value = reader.aws('codebuild', 'batch-get-projects', ['--names', 'fdp-test-qa09-readonly-runner'], 'projects[0].source.buildspec')
expected = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {prepareProbe} from './scripts/prepare-qa09-db-readonly-probe.mjs'; console.log(prepareProbe().project.source.buildspec);"], cwd=ROOT))
result = {'status': 'BLOCKED', 'projectName': 'fdp-test-qa09-readonly-runner',
    'capturedAt': datetime.now(timezone.utc).isoformat(), 'jobStarted': False, 'cloudWrites': 0}
normalize = lambda obj: json.dumps(obj, sort_keys=True, separators=(',', ':')).encode()
if value['status'] == 'OBSERVED':
    actual = json.loads(value['data'])
    result.update({'actualBuildspecSha256': hashlib.sha256(normalize(actual)).hexdigest(),
        'expectedBuildspecSha256': hashlib.sha256(normalize(expected)).hexdigest(),
        'matchesCurrentReadOnlyProbeBuildspec': actual == expected})
    # Store only hashes and sanitized differences, never execute downloaded source.
    differences = []
    for phase in sorted(set(actual.get('phases', {})) | set(expected.get('phases', {}))):
        left = actual.get('phases', {}).get(phase, {})
        right = expected.get('phases', {}).get(phase, {})
        if left != right:
            differences.append({'phase': phase, 'actualKeys': sorted(left), 'expectedKeys': sorted(right),
                'actualCommandCount': len(left.get('commands', [])), 'expectedCommandCount': len(right.get('commands', []))})
    result['differences'] = differences
    if actual == expected:
        result['status'] = 'PASS_SOURCE_BINDING_ONLY'
else:
    result['errorCategory'] = value.get('errorCategory')
(BASE / 'readonly-job-binding.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
