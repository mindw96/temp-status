import {readFile,mkdir,writeFile,cp} from 'node:fs/promises';
const assets={};for(const [name,type] of [['index.html','text/html; charset=utf-8'],['styles.css','text/css; charset=utf-8'],['app.js','application/javascript; charset=utf-8'],['live.js','application/javascript; charset=utf-8']])assets['/'+name]={body:await readFile('public/'+name,'utf8'),type};
await mkdir('dist/server',{recursive:true});
await writeFile('dist/server/index.js',`const ASSETS=${JSON.stringify(assets)};\n`+await readFile('src/worker.js','utf8'));
await writeFile('dist/server/wrangler.json',JSON.stringify({name:'lattice-lab-gpu',main:'index.js',compatibility_date:'2026-09-01',d1_databases:[{binding:'DB',database_name:'lattice-lab-gpu',database_id:'00000000-0000-4000-8000-000000000000',migrations_dir:'../../drizzle'}]},null,2));
// Keep the same local preview surface through publication.
for(const name of ['index.html','styles.css','app.js','live.js'])await cp('public/'+name,'dist/'+name);
console.log('Built Worker and dashboard assets.');
