import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../dist/server/index.js';
import {localDB} from './local-db.mjs';
const DB=localDB(),env={DB,STATUS_REPORT_TOKEN:'local-test-only'};
const call=(path,method='GET',body,headers={})=>worker.fetch(new Request('https://local.test'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined}),env,{});
const reportHeaders={'X-Status-Token':env.STATUS_REPORT_TOKEN};
const directCloudflare=await worker.fetch(new Request('https://local.test/api/snapshot',{headers:{'oai-authenticated-user-id':'forged-client-header'}}),{...env,SNAPSHOT_AUTH_MODE:'unconfigured'},{});
assert.equal(directCloudflare.status,503);assert.equal((await directCloudflare.json()).error,'access_not_configured');
assert.equal((await call('/api/snapshot')).status,401);
assert.equal((await call('/api/report/node','POST',{server_name:'test',gpus:[]})).status,401);
assert.equal((await call('/api/report/node','POST',{},reportHeaders)).status,400);
assert.equal((await call('/api/report/slurm','POST',{squeue:[]},reportHeaders)).status,400);
assert.equal((await call('/api/report/slurm')).status,405);
const node={server_name:'unit-node',cpu_percent:12,gpus:[{id:0,gpu_name:'A6000',gpu_utilization:0,vram_total_mb:49152,vram_total_used_mb:0,processes:[]},{id:1,collection_error:'NVML read failed',processes:[]}]};
// Names must survive ingestion and storage even when no matching queue job exists.
node.gpus[0].processes=[
  {pid:101,slurm_job_id:'123_4',slurm_job_ids:['123_4','127'],slurm_job_name:'train <alpha> & evaluation'},
  {pid:102,slurm_job_id:'128',slurm_job_name:'x'.repeat(600)},
  {pid:103,slurm_job_id:'129',slurm_job_name:{unexpected:'object'}},
  {pid:104,slurm_job_id:'130'},
];
assert.equal((await call('/api/report/node','POST',node,reportHeaders)).status,200);
assert.equal((await call('/api/report/slurm','POST',{sinfo:[],squeue:[],accounting:{jobs:[]}},reportHeaders)).status,200);
let snapshot=await (await call('/api/snapshot','GET',null,{'oai-authenticated-user-id':'test'})).json();
assert.equal(snapshot.nodes.length,1);assert.equal(snapshot.nodes[0].data.gpus[0].gpu_utilization,0);assert.equal(snapshot.nodes[0].data.gpus[1].gpu_utilization,null);assert.equal(snapshot.history[0].utilization,0);assert.equal(snapshot.history[0].gpu_count,1);
const storedProcesses=snapshot.nodes[0].data.gpus[0].processes;
assert.equal(storedProcesses[0].slurm_job_name,'train <alpha> & evaluation');
assert.deepEqual(storedProcesses[0].slurm_job_ids,['123_4','127']);
assert.equal(storedProcesses[1].slurm_job_name,'x'.repeat(500));
assert.equal(storedProcesses[2].slurm_job_name,'');
assert.equal(storedProcesses[3].slurm_job_name,'');
node.gpus[0].gpu_utilization=50;await call('/api/report/node','POST',node,reportHeaders);snapshot=await(await call('/api/snapshot','GET',null,{'oai-authenticated-user-id':'test'})).json();assert.equal(snapshot.nodes.length,1);assert.equal(snapshot.history.length,1);assert.equal(snapshot.history[0].utilization,50);
const publicEnv={...env,SNAPSHOT_AUTH_MODE:'public'};
const publicSnapshot=await worker.fetch(new Request('https://local.test/api/snapshot'),publicEnv,{});
assert.equal(publicSnapshot.status,200);assert.equal((await publicSnapshot.json()).nodes[0].data.server_name,'unit-node');
for(const kind of ['node','slurm']){
  const denied=await worker.fetch(new Request('https://local.test/api/report/'+kind,{method:'POST',body:'{}'}),publicEnv,{});
  assert.equal(denied.status,401);
}
assert.equal((await worker.fetch(new Request('https://local.test/api/snapshot',{headers:{'oai-authenticated-user-id':'forged'}}),{...env,SNAPSHOT_AUTH_MODE:'unknown'},{})).status,503);
const failure=await worker.fetch(new Request('https://local.test/api/snapshot',{headers:{'oai-authenticated-user-id':'test'}}),{DB:{prepare(){throw new Error('simulated unavailable')}}},{});assert.equal(failure.status,503);
if(process.argv[2]){const real=JSON.parse(readFileSync(process.argv[2],'utf8'));assert.equal((await call('/api/report/node','POST',real.node,reportHeaders)).status,200);assert.equal((await call('/api/report/slurm','POST',real.slurm,reportHeaders)).status,200);snapshot=await(await call('/api/snapshot','GET',null,{'oai-authenticated-user-id':'test'})).json();assert.equal(snapshot.slurm.data.squeue.length,real.slurm.squeue.length);assert.equal(snapshot.nodes.find(n=>n.data.server_name===real.node.server_name).data.gpus.length,real.node.gpus.length);console.log('Real agent fixture: both reports accepted and retrieved.');}
assert.equal((await call('/')).status,200);assert.equal((await call('/api/unknown')).status,404);
console.log('PASS: authentication, input validation, bounded GPU job names, empty jobs, zero vs missing metrics, storage update, minute history, failure handling, assets.');
