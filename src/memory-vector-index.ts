import type { D1Database } from '@cloudflare/workers-types';
export type VectorEnv = { DB:D1Database; EMBEDDING_ENABLED?:string; EMBEDDING_URL?:string; EMBEDDING_MODEL?:string; EMBEDDING_API_KEY?:string; EMBEDDING_DIMENSIONS?:string; EMBEDDING_INDEX_VERSION?:string };
const encoder=new TextEncoder();
export function vectorConfig(env:VectorEnv){
 if(env.EMBEDDING_ENABLED!=='true')return null;
 const dimensions=Number(env.EMBEDDING_DIMENSIONS),version=env.EMBEDDING_INDEX_VERSION;
 if(!env.EMBEDDING_URL||!env.EMBEDDING_MODEL||!version||!Number.isInteger(dimensions)||dimensions<1||dimensions>8192)throw new Error('embedding_configuration_invalid');
 const url=new URL(env.EMBEDDING_URL);if(url.protocol!=='https:'||url.username||url.password)throw new Error('embedding_requires_https');
 return {url:url.href,model:env.EMBEDDING_MODEL,dimensions,version,key:JSON.stringify([url.href,env.EMBEDDING_MODEL,dimensions,version])};
}
const ready=new WeakMap<D1Database,Promise<unknown>>();
export async function ensureVectorIndex(db:D1Database){
 if(!ready.has(db))ready.set(db,db.batch([
  db.prepare('CREATE TABLE IF NOT EXISTS memory_vector_indexes (index_key TEXT PRIMARY KEY, model TEXT NOT NULL, dimensions INTEGER NOT NULL, version TEXT NOT NULL, created_at TEXT NOT NULL)'),
  db.prepare('CREATE TABLE IF NOT EXISTS memory_vectors (memory_id TEXT NOT NULL REFERENCES memories(id), index_key TEXT NOT NULL, content_hash TEXT NOT NULL, vector TEXT NOT NULL, indexed_at TEXT NOT NULL, PRIMARY KEY(memory_id,index_key))'),
  db.prepare('CREATE TABLE IF NOT EXISTS memory_vector_jobs (memory_id TEXT NOT NULL REFERENCES memories(id), index_key TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, error TEXT, PRIMARY KEY(memory_id,index_key))'),
  db.prepare("CREATE TRIGGER IF NOT EXISTS memory_vector_invalidate AFTER UPDATE OF active ON memories WHEN NEW.active=0 BEGIN DELETE FROM memory_vectors WHERE memory_id=NEW.id; DELETE FROM memory_vector_jobs WHERE memory_id=NEW.id; END"),
  db.prepare('CREATE TRIGGER IF NOT EXISTS memory_vector_review AFTER INSERT ON memory_reviews BEGIN DELETE FROM memory_vectors WHERE memory_id=NEW.memory_id; DELETE FROM memory_vector_jobs WHERE memory_id=NEW.memory_id; END'),
  db.prepare('CREATE TRIGGER IF NOT EXISTS memory_vector_details AFTER UPDATE ON memory_details BEGIN DELETE FROM memory_vectors WHERE memory_id=NEW.memory_id; END'),
 ]).catch(e=>{ready.delete(db);throw e;}));await ready.get(db);
}
export async function embed(env:VectorEnv,text:string,timeout=1500){
 const config=vectorConfig(env);if(!config)throw new Error('embedding_disabled');
 const response=await fetch(config.url,{method:'POST',headers:{'content-type':'application/json',...(env.EMBEDDING_API_KEY?{authorization:'Bearer '+env.EMBEDDING_API_KEY}:{})},body:JSON.stringify({model:config.model,dimensions:config.dimensions,input:text}),signal:AbortSignal.timeout(timeout),redirect:'error'});
 if(!response.ok)throw new Error(response.status===429?'embedding_rate_limited':'embedding_unavailable');
 const data=await response.json() as {data?:{embedding:number[]}[]};const vector=data.data?.[0]?.embedding;
 if(!Array.isArray(vector)||vector.length!==config.dimensions||!vector.every(v=>typeof v==='number'&&Number.isFinite(v))||!vector.some(v=>v!==0))throw new Error('embedding_dimensions_invalid');
 return vector;
}
function indexText(row:{body:string;kind:string;occurred_at:string|null;details:string|null}){
 const details=row.details?JSON.parse(row.details):{};
 const text=[row.kind,row.occurred_at??'date unknown',details.title,details.summary,row.body].filter(Boolean).join('\n');
 // Byte bound is also a safe token upper bound; originals are never truncated in storage.
 let value='',bytes=0;for(const char of text){const n=encoder.encode(char).length;if(bytes+n>16000)break;value+=char;bytes+=n;}return value;
}
export async function processVectorJobs(env:VectorEnv,limit=8){
 const config=vectorConfig(env);if(!config)return {enabled:false,indexed:0};
 await ensureVectorIndex(env.DB);
 await env.DB.prepare('INSERT OR IGNORE INTO memory_vector_indexes VALUES (?,?,?,?,?)').bind(config.key,config.model,config.dimensions,config.version,new Date().toISOString()).run();
 // Reconciliation covers every writer (web, iOS and MCP) and every active record, not only recent rows.
 await env.DB.prepare(`INSERT OR IGNORE INTO memory_vector_jobs(memory_id,index_key) SELECT m.id,? FROM memories m WHERE m.active=1 AND m.id NOT IN (SELECT memory_id FROM memory_reviews) AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id=m.id AND v.index_key=?)`).bind(config.key,config.key).run();
 const jobs=(await env.DB.prepare(`SELECT j.memory_id FROM memory_vector_jobs j JOIN memories m ON m.id=j.memory_id WHERE j.index_key=? AND j.retry_at<=? AND j.lease_until<=? AND m.active=1 AND m.id NOT IN (SELECT memory_id FROM memory_reviews) ORDER BY j.retry_at,j.memory_id LIMIT ?`).bind(config.key,Date.now(),Date.now(),Math.min(8,Math.max(1,limit))).all<{memory_id:string}>()).results;
 let indexed=0;
 for(const job of jobs){
  const owner=crypto.randomUUID();await env.DB.prepare('UPDATE memory_vector_jobs SET lease_owner=?,lease_until=? WHERE memory_id=? AND index_key=? AND lease_until<=?').bind(owner,Date.now()+30000,job.memory_id,config.key,Date.now()).run();
  const leased=await env.DB.prepare('SELECT lease_owner FROM memory_vector_jobs WHERE memory_id=? AND index_key=?').bind(job.memory_id,config.key).first<{lease_owner:string}>();if(leased?.lease_owner!==owner)continue;
  try{
   const row=await env.DB.prepare('SELECT m.*,d.details FROM memories m LEFT JOIN memory_details d ON d.memory_id=m.id WHERE m.id=? AND m.active=1 AND m.id NOT IN (SELECT memory_id FROM memory_reviews)').bind(job.memory_id).first<{body:string;kind:string;occurred_at:string|null;details:string|null}>();if(!row)continue;
   const text=indexText(row),vector=await embed(env,text,2500);
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
   await env.DB.prepare(`INSERT OR REPLACE INTO memory_vectors SELECT id,?,?,?,? FROM memories WHERE id=? AND active=1 AND id NOT IN (SELECT memory_id FROM memory_reviews) AND body=? AND kind=? AND occurred_at IS ? AND (SELECT details FROM memory_details WHERE memory_id=memories.id) IS ?`).bind(config.key,hash,JSON.stringify(vector),new Date().toISOString(),job.memory_id,row.body,row.kind,row.occurred_at,row.details).run();
   await env.DB.prepare('DELETE FROM memory_vector_jobs WHERE memory_id=? AND index_key=? AND lease_owner=?').bind(job.memory_id,config.key,owner).run();indexed++;
  }catch(error){
   const code=error instanceof Error&&/^embedding_[a-z_]+$/.test(error.message)?error.message:'embedding_failed';
   await env.DB.prepare('UPDATE memory_vector_jobs SET attempts=attempts+1,retry_at=?,lease_until=0,error=? WHERE memory_id=? AND index_key=? AND lease_owner=?').bind(Date.now()+300000,code,job.memory_id,config.key,owner).run();
  }
 }
 return {enabled:true,indexed};
}
