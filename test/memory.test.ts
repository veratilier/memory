import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {saveMemory,searchMemory,getMemory,listMemories,cosine,terms} from '../src/memory.ts';
import {hashPassword,verifyPassword,createCsrfToken,verifyCsrfToken,assertSameOrigin} from '../src/security.ts';
import {login,currentUser,serviceAuth,COOKIE} from '../src/auth.ts';
import type {Env} from '../src/env.ts';
// Uses real SQLite transactions and production migration/queries, not a query mock.
function adapter(sql:DatabaseSync):D1Database {
 return {prepare(query:string){let values:any[]=[];return {bind(...args:any[]){values=args;return this;},async first(){return sql.prepare(query).get(...values)??null;},async all(){return {results:sql.prepare(query).all(...values)};},async run(){const r=sql.prepare(query).run(...values);return {meta:{changes:Number(r.changes)}};}};},async batch(statements:any[]){sql.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
}
let sql:DatabaseSync,env:Env;
beforeEach(()=>{sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');sql.exec(readFileSync(new URL('../migrations/0001_memory.sql',import.meta.url),'utf8'));env={DB:adapter(sql)} as Env;});
afterEach(()=>sql.close());
const fixture={body:'蓝色纸船放在虚构的北窗木盒里。',source:'虚构样本 · fiction-only',kind:'episode' as const,occurred_at:'2026-01-03T10:00:00+08:00'};
test('save → search → exact original → correct → new version; old original stays readable',async()=>{
 const a=await saveMemory(env.DB,{...fixture,source_id:'fiction-001'});
 assert.equal(a.occurred_at,'2026-01-03T02:00:00.000Z');
 const r=await searchMemory(env,{query:'蓝色纸船在哪里'});assert.equal(r.status,'matched');assert.equal(r.hits[0].id,a.id);assert.ok(r.hits[0].matched_terms.includes('纸船'));assert.equal(r.hits[0].source,fixture.source);
 assert.equal((await getMemory(env.DB,a.id)).body,fixture.body);
 const b=await saveMemory(env.DB,{...fixture,id:a.id,body:'蓝色纸船其实放在虚构的银色抽屉里。',correction_reason:'虚构纠正说明'},true);
 assert.equal(b.supersedes,a.id);assert.equal(b.version,2);assert.equal(b.root_id,a.root_id);
 const q=await searchMemory(env,{query:'蓝色纸船'});assert.deepEqual(q.hits.map(x=>x.id),[b.id]);
 const old=await getMemory(env.DB,a.id);assert.equal(old.active,0);assert.equal(old.body,fixture.body);assert.equal(old.versions.length,2);
 assert.equal((await searchMemory(env,{query:'蓝色纸船',include_superseded:true})).hits.length,2);
 await assert.rejects(saveMemory(env.DB,{...fixture,id:a.id,body:'另一条纠正',correction_reason:'迟到的修改'},true),/stale_version/);
});
test('deduplication without ID, ID conflict, retry correction and concurrent correction',async()=>{
 const a=await saveMemory(env.DB,fixture);assert.equal((await saveMemory(env.DB,fixture)).id,a.id);
 const same=await saveMemory(env.DB,{...fixture,source_id:'explicit'});assert.equal((await saveMemory(env.DB,{...fixture,source_id:'explicit'})).id,same.id);
 await assert.rejects(saveMemory(env.DB,{...fixture,body:'different',source_id:'explicit'}),/source_id_conflict/);
 const correction={...fixture,id:a.id,body:'蓝色纸船位于虚构抽屉',source_id:'correct-1',correction_reason:'虚构说明'};
 const b=await saveMemory(env.DB,correction,true);assert.equal((await saveMemory(env.DB,correction,true)).id,b.id);
 // Database itself rejects a fork, even if an application cached old state.
 assert.throws(()=>sql.prepare('INSERT INTO memories SELECT ?,?,body,kind,source,source_url,occurred_at,recorded_at,1,?,root_id,2,? FROM memories WHERE id=?').run('fork','fork-source',a.id,'conflicting edit',a.id),/stale_version/);
});
test('no match remains no match with preferences; dreams/reflections require explicit inclusion',async()=>{
 await saveMemory(env.DB,{...fixture,kind:'preference',body:'偏好简短回答'});
 for(const kind of ['dream','reflection'])await saveMemory(env.DB,{...fixture,kind});
 assert.equal((await searchMemory(env,{query:'蓝色纸船'})).status,'no_match');
 const r=await searchMemory(env,{query:'蓝色纸船',include_nonfacts:true});assert.equal(r.hits.length,2);assert.ok(r.hits.every(x=>x.epistemic_status==='subjective_not_fact'));
 assert.equal((await searchMemory(env,{query:'火山喷发'})).status,'no_match');
});
test('source retrieval, case folding, pagination and exact text preservation',async()=>{
 const a=await saveMemory(env.DB,{...fixture,body:'  FICTION <script>alert(1)</script>\n  exact original  ',source:'故纸档案'});
 assert.ok(terms('FICTION').includes('fiction'));
 assert.equal((await searchMemory(env,{query:'故纸档案'})).hits[0].id,a.id);
 assert.equal((await getMemory(env.DB,a.id)).body,'  FICTION <script>alert(1)</script>\n  exact original  ');
 assert.equal((await listMemories(env.DB,{offset:0,limit:1,include_superseded:false})).items.length,1);
 assert.equal((await listMemories(env.DB,{offset:1,limit:1,include_superseded:false})).items.length,0);
});
test('invalid times, unsafe links, unknown fields and kinds rejected',async()=>{
 for(const bad of [{occurred_at:'2026-01-01T00:00:00'},{source_url:'javascript:alert(1)'},{kind:'fact'},{body:' '},{source:' '},{owner:'someone-else'}])await assert.rejects(saveMemory(env.DB,{...fixture,...bad}));
 await assert.rejects(searchMemory(env,{query:''}));
});
test('optional vector cache and honest fallback',async()=>{
 await saveMemory(env.DB,fixture);env.EMBEDDING_URL='https://embedding.example/embeddings';env.EMBEDDING_MODEL='test-vectors';
 const oldFetch=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return Response.json({data:[{embedding:[1,0]}]});};
  assert.equal((await searchMemory(env,{query:'折纸作品'})).mode,'hybrid');assert.equal(calls,2);
  assert.equal((await searchMemory(env,{query:'折纸作品'})).hits[0].reason,'semantic_similarity');assert.equal(calls,3);
  globalThis.fetch=async()=>{throw new Error('offline');};
  const r=await searchMemory(env,{query:'蓝色纸船'});assert.equal(r.mode,'lexical');assert.equal(r.hits.length,1);assert.ok(r.warnings.length);
 }finally{globalThis.fetch=oldFetch;}
 assert.equal(cosine([1,0],[1,0]),1);assert.throws(()=>cosine([0,0],[0,0]));
});
test('login sessions revoked by password version; rate limit and CSRF are enforced',async()=>{
 sql.prepare('INSERT INTO users VALUES (?,?,?,1)').run('owner','fiction',await hashPassword('fiction-test-password'));
 const password=await hashPassword('fiction-test-password');assert.equal(await verifyPassword('wrong',password),false);
 const r=await login(env,'fiction','fiction-test-password','fiction-ip');assert.ok(r.token);
 const request=new Request('https://memory.example',{headers:{cookie:COOKIE+'='+r.token}});assert.equal((await currentUser(request,env))?.id,'owner');
 sql.exec('UPDATE users SET auth_version=2');assert.equal(await currentUser(request,env),null);
 for(let i=0;i<8;i++)await login(env,'fiction','wrong','fiction-bad-ip');assert.equal((await login(env,'fiction','fiction-test-password','fiction-bad-ip')).status,429);
 const csrf=await createCsrfToken('session','request-one','secret');assert.equal(await verifyCsrfToken(csrf,'session','request-two','secret'),false);
 assert.equal(assertSameOrigin(new Request('https://memory.example',{headers:{origin:'https://evil.example'}}),'https://memory.example'),false);
 assert.equal(await serviceAuth(new Request('https://memory.example',{headers:{authorization:'Bearer mem_invalid'}}),env),null);
});
