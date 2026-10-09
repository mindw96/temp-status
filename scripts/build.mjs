import {readFile,mkdir,writeFile,cp} from 'node:fs/promises';
const assets={};for(const [name,type] of [['index.html','text/html; charset=utf-8'],['design-system.css','text/css; charset=utf-8'],['styles.css','text/css; charset=utf-8'],['theme.js','application/javascript; charset=utf-8'],['app.js','application/javascript; charset=utf-8'],['gpu-jobs.js','application/javascript; charset=utf-8'],['live.js','application/javascript; charset=utf-8'],['a100.html','text/html; charset=utf-8'],['a100.css','text/css; charset=utf-8'],['a100.js','application/javascript; charset=utf-8']])assets['/'+name]={body:await readFile('public/'+name,'utf8'),type};
await mkdir('dist/server',{recursive:true});
await writeFile('dist/server/index.js',`const ASSETS=${JSON.stringify(assets)};\n`+await readFile('src/worker.js','utf8'));
await cp('src/a100.js','dist/server/a100.js');
// Direct Cloudflare deployment uses the checked-in root wrangler.jsonc.
// Keep the same local preview surface through publication.
for(const name of ['index.html','design-system.css','styles.css','theme.js','app.js','gpu-jobs.js','live.js','a100.html','a100.css','a100.js'])await cp('public/'+name,'dist/'+name);
console.log('Built Worker and dashboard assets.');
