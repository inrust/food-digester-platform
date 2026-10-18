"""Collect the fixed fixture executor's completed, source-bound cleanup receipt."""
from pathlib import Path
import json
import subprocess
import hashlib
import base64

P = Path(__file__).parent


def aws(args):
    r = subprocess.run(['aws', *args, '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1',
                        '--output', 'json', '--no-cli-pager'], capture_output=True, text=True, timeout=45)
    if r.returncode:
        raise RuntimeError('AWS_READ_FAILED')
    return json.loads(r.stdout)


def main():
    project = json.loads((P / 'fixture-project.json').read_text())
    plan = json.loads((P / 'acceptance.receipt.json.cleanup-plan.json').read_text())
    started = json.loads((P / 'fixture-cleanup.started.json').read_text())
    build_id = started['build']['id']
    build = aws(['codebuild', 'batch-get-builds', '--ids', build_id])['builds'][0]
    assert build['buildStatus'] == 'SUCCEEDED' and build['id'] == build_id
    assert build_id.startswith(project['name'] + ':')
    assert build['source']['type'] == 'NO_SOURCE'
    assert build['source']['buildspec'] == project['source']['buildspec']
    assert build['serviceRole'] == project['serviceRole'] and build['vpcConfig'] == project['vpcConfig']
    variables = {v['name']: v['value'] for v in build['environment']['environmentVariables']}
    source_hash = hashlib.sha256((P / 'fixture-executor.mjs').read_bytes()).hexdigest()
    assert variables['ONBOARDING_FIXTURE_SHA256'] == source_hash
    assert json.loads(base64.b64decode(variables['ONBOARDING_FIXTURE_PLAN_B64'])) == plan
    pages = []
    token = None
    while True:
        args = ['logs', 'get-log-events', '--log-group-name', build['logs']['groupName'],
                '--log-stream-name', build['logs']['streamName'], '--start-from-head']
        if token:
            args += ['--next-token', token]
        page = aws(args)
        pages.append(page)
        if page['nextForwardToken'] == token:
            break
        token = page['nextForwardToken']
    (P / 'fixture-cleanup.logs.json').write_text(json.dumps(pages, indent=2) + '\n')
    frames = []
    for page in pages:
        for event in page['events']:
            try:
                data = json.loads(event['message'].strip())
                if data.get('kind') == 'onboarding-rollout-fixture/v1':
                    frames.append(data)
            except (ValueError, AttributeError):
                pass
    assert len(frames) == 1
    frame = frames[0]
    assert frame['buildId'] == build_id and frame['sourceHash'] == source_hash and frame['plan'] == plan
    assert frame['gate'] == 'PASS' and frame['auditPreserved'] is True
    assert frame['requests'][0]['status'] == 'APPROVED' and frame['jobs'][0]['status'] == 'COMPLETED'
    frame['buildVerification'] = {'id': build_id, 'status': build['buildStatus'],
                                  'buildspecSha256': hashlib.sha256(build['source']['buildspec'].encode()).hexdigest(),
                                  'serviceRole': build['serviceRole'], 'vpcConfig': build['vpcConfig']}
    (P / 'fixture-cleanup.receipt.json').write_text(json.dumps(frame, indent=2) + '\n')
    print(json.dumps({'gate': frame['gate'], 'buildId': build_id, 'deleted': frame['deleted'],
                      'auditPreserved': frame['auditPreserved']}))


if __name__ == '__main__':
    main()
