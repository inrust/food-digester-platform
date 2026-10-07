import { randomBytes, randomUUID } from 'node:crypto';
import { runFixture } from '../../../../scripts/qa09-ten-device-bridge.mjs';
const prefix='qa09-'+randomBytes(8).toString('hex');
const plan={prefix,action:'capacity-readonly',devices:Array.from({length:10},(_,i)=>`${prefix}-${String(i+1).padStart(2,'0')}`),customers:['a','b'].map(suffix=>({id:randomUUID(),name:`${prefix}-${suffix}`,suffix}))};
await runFixture(plan,process.argv[2],p=>console.log(p));
