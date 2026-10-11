"""Temporarily exclude the pre-existing untracked build tree; restore exact bytes in finally."""
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
root = Path(__file__).resolve().parent
build = Path('build')
assert subprocess.check_output(['git','ls-files','build']).strip() == b'', 'UNTRACKED_BUILD_REQUIRED'
assert build.is_dir() and not build.is_symlink()
assert not (root/'build-preservation.json').exists()
def inventory(path):
    result = {}
    for p in sorted(path.rglob('*')):
        if p.is_symlink():
            result[str(p.relative_to(path))] = {'symlink':os.readlink(p)}
        elif p.is_file():
            result[str(p.relative_to(path))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result
before = inventory(build)
temporary = Path(tempfile.mkdtemp(prefix='qa09-preserved-build-'))
held = temporary/'build'
code = -1
try:
    build.rename(held)
    code = subprocess.run(['python3',str(root/'run-local-verify.py'),str(root/'verify-clean')]).returncode
finally:
    assert not build.exists(), 'BUILD_RECREATED_DURING_VERIFY'
    held.rename(build)
    temporary.rmdir()
    after = inventory(build)
    (root/'build-preservation.json').write_text(json.dumps({'gate':'PASS' if before==after else 'FAIL',
        'scope':'PREEXISTING_UNTRACKED_BUILD_RESTORED','before':before,'after':after,
        'verifyExitCode':code,'noCloudActions':True},indent=2)+'\n')
    assert before == after, 'BUILD_RESTORE_BYTES'
raise SystemExit(code)
