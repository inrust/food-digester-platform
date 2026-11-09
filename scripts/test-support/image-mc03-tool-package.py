"""Independently read both local ZIPs and import the exact compiled handlers."""
from pathlib import Path
import hashlib
import subprocess
import tempfile
import zipfile

base = Path('build/img21-mc02')
for kind in ['writer', 'verifier']:
    with zipfile.ZipFile(base / (kind + '.zip')) as archive:
        assert archive.namelist() == ['index.mjs', 'run-manifest.json']
        assert archive.testzip() is None
        assert archive.read('run-manifest.json') == (base / (kind + '-manifest.json')).read_bytes()
        code = archive.read('index.mjs')
        assert code == (base / ('code/' + kind + '.mjs')).read_bytes()
        assert all(i.date_time == (1980, 1, 1, 0, 0, 0) for i in archive.infolist())
        with tempfile.TemporaryDirectory(prefix='fdp-mc03-smoke-') as temp:
            entry = Path(temp) / 'index.mjs'
            entry.write_bytes(code)
            js = """const m=await import(process.argv[1]);
const r=await m.handler({}, {functionVersion:'$LATEST',invokedFunctionArn:'invalid'});
if(r.status!=='REJECTED') throw Error('BUNDLED_HANDLER_NOT_CLOSED');"""
            subprocess.run(['node', '--check', str(entry)], check=True)
            subprocess.run(['node', '--input-type=module', '-e', js, entry.as_uri()], check=True)
    print('PASS exact ZIP and default-closed entry', kind, hashlib.sha256((base / (kind + '.zip')).read_bytes()).hexdigest())
