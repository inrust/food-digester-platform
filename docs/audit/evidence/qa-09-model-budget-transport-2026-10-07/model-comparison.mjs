import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../../../packages/database/package.json', import.meta.url));
const modes = ['lazy-full', 'engine-full', 'engine-select', 'engine-raw'];
if (process.argv[2] === '--child') {
  const mode = process.argv[3];
  if (!modes.includes(mode)) throw Error('INVALID_MODE');
  const { Pool } = require('pg');
  let checkouts = 0, queries = 0, releases = 0;
  const original = Pool.prototype.connect;
  Pool.prototype.connect = function(callback) {
    checkouts++;
    const release = () => releases++;
    const driver = Object.assign(new EventEmitter(), {release, query(_config, _values, cb) {
      queries++;
      const value = {rows: [], fields: [], rowCount: 0};
      return cb ? cb(undefined, value) : Promise.resolve(value);
    }});
    return callback ? callback(undefined, driver, release) : Promise.resolve(driver);
  };
  let client;
  try {
    const {createPrismaClient} = await import('../../../../packages/database/src/client.ts');
    client = createPrismaClient('postgresql://offline:offline@localhost:5432/offline');
    const spans = [];
    const measure = async (name, work) => {
      const start = performance.now(), cpu = process.cpuUsage();
      const value = await work(), used = process.cpuUsage(cpu);
      spans.push({name, wallMs: performance.now()-start, cpuUserUs: used.user, cpuSystemUs: used.system});
      return value;
    };
    if (mode !== 'lazy-full') await measure('engine', () => client.$connect());
    const beforeQuery = {checkouts, queries};
    if (checkouts || queries) throw Error('UNEXPECTED_PREQUERY_DRIVER_WORK');
    await measure('first-account', async () => {
      const value = mode === 'engine-raw'
        ? await client.$queryRaw`SELECT id, status FROM users WHERE cognito_sub = ${'offline-only'} LIMIT 1`
        : await client.user.findFirst({where: {cognitoSub:'offline-only'}, ...(mode === 'engine-select' ? {select:{id:true,status:true}} : {})});
      if (mode === 'engine-raw' ? !Array.isArray(value) || value.length !== 0 : value !== null) throw Error('INVALID_FAKE_RESULT');
    });
    for (const name of ['next-full-model','warm-full-model']) await measure(name, async () => {
      if (await client.user.findFirst({where:{cognitoSub:'offline-only'}}) !== null) throw Error('INVALID_MODEL_RESULT');
    });
    await client.$disconnect(); client = null;
    if (queries !== 3 || checkouts !== 3 || releases !== 3) throw Error('DRIVER_OWNERSHIP_FAILED');
    console.log(JSON.stringify({gate:'PASS',mode,source:'LOCAL_FRESH_PROCESS_REAL_PRISMA_FAKE_PG_NO_NETWORK',node:process.version,architecture:process.arch,beforeQuery,counts:{checkouts,queries,releases},spans,awsAccepted:false,p95Accepted:false}));
  } finally { await client?.$disconnect(); Pool.prototype.connect=original; }
} else {
  const output = process.argv[2]; if(!output || process.argv.length!==3) throw Error('OUTPUT_REQUIRED');
  const rows=[];
  for (const mode of modes) for(let index=1;index<=3;index++) {
    const row=JSON.parse(execFileSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'--child',mode],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024}));rows.push({...row,index});
  }
  const sources=['packages/database/src/client.ts','apps/cloud-api/src/admin/user/service.ts','packages/database/prisma/schema.prisma',fileURLToPath(import.meta.url)];
  writeFileSync(output,JSON.stringify({gate:rows.every(r=>r.gate==='PASS')?'PASS':'FAIL',budget:{processes:12,network:false},rows,sources:sources.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})),boundaries:'Fake empty PG results only. Local timings exclude real database/network and do not prove account activation equivalence, target savings or P95. Raw may defer first model compilation to next real business query.',awsAccepted:false,p95Accepted:false},null,2)+'\n');
  console.log(JSON.stringify({gate:'PASS',processes:rows.length}));
}
