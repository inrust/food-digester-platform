import importlib.util
import hashlib
import base64
import json
import stat
import unittest
from pathlib import Path
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('img21_readonly', Path(__file__).with_name('collect_readonly.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def load(name):
    return json.loads((BASE / name).read_text())


class PacketTests(unittest.TestCase):
    def test_readonly_role_and_account(self):
        collector.guard_identity({'Account': collector.ACCOUNT,
            'Arn': 'arn:aws:sts::065986019555:assumed-role/AWSReservedSSO_FDP-ReadOnlyOps_abc/session'})
        for account, role in [('000000000000', 'FDP-ReadOnlyOps'), (collector.ACCOUNT, 'FDP-InfraSetup')]:
            with self.assertRaises(ValueError):
                collector.guard_identity({'Account': account, 'Arn': f'arn:aws:sts::{account}:assumed-role/{role}/session'})

    def test_stack_must_be_tagged_test(self):
        value = {'StackName': collector.STACK, 'StackId': f'arn:aws:cloudformation:{collector.REGION}:{collector.ACCOUNT}:stack/{collector.STACK}/id',
            'Tags': [{'Key': 'fdp:env', 'Value': 'test'}, {'Key': 'fdp:project', 'Value': 'food-digester-platform'}]}
        collector.guard_stack(value)
        value['Tags'][0]['Value'] = 'prod'
        with self.assertRaises(ValueError):
            collector.guard_stack(value)

    def test_wrong_identity_stops_all_resource_reads(self):
        with patch.object(collector, 'aws', return_value={'status': 'OBSERVED', 'data': {'Account': '000000000000'}}) as aws:
            with self.assertRaises(ValueError):
                collector.collect()
            self.assertEqual(aws.call_count, 1)

    def test_collector_denies_writes_invocation_and_credential_reads(self):
        for service, action in [('codebuild','start-build'),('lambda','invoke'),('lambda','update-function-code'),
                ('cognito-idp','admin-create-user'),('iot','register-certificate-without-ca'),
                ('dynamodb','put-item'),('secretsmanager','get-secret-value'),('ssm','get-parameter')]:
            with self.subTest(service=service, action=action), self.assertRaises(ValueError):
                collector.aws(service, action)

    def test_13_inputs_are_not_promoted_from_planned_names(self):
        inputs = load('inputs.json')
        self.assertEqual(sum(v['value'] is None for v in inputs['entries'].values()), 13)
        self.assertIsNone(inputs['entries']['deviceId']['value'])
        self.assertIsNone(inputs['entries']['viewerARef']['value'])
        self.assertIsNone(inputs['entries']['deployedCommit']['value'])

    def test_no_scope_or_window_is_self_approved(self):
        scope = load('write-approval-request.json'); window = load('window-proposal.json')
        self.assertFalse(scope['approved']); self.assertFalse(scope['executionEnabled'])
        self.assertIsNone(scope['approvalReference']); self.assertFalse(window['approved'])
        self.assertIsNone(window['startsAt']); self.assertIsNone(window['endsAt'])
        self.assertFalse(window['g4WritesIncludedInThisRequest'])

    def test_local_private_key_mode_and_public_csr(self):
        identity = load('local-identity.json')
        directory = Path(identity['privateDirectory'])
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((directory/'device-key.pem').stat().st_mode), 0o600)
        self.assertTrue(identity['csrSignatureVerified']); self.assertFalse(identity['certificateIssued'])
        self.assertTrue((BASE/'device.csr.pem').read_text().startswith('-----BEGIN CERTIFICATE REQUEST-----'))
        self.assertIsNone(identity['targetDeviceId'])

    def test_single_device_and_two_bounded_identities(self):
        r = load('planned-resources.json')
        self.assertEqual(r['countsMaximum']['devices'], 1)
        self.assertEqual(r['countsMaximum']['cognitoUsers'], 2)
        self.assertEqual(r['viewer']['role'], 'CustomerViewer')
        self.assertTrue(r['neverBorrowExistingDevicesUsersOrCertificates'])
        self.assertFalse(r['device']['serverAllowlisted'])

    def test_no_pristine_bootstrap_or_lifecycle_shortcut(self):
        rows = {r['id']:r for r in load('write-approval-request.json')['requestedWrites']}
        self.assertFalse(rows['W02']['pristineAdminBootstrapCliAllowed'])
        self.assertFalse(rows['W02']['bareSql'])
        self.assertFalse(rows['W04']['manualLifecycleOrOperationalStatusUpdate'])
        self.assertFalse(rows['W04']['exportHmacKey'])
        self.assertEqual(rows['W05']['authorityClient'], 'createPreviewAwarePrismaClient')
        self.assertFalse(rows['W05']['directDynamoDbWrite'])

    def test_no_email_or_broad_cleanup(self):
        rows = {r['id']:r for r in load('write-approval-request.json')['requestedWrites']}
        self.assertEqual(rows['W01']['messageAction'], 'SUPPRESS')
        self.assertFalse(rows['W01']['sendNotifications'])
        self.assertFalse(rows['W07']['bulkDeleteOrLifecycleBackdatingAllowed'])
        self.assertIn('CONTROL_AUTH_EPOCH', rows['W07']['preserve'])
        self.assertTrue(load('cleanup-plan.json')['noPlainSqlCleanup'])

    def test_job_start_is_not_mislabeled_as_a_read(self):
        rows = {r['id']:r for r in load('write-approval-request.json')['requestedWrites']}
        self.assertEqual(rows['W06']['action'], 'StartBuild')
        self.assertEqual(rows['W06']['maximumStarts'], 1)
        self.assertTrue(rows['W06']['buildspecOverrideAllowed'])
        self.assertEqual(rows['W06']['overrideRule'], 'EXACT_PINNED_LOCAL_REQUEST_ONLY')
        self.assertEqual(rows['W06']['requestSha256'], load('readonly-db-source.json')['requestSha256'])
        self.assertFalse(rows['W06']['projectUpdateAllowed'])
        raw = (BASE/'readonly-db-start.request.json').read_bytes()
        request = json.loads(raw)
        source = load('readonly-db-source.json')
        self.assertEqual(hashlib.sha256(raw).hexdigest(), source['requestSha256'])
        self.assertEqual(hashlib.sha256(request['buildspecOverride'].encode()).hexdigest(), source['buildspecSha256'])
        self.assertEqual(request['projectName'], 'fdp-test-qa09-readonly-runner')
        env = {v['name']:v['value'] for v in request['environmentVariablesOverride']}
        self.assertEqual(set(env), {'QA09_DB_MANIFEST_B64','QA09_DB_PROBE_SHA256'})
        manifest = json.loads(base64.b64decode(env['QA09_DB_MANIFEST_B64']))
        self.assertEqual(len(manifest['migrations']), 44)
        self.assertEqual(manifest['sourceCommit'], load('inputs.json')['sourceCommit'])
        self.assertFalse(source['approved'])


    def test_http_intents_cannot_execute_placeholders(self):
        req = load('http-write-intents.json')
        self.assertFalse(req['executable']); self.assertFalse(req['approved'])
        self.assertTrue(all(r['authorizationRef'] is None for r in req['requests']))
        approve = next(r for r in req['requests'] if r['operationId']=='approveOnboardingRequest')
        self.assertIsNone(approve['body'])

    def test_real_gate_stays_unrun_and_app_is_not_a_dependency(self):
        m = load('admission-materials.json')
        self.assertEqual(m['g4'], 'NOT_RUN'); self.assertFalse(m['appRequired'])
        self.assertEqual(len(m['rows']), 13)
        self.assertTrue(all(r['status']=='BLOCKED' for r in m['rows']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
