"""Bounded AWS metadata reads only; no credential reads, jobs, invocation or mutations."""
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
BASE = Path(__file__).resolve().parents[1]
ACCOUNT = '065986019555'
REGION = 'ap-southeast-1'
STACK = 'fdp-test-app'
PROFILE = 'esgiot-readonly'
HISTORY = ROOT / 'docs/audit/evidence/2026-11-08-device-image-G4-readiness/observations/asset-full-object-sha256.json'
ALLOWED = {('sts', 'get-caller-identity'), ('cloudformation', 'describe-stacks'),
    ('lambda', 'get-function-configuration'), ('dynamodb', 'describe-table'),
    ('dynamodb', 'describe-time-to-live'), ('codebuild', 'batch-get-projects'),
    ('cognito-idp', 'describe-user-pool-client'), ('cognito-idp', 'get-group')}


def guard_identity(value):
    if value.get('Account') != ACCOUNT or not re.match(
            rf'^arn:aws:sts::{ACCOUNT}:assumed-role/AWSReservedSSO_FDP-ReadOnlyOps_[A-Za-z0-9]+/', value.get('Arn', '')):
        raise ValueError('WRONG_ACCOUNT_OR_READONLY_ROLE')


def guard_stack(value):
    tags = {t['Key']: t['Value'] for t in value.get('Tags', [])}
    if value.get('StackName') != STACK or not value.get('StackId', '').startswith(
            f'arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{STACK}/') or tags.get('fdp:env') != 'test' or tags.get('fdp:project') != 'food-digester-platform':
        raise ValueError('UNVERIFIED_TEST_STACK')


def aws(service, operation, args=(), query=None):
    if (service, operation) not in ALLOWED:
        raise ValueError('READ_OPERATION_NOT_ALLOWED')
    cmd = ['aws', service, operation, *args, '--profile', PROFILE, '--region', REGION,
        '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '5', '--cli-read-timeout', '15']
    if query:
        cmd += ['--query', query]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
            env={**os.environ, 'AWS_MAX_ATTEMPTS': '1', 'AWS_PAGER': ''})
        if p.returncode:
            error = next((c for c in ['AccessDeniedException', 'AccessDenied', 'ExpiredToken',
                'ResourceNotFoundException', 'UnauthorizedException'] if c in p.stderr), 'READ_UNAVAILABLE')
            return {'status': 'BLOCKED', 'operation': service + ':' + operation, 'errorCategory': error}
        return {'status': 'OBSERVED', 'operation': service + ':' + operation, 'data': json.loads(p.stdout)}
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        return {'status': 'BLOCKED', 'operation': service + ':' + operation, 'errorCategory': 'BOUNDED_READ_FAILED'}


def collect():
    identity = aws('sts', 'get-caller-identity')
    if identity['status'] != 'OBSERVED':
        return {'status': 'BLOCKED', 'identity': identity, 'cloudWrites': 0}
    guard_identity(identity['data'])
    stack = aws('cloudformation', 'describe-stacks', ['--stack-name', STACK],
        'Stacks[0].{StackName:StackName,StackId:StackId,StackStatus:StackStatus,Tags:Tags,Outputs:Outputs}')
    if stack['status'] != 'OBSERVED':
        return {'status': 'BLOCKED', 'stack': stack, 'cloudWrites': 0}
    guard_stack(stack['data'])
    allowed_outputs = {'AdminApiUrl', 'DeviceApiUrl', 'OnboardingApiUrl', 'MediaBucketName',
        'UserPoolId', 'UserPoolClientId', 'AdminBootstrapRunnerProjectName'}
    stack['data']['Outputs'] = [v for v in stack['data']['Outputs'] if v['OutputKey'] in allowed_outputs]
    history = json.loads(HISTORY.read_text())
    if history['sourceCommit'] != '69c76e1dd508bf6e03dd21992194a8280109cd0a' or len(history['lambdaArtifacts']) != 20:
        raise ValueError('HISTORICAL_INVENTORY_DRIFT')
    names = [v['name'] for v in history['lambdaArtifacts']]
    if len(set(names)) != 20 or any(not n.startswith('fdp-test-') for n in names):
        raise ValueError('LAMBDA_SCOPE_DRIFT')
    query = '{codeSha256:CodeSha256,revisionId:RevisionId,state:State,lastUpdateStatus:LastUpdateStatus,control:Environment.Variables.LIVE_IMAGE_CONTROL_TABLE,payload:Environment.Variables.LIVE_IMAGE_PAYLOAD_TABLE}'
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        values = list(pool.map(lambda n: aws('lambda', 'get-function-configuration', ['--function-name', n], query), names))
    functions = []
    for old, value in zip(history['lambdaArtifacts'], values):
        current = value.get('data', {})
        functions.append({'name': old['name'], **value,
            'matchesHistoricalCode': value['status'] == 'OBSERVED' and current.get('codeSha256') == old['current']['codeSha256'],
            'historicalRevisionUnchanged': current.get('revisionId') == old['current']['revisionId']})
    tables = []
    for name in ['fdp-test-live-image-control', 'fdp-test-live-image-payload']:
        tables.append({'table': name,
            'configuration': aws('dynamodb', 'describe-table', ['--table-name', name],
                'Table.{name:TableName,status:TableStatus,keys:KeySchema}'),
            'ttl': aws('dynamodb', 'describe-time-to-live', ['--table-name', name], 'TimeToLiveDescription')})
    pool_id = 'ap-southeast-1_hZMX8LpFo'
    client = aws('cognito-idp', 'describe-user-pool-client', ['--user-pool-id', pool_id,
        '--client-id', '5ljdjsf9g563mc1vdc7vjdjm09'],
        'UserPoolClient.{pool:UserPoolId,client:ClientId,flows:ExplicitAuthFlows,tokenUnits:TokenValidityUnits}')
    viewer_group = aws('cognito-idp', 'get-group', ['--user-pool-id', pool_id,
        '--group-name', 'CustomerViewer'], 'Group.{group:GroupName,pool:UserPoolId}')
    projects = aws('codebuild', 'batch-get-projects', ['--names',
        'fdp-test-qa09-readonly-runner', 'fdp-test-admin-bootstrap-runner'],
        '{projects:projects[].{name:name,arn:arn,serviceRole:serviceRole,vpc:vpcConfig,sourceType:source.type,image:environment.image,variables:environment.environmentVariables[].name},missing:projectsNotFound}')
    return {'status': 'OBSERVED_READONLY_METADATA', 'mode': 'REAL_AWS_READ_ONLY', 'capturedAt': datetime.now(timezone.utc).isoformat(),
        'accountId': ACCOUNT, 'region': REGION, 'stackName': STACK,
        'identity': {'accountVerified': True, 'readOnlyRoleVerified': True}, 'stack': stack, 'functions': functions,
        'tables': tables, 'cognitoClient': client, 'viewerGroup': viewer_group, 'projects': projects,
        'historicalDeploymentSourceCommit': history['sourceCommit'],
        'sourceCandidate': 'd1a7b81196d60ec320e760da3d18de403563fc12',
        'currentDeploymentCommitProven': False, 'databaseQueried': False, 'identitiesCreated': 0,
        'cloudWrites': 0, 'jobsStarted': 0, 'deviceActivations': 0, 'g4': 'NOT_RUN'}


if __name__ == '__main__':
    result = collect()
    (BASE / 'readonly-observations.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'functionsObserved': len(result.get('functions', [])),
        'functionsMatchingHistoricalCode': sum(v['matchesHistoricalCode'] for v in result.get('functions', [])),
        'cloudWrites': 0, 'g4': 'NOT_RUN'}))
