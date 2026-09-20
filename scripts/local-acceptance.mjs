/** Isolated local acceptance, including a full worker stop/start and D1 persistence check. */
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {ownerSql} from './owner-sql.mjs';
const tmp=await mkdtemp(join(tmpdir(),'memory-acceptance-'));
const port=Number(process.env.MEMORY_TEST_PORT??8792),base=`http://localhost:${port}`;
const password=randomBytes(24).toString('base64url');const cli=resolve('node_modules/wrangler/bin/wrangler.js');
const cfg=JSON.parse(await readFile('wrangler.local.jsonc','utf8'));cfg.main=resolve('src/worker.ts');cfg.assets.directory=resolve('public');cfg.vars.APP_ORIGIN=base;cfg.d1_databases[0].migrations_dir=resolve('migrations');
const config=join(tmp,'wrangler.json');await writeFile(config,JSON.stringify(cfg));await writeFile(join(tmp,'.dev.vars'),'SESSION_SECRET='+randomBytes(48).toString('base64url'),{mode:0o600});
await writeFile(join(tmp,'owner.sql'),ownerSql('fiction',password),{mode:0o600});
const env={...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true'};
async function run(args,extraEnv={}){await new Promise((yes,no)=>{const p=spawn(process.execPath,args,{stdio:'inherit',env:{...env,...extraEnv}});p.on('error',no);p.on('exit',c=>c===0?yes():no(new Error('Command failed: '+args[0])));});}
const common=['--config',config,'--persist-to',join(tmp,'state')];let worker;
async function start(){
 worker=spawn(process.execPath,[cli,'dev',...common,'--port',String(port),'--inspector-port',String(port+1000)],{env,stdio:['ignore','pipe','pipe']});let log='';worker.stdout.on('data',v=>{log+=v;});worker.stderr.on('data',v=>{log+=v;});
 for(let i=0;i<100;i++){if(worker.exitCode!==null)throw new Error('Local worker failed: '+log);try{const r=await fetch(base+'/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,150));}throw new Error('Local worker startup timeout: '+log);
}
async function stop(){if(worker&&worker.exitCode===null){await new Promise(r=>{worker.once('exit',r);worker.kill('SIGTERM');});}}
try{
 await run([cli,'d1','migrations','apply','memory-db','--local',...common]);
 await run([cli,'d1','execute','memory-db','--local',...common,'--file',join(tmp,'owner.sql')]);
 await start();await run(['scripts/verify-connection.mjs'],{MEMORY_BASE_URL:base,MEMORY_USERNAME:'fiction',MEMORY_PASSWORD:password});
 const acceptance=JSON.parse(await readFile('artifacts/acceptance.json','utf8'));await stop();await start();
 const response=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'fiction',password})});assert.equal(response.status,303);const cookie=response.headers.get('set-cookie').split(';')[0];
 const get=async id=>await(await fetch(base+'/api/memories/'+id,{headers:{cookie}})).json();
 const old=await get(acceptance.ids.old),current=await get(acceptance.ids.current);assert.equal(old.active,0);assert.equal(current.active,1);assert.equal(current.supersedes,old.id);assert.equal(current.versions.length,2);
 console.log('PASS full worker stop/start retains both originals and correction chain in D1');
 acceptance.checks.push('full worker stop/start persistence');await writeFile('artifacts/acceptance-local.json',JSON.stringify(acceptance,null,2));
}finally{await stop();await rm(tmp,{recursive:true,force:true});}
