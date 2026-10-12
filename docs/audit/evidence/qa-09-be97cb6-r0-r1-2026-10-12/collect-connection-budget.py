"""Read-only 60-second RDS Maximum samples for a completed bounded unit."""
import json,sys,subprocess,datetime,hashlib
from pathlib import Path
p=Path(sys.argv[1]);window=json.loads((p/'business-window.json').read_text())
start=datetime.datetime.fromisoformat(window['startedAt'].replace('Z','+00:00'))-datetime.timedelta(minutes=2)
end=datetime.datetime.now(datetime.timezone.utc)
args=['aws','cloudwatch','get-metric-statistics','--namespace','AWS/RDS','--metric-name','DatabaseConnections','--dimensions','Name=DBInstanceIdentifier,Value=fdp-test-db','--start-time',start.isoformat(),'--end-time',end.isoformat(),'--period','60','--statistics','Maximum','--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager']
(p/'connection-metrics.command.json').write_text(json.dumps(args,indent=2)+'\n')
q=subprocess.run(args,capture_output=True,text=True,timeout=180)
(p/'connection-metrics.stderr.log').write_text(q.stderr);(p/'connection-metrics.exit').write_text(str(q.returncode)+'\n')
assert q.returncode==0,'READ_ONLY_METRICS_UNAVAILABLE'
(p/'connection-metrics.json').write_text(q.stdout)
r=json.loads(q.stdout);points=sorted(r['Datapoints'],key=lambda v:v['Timestamp'])
assert points and all(v['Unit']=='Count' for v in points),'NO_CONNECTION_SAMPLES'
maximum=max(v['Maximum'] for v in points)
parse=lambda t:datetime.datetime.fromisoformat(t.replace('Z','+00:00'))
times=[parse(v['Timestamp']) for v in points]
businessStart=parse(window['startedAt']);businessEnd=parse(window['finishedAt']);recoveryBindings={}
for n in ['parent-cleanup-recovery.json','database-empty-audit.json']:
 if (p/n).exists():
  v=json.loads((p/n).read_text());assert v['gate']=='PASS'
  t=v.get('finishedAt') or v.get('build',{}).get('endTime')
  if t:businessEnd=max(businessEnd,parse(t))
  recoveryBindings[n]=hashlib.sha256((p/n).read_bytes()).hexdigest()
coverage=times[0]<=businessStart+datetime.timedelta(seconds=120) and times[-1]>=businessEnd-datetime.timedelta(seconds=120) and all((b-a).total_seconds()<=120 for a,b in zip(times,times[1:]))

result={'gate':'PASS' if maximum<=70 and coverage else 'BLOCKED','scope':'OBSERVED_60_SECOND_CLOUDWATCH_DATABASE_CONNECTION_MAXIMUM','observedMaximum':maximum,'maxBudget':70,'sampleCount':len(points),'startedAt':start.isoformat(),'endedAt':end.isoformat(),'periodSeconds':60,'businessWindowSampleCoverage':coverage,'coverageRequiredThrough':businessEnd.isoformat(),'ownedCleanupAndEmptyAuditBindings':recoveryBindings,'coverageToleranceSeconds':120,'continuousInstantPeakProven':False,'samplingLimit':'CloudWatch sampled metrics do not prove unsampled instantaneous peaks','bindings':{'connection-metrics.json':hashlib.sha256((p/'connection-metrics.json').read_bytes()).hexdigest(),'business-window.json':hashlib.sha256((p/'business-window.json').read_bytes()).hexdigest()},'p95Accepted':False}
(p/'connection-budget-gate.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
assert result['gate']=='PASS','CONNECTION_BUDGET_EXCEEDED'
