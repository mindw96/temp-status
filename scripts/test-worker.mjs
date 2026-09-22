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
for(const kind of ['node','slurm','cloud-gpu']){
  const denied=await worker.fetch(new Request('https://local.test/api/report/'+kind,{method:'POST',body:'{}'}),publicEnv,{});
  assert.equal(denied.status,401);
}
// Cloud reports share the authenticated node storage path, not the Slurm key.
assert.equal((await call('/api/report/cloud-gpu')).status,405);
assert.equal((await call('/api/report/cloud-gpu','POST',{},reportHeaders)).status,400);
const cloud={
  server:{name:' baro ',hostname:'ubuntu',type:'cloud',reported_at:'1970-01-01T00:00:00Z'},
  system:{cpu_percent:0,cpu_count:64,ram_used_gb:16,ram_total_gb:128,ram_percent:12.5,used_disk_gb:100,total_disk_gb:1000,disk_percent:10},
  summary:{ignored:'must not be stored'},server_name:'unit-node',
  gpus:[
    {index:0,uuid:'GPU-cloud-0',name:'Cloud GPU',utilization_gpu:67.5,memory_used:12288,memory_total:81920,memory_usage_percent:15,temperature_gpu:55,power_draw:230,power_limit:400,
      processes:[{pid:501,username:'cloud-user',gpu_memory_usage:12288,command:'private-command --private-argument',slurm_job_id:'123_4',slurm_job_name:'unrelated queue name',slurm_job_ids:['127']}]},
    {index:1,uuid:'GPU-cloud-1',name:'Cloud GPU',utilization_gpu:0,memory_used:0,memory_total:81920,processes:[]}
  ]
};
for (const invalid of [
  {...cloud,server:{name:'   '}},
  {...cloud,server:{name:'x'.repeat(129)}},
  {...cloud,server:{hostname:'baro'}},
  {...cloud,system:[]},
  {...cloud,gpus:{}},
  {...cloud,gpus:[{index:-1}]},
  {...cloud,gpus:[{index:0},{index:0}]},
]) assert.equal((await call('/api/report/cloud-gpu','POST',invalid,reportHeaders)).status,400);
const previousSlurm=structuredClone(snapshot.slurm);
const firstCloudReport=await call('/api/report/cloud-gpu','POST',cloud,reportHeaders);
assert.equal(firstCloudReport.status,200);
const cloudAccepted=await firstCloudReport.json();
assert.equal(cloudAccepted.ok,true);
assert.equal(Object.hasOwn(cloudAccepted,'accounting_status'),false);
snapshot=await(await call('/api/snapshot','GET',null,{'oai-authenticated-user-id':'test'})).json();
assert.equal(snapshot.nodes.length,2);
assert.deepEqual(snapshot.slurm,previousSlurm);
const cloudRecord=snapshot.nodes.find(n=>n.data.server_name==='baro');
assert.equal(cloudRecord.receivedAt,cloudAccepted.received_at);
const cloudNode=cloudRecord.data;
assert.equal(cloudNode.source_type,'cloud');
assert.equal(cloudNode.cpu_count,64);
assert.equal(cloudNode.cpu_percent,0);
assert.equal(cloudNode.ram_used_gb,16);
assert.equal(cloudNode.total_disk_gb,1000);
assert.equal(cloudNode.gpus[0].id,0);
assert.equal(cloudNode.gpus[0].gpu_name,'Cloud GPU');
assert.equal(cloudNode.gpus[0].gpu_utilization,67.5);
assert.equal(cloudNode.gpus[0].vram_total_used_mb,12288);
assert.equal(cloudNode.gpus[0].vram_total_mb,81920);
assert.equal(cloudNode.gpus[1].gpu_utilization,0);
assert.equal(cloudNode.gpus[1].vram_total_used_mb,0);
assert.deepEqual(cloudNode.gpus[0].processes,[{pid:501,username:'cloud-user',used_mb:12288}]);
assert.equal(Object.hasOwn(cloudNode,'server'),false);
assert.equal(Object.hasOwn(cloudNode,'summary'),false);
assert.equal(Object.hasOwn(cloudNode.gpus[0],'temperature_gpu'),false);
assert.equal(JSON.stringify(cloudNode).includes('private-command'),false);
const labNode=snapshot.nodes.find(n=>n.data.server_name==='unit-node');
assert.equal(labNode.data.gpus[0].processes[0].slurm_job_id,'123_4');
assert.equal(Object.hasOwn(labNode.data,'source_type'),false);
cloud.system.cpu_count=1000000000;
cloud.gpus[0].utilization_gpu=null;
cloud.gpus[0].memory_used=null;
assert.equal((await call('/api/report/cloud-gpu','POST',cloud,reportHeaders)).status,200);
snapshot=await(await call('/api/snapshot','GET',null,{'oai-authenticated-user-id':'test'})).json();
assert.equal(snapshot.nodes.length,2);
assert.deepEqual(snapshot.slurm,previousSlurm);
const updatedCloud=snapshot.nodes.find(n=>n.data.server_name==='baro').data;
assert.equal(updatedCloud.cpu_count,null);
assert.equal(updatedCloud.gpus[0].gpu_utilization,null);
assert.equal(updatedCloud.gpus[0].vram_total_used_mb,null);
assert.equal((await worker.fetch(new Request('https://local.test/api/snapshot',{headers:{'oai-authenticated-user-id':'forged'}}),{...env,SNAPSHOT_AUTH_MODE:'unknown'},{})).status,503);
const failure=await worker.fetch(new Request('https://local.test/api/snapshot',{headers:{'oai-authenticated-user-id':'test'}}),{DB:{prepare(){throw new Error('simulated unavailable')}}},{});assert.equal(failure.status,503);
if(process.argv[2]){const real=JSON.parse(readFileSync(process.argv[2],'utf8'));assert.equal((await call('/api/report/node','POST',real.node,reportHeaders)).status,200);assert.equal((await call('/api/report/slurm','POST',real.slurm,reportHeaders)).status,200);snapshot=await(await call('/api/snapshot','GET',null,{'oai-authenticated-user-id':'test'})).json();assert.equal(snapshot.slurm.data.squeue.length,real.slurm.squeue.length);assert.equal(snapshot.nodes.find(n=>n.data.server_name===real.node.server_name).data.gpus.length,real.node.gpus.length);console.log('Real agent fixture: both reports accepted and retrieved.');}
assert.equal((await call('/')).status,200);assert.equal((await call('/api/unknown')).status,404);
console.log('PASS: authentication, input validation, bounded GPU job names, empty jobs, zero vs missing metrics, storage update, cloud GPU normalization and coexistence, minute history, failure handling, assets.');
