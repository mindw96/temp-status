import {createServer} from 'node:http';
import worker from '../dist/server/index.js';
import {localDB} from './local-db.mjs';
const DB=localDB(),env={DB,STATUS_REPORT_TOKEN:'preview-local-only'};
const server=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','local-preview');const request=new Request('http://127.0.0.1:4173'+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});const response=await worker.fetch(request,env,{waitUntil:p=>p.catch(console.error)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(error){res.writeHead(500);res.end('Preview error');console.error(error.message);}});
server.listen(4173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4173/'));
