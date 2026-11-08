import importlib.util
import json
import tempfile
import unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('job',HERE/'run_readonly_job.py')
job=importlib.util.module_from_spec(spec);spec.loader.exec_module(job)


class ExecutionGuardTests(unittest.TestCase):
    def setUp(self):
        self.scope=json.loads((job.PREP/'write-approval-request.json').read_text())
        self.raw=(job.PREP/'readonly-db-start.request.json').read_bytes()
        self.now=datetime.now(timezone.utc)
        self.window={'approved':True,'g4WritesAllowed':False,'startsAt':self.now.isoformat(),
            'endsAt':(self.now+timedelta(minutes=90)).isoformat()}

    def test_exact_approved_request(self):
        self.assertEqual(job.validate_request(self.raw,self.scope)['projectName'],job.PROJECT)

    def test_changed_source_or_scope_rejected(self):
        for mutate in [lambda r:r.update(projectName='other-project'),lambda r:r.update(buildspecOverride='mutated'),
                lambda r:r.update(environmentVariablesOverride=[{'name':'DB_SECRET_ARN','value':'foreign'}])]:
            req=json.loads(self.raw);mutate(req)
            with self.assertRaisesRegex(ValueError,'REQUEST_HASH_DRIFT'):
                job.validate_request(json.dumps(req).encode(),self.scope)

    def test_only_preparation_window(self):
        job.validate_window(self.window,self.now)
        for flag in ['approved','g4WritesAllowed']:
            w=dict(self.window);w[flag]=not w[flag]
            with self.assertRaises(ValueError):job.validate_window(w,self.now)

    def test_expired_or_not_started_or_overlong_window(self):
        for now in [self.now-timedelta(seconds=1),self.now+timedelta(minutes=90)]:
            with self.assertRaises(ValueError):job.validate_window(self.window,now)
        w=dict(self.window);w['endsAt']=(self.now+timedelta(minutes=91)).isoformat()
        with self.assertRaises(ValueError):job.validate_window(w,self.now)

    def test_unknown_prior_attempt_never_retried(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(job,'BASE',Path(directory)),patch.object(job,'run_aws') as aws:
            (Path(directory)/'start-attempt.json').write_text('{"state":"UNKNOWN"}')
            with self.assertRaisesRegex(ValueError,'PRIOR_ATTEMPT_EXISTS_NO_RETRY'):
                job.start_once(self.window,self.scope)
            aws.assert_not_called()

    def test_unknown_start_is_recorded_without_retry(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(job,'BASE',Path(directory)),patch.object(job,'run_aws',return_value={'status':'UNKNOWN'}) as aws:
            self.assertIsNone(job.start_once(self.window,self.scope));self.assertEqual(aws.call_count,1)
            self.assertTrue((Path(directory)/'start-attempt.json').exists())
            self.assertEqual(json.loads((Path(directory)/'start-result.json').read_text())['status'],'UNKNOWN')

    def test_permission_denial_stops_after_one_attempt(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(job,'BASE',Path(directory)),patch.object(job,'run_aws',return_value={'status':'REJECTED','errorCategory':'AccessDeniedException'}) as aws:
            self.assertIsNone(job.start_once(self.window,self.scope));self.assertEqual(aws.call_count,1)
            self.assertFalse((Path(directory)/'known-build.json').exists())

    def test_returned_build_id_must_belong_to_fixed_project(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(job,'BASE',Path(directory)),patch.object(job,'run_aws',return_value={'status':'RETURNED','data':{'id':'foreign:123'}}):
            with self.assertRaisesRegex(ValueError,'UNEXPECTED_BUILD_ID'):job.start_once(self.window,self.scope)

    def test_expected_build_is_persisted(self):
        build=job.PROJECT+':11111111-2222-4333-8444-555555555555'
        with tempfile.TemporaryDirectory() as directory,patch.object(job,'BASE',Path(directory)),patch.object(job,'run_aws',return_value={'status':'RETURNED','data':{'id':build}}) as aws:
            self.assertEqual(job.start_once(self.window,self.scope),build)
            self.assertEqual(aws.call_count,1)
            self.assertEqual(json.loads((Path(directory)/'known-build.json').read_text())['id'],build)


    def test_native_evidence_is_real_read_only_and_in_preparation_window(self):
        base=HERE.parent
        verified=json.loads((base/'database-verification.json').read_text())
        snapshot=json.loads((base/'database-snapshot.json').read_text())
        window=json.loads((base/'approved-preparation-window.json').read_text())
        self.assertEqual(verified['migrationsApplied'],44)
        self.assertEqual(verified['tables'],61)
        self.assertEqual(snapshot['identity']['read_only'],'on')
        self.assertFalse(snapshot['businessDataWrites'])
        self.assertEqual(snapshot['buildId'],verified['buildId'])
        self.assertTrue(window['startsAt']<=snapshot['executedAt']<=window['endsAt'])

    def test_preparation_window_does_not_authorize_g4_case_writes(self):
        base=HERE.parent
        inputs=json.loads((base/'inputs.json').read_text())
        window=json.loads((base/'approved-preparation-window.json').read_text())
        self.assertTrue(window['approved']);self.assertFalse(window['g4WritesAllowed'])
        self.assertIsNone(inputs['entries']['executionWindowProof']['value'])
        self.assertIsNone(inputs['entries']['testScopeProof']['value'])
        self.assertIsNone(inputs['entries']['deviceId']['value'])
        self.assertEqual(sum(v['value'] is None for v in inputs['entries'].values()),11)

    def test_real_migration_and_plan_proof_cannot_claim_deployment_or_cleanup_execution(self):
        base=HERE.parent
        inputs=json.loads((base/'inputs.json').read_text())
        self.assertIsNone(inputs['entries']['deploymentProof']['value'])
        ledger=json.loads((base/'owned-resource-ledger.json').read_text())
        self.assertFalse(ledger['g4CleanupEvidence']);self.assertEqual(ledger['businessResources'],[])
        cleanup=json.loads((base/'proofs/cleanupPlan.json').read_text())
        migration=json.loads((base/'proofs/migrationProof.json').read_text())
        self.assertTrue(cleanup['planApprovalOnly']);self.assertFalse(cleanup['actualBusinessCleanupRequired'])
        self.assertFalse(migration['g4ExecutionProven']);self.assertTrue(migration['requiresG4WindowRecheck'])


if __name__=='__main__':unittest.main(verbosity=2)
