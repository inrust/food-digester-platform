"""Redeliver exactly one archived/processed message from the current owned fixture."""
import datetime, gzip, hashlib, json, pathlib, subprocess, sys, tempfile

def main(parent_path, output):
    parent=json.loads(pathlib.Path(parent_path).read_bytes())
    archive=json.loads(pathlib.Path(parent_path+'.archive-read.json').read_bytes())
    observed=json.loads(pathlib.Path(parent_path+'.observe-2.json').read_bytes())['result']
    device=parent['devices'][2]
    assert parent['gate']=='RUNNING' and device==parent['prefix']+'-03'
    assert archive['gate']=='PASS' and archive['prefix']==parent['prefix'] and observed['prefix']==parent['prefix']
    pub=next(x for x in parent['published'] if x['deviceId']==device and x['type']=='telemetry')
    assert any(x['device_id']==device and x['topic_type']=='telemetry' and x['seq']==pub['seq'] and x['payload_hash']==pub['payloadSha256'] and x['result']=='PROCESSED' for x in observed['receipts'])
    outbox=next(x for x in observed['outbox'] if x['aggregate_id']==device and x['messageId']==pub['messageId'] and x['event_type']=='ARCHIVE')
    proof=next(x for x in archive['result']['checks'] if x['eventId']==outbox['id'] and x['rawBodySha256']==outbox['rawBodySha256'])
    key=proof['objectKey']
    assert any(key.startswith('raw/topic_type=telemetry/customer_id='+c['id']+'/') for c in parent['customers'])
    obj=next(x for x in archive['result']['archiveObjects'] if x['key']==key)
    cert=next(x for x in observed['certificates'] if x['device_id']==device and x['status']=='ACTIVE')
    r={'scope':'OWN_ARCHIVED_PROCESSED_TELEMETRY_REDELIVERY','prefix':parent['prefix'],'deviceId':device,'messageId':pub['messageId'],'mqttPublishBodySha256':pub['bodySha256'],'archivedRawBodySha256':outbox['rawBodySha256'],'archiveObjectKey':key,'gate':'NOT_RUN','consumptionProven':False,'queueReadOrPurge':False,'sharedConfigurationChanged':False,'fullQa09Accepted':False,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
    def aws(args, profile):
        x=subprocess.run(['aws',*args,'--profile',profile,'--region','ap-southeast-1','--no-cli-pager','--output','json','--cli-connect-timeout','5','--cli-read-timeout','30'],capture_output=True,text=True,timeout=60,env=__import__('os').environ|{'AWS_MAX_ATTEMPTS':'1'})
        if x.returncode:
            import re
            m=re.search(r'An error occurred \(([A-Za-z0-9]+)\)',x.stderr)
            raise RuntimeError(m.group(1) if m else 'AWS_CLI_FAILED')
        return json.loads(x.stdout or '{}')
    try:
        with tempfile.TemporaryDirectory(prefix='qa09-own-redelivery-') as td:
            f=pathlib.Path(td)/'archive.gz'
            aws(['s3api','get-object','--bucket','fdp-test-raw-065986019555','--key',key,str(f)],'esgiot-readonly')
            data=f.read_bytes();assert hashlib.sha256(data).hexdigest()==obj['compressedSha256']
            lines=[json.loads(x) for x in gzip.decompress(data).splitlines()]
            row=next(x for x in lines if x['deviceId']==device and x['messageId']==pub['messageId'])
            raw=row['rawBody'];assert hashlib.sha256(raw.encode()).hexdigest()==outbox['rawBodySha256']
            payload=json.loads(raw);assert payload['meta']['id']==pub['messageId'] and payload['iotDeviceId']==device and payload['iotPrincipal']==cert['id']
            assert payload['iotTopic']==f'bnx/device/{device}/telemetry' and payload['iotType']=='telemetry'
            envelope=payload
            body=pathlib.Path(td)/'body.json';body.write_text(json.dumps(envelope))
            r['originalBytesVerified']=True
            sent=aws(['sqs','send-message','--queue-url','https://sqs.ap-southeast-1.amazonaws.com/065986019555/fdp-test-ingress','--message-body','file://'+str(body)],'esgiot-infra')
            r.update(gate='SUBMITTED_CONSUMPTION_NOT_PROVEN',sqsMessageId=sent['MessageId'])
    except Exception as e:
        r.update(gate='BLOCKED',errorName=type(e).__name__,errorCode=str(e) if isinstance(e,RuntimeError) else 'OWN_ARCHIVE_PRECONDITION_FAILED')
    r['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    pathlib.Path(output).write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'gate':r['gate'],'errorCode':r.get('errorCode')}))
if __name__=='__main__':main(*sys.argv[1:])
