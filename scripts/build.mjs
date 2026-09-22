import {readFile,mkdir,writeFile,cp} from 'node:fs/promises';
const assets={};for(const [name,type] of [['index.html','text/html; charset=utf-8'],['styles.css','text/css; charset=utf-8'],['app.js','application/javascript; charset=utf-8'],['live.js','application/javascript; charset=utf-8']])assets['/'+name]={body:await readFile('public/'+name,'utf8'),type};
await mkdir('dist/server',{recursive:true});
await writeFile('dist/server/index.js',`const ASSETS=${JSON.stringify(assets)};\n`+await readFile('src/worker.js','utf8'));
// Direct Cloudflare deployment uses the checked-in root wrangler.jsonc.
// Keep the same local preview surface through publication.
for(const name of ['index.html','styles.css','app.js','live.js'])await cp('public/'+name,'dist/'+name);
console.log('Built Worker and dashboard assets.');
