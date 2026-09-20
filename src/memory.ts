import * as z from 'zod/v4';
import type { Env } from './env';
import { sha256 } from './security';
export const kinds = ['episode','preference','agreement','reflection','dream'] as const;
export const saveSchema = z.object({
 body:z.string().min(1).max(12000).refine(v=>Boolean(v.trim()),'原文不能为空'),
 source:z.string().min(1).max(500).refine(v=>Boolean(v.trim()),'来源不能为空'),
 source_id:z.string().min(1).max(300).optional(),
 source_url:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol)).nullable().optional(),
 kind:z.enum(kinds),
 occurred_at:z.iso.datetime({offset:true}).nullable().optional(),
}).strict();
export const correctSchema = saveSchema.extend({id:z.uuid(),correction_reason:z.string().min(1).max(500)}).strict();
export const searchSchema = z.object({query:z.string().trim().min(1).max(1000),limit:z.number().int().min(1).max(20).default(6),include_superseded:z.boolean().default(false),include_nonfacts:z.boolean().default(false),kind:z.enum(kinds).optional()}).strict();
export type MemoryRow = {id:string;source_id:string;body:string;source:string;source_url:string|null;kind:typeof kinds[number];occurred_at:string|null;recorded_at:string;active:number;supersedes:string|null;root_id:string;version:number;correction_reason:string|null};
export class MemoryError extends Error { constructor(public code:string,public status:400|404|409=400){super(code);} }
export function terms(text:string):string[]{
 const words=new Set(text.toLowerCase().match(/[a-z0-9]+/g)??[]);
 for(const part of text.match(/[\u3400-\u9fff]+/g)??[]){if(part.length===1)words.add(part);else for(let i=0;i<part.length-1;i++)words.add(part.slice(i,i+2));}
 return [...words];
}
export function cosine(a:number[],b:number[]):number{
 if(!a.length||a.length!==b.length||![...a,...b].every(Number.isFinite))throw new Error('invalid_vector');
 const norm=Math.sqrt(a.reduce((s,v)=>s+v*v,0)*b.reduce((s,v)=>s+v*v,0));
 if(!norm)throw new Error('zero_vector');
 return a.reduce((s,v,i)=>s+v*b[i],0)/norm;
}
export function evidence(row:MemoryRow){return {...row,epistemic_status:['dream','reflection'].includes(row.kind)?'subjective_not_fact':'recorded_claim_not_independently_verified',provenance:'user_supplied',content_is_untrusted:true};}
export async function getMemory(db:D1Database,id:string){
 const row=await db.prepare('SELECT * FROM memories WHERE id=?').bind(id).first<MemoryRow>();
 if(!row)throw new MemoryError('memory_not_found',404);
 const versions=(await db.prepare('SELECT id,version,active,supersedes,recorded_at,correction_reason FROM memories WHERE root_id=? ORDER BY version').bind(row.root_id).all()).results;
 return {...evidence(row),versions};
}
export async function saveMemory(db:D1Database,input:unknown,correction=false){
 const parsed=correction?correctSchema.parse(input):saveSchema.parse(input);
 const c=correction?correctSchema.parse(input):null;
 const occurred=parsed.occurred_at?new Date(parsed.occurred_at).toISOString():null;
 const identity={body:parsed.body,source:parsed.source,source_url:parsed.source_url??null,kind:parsed.kind,occurred_at:occurred,supersedes:c?.id??null,correction_reason:c?.correction_reason??null};
 const sourceId=parsed.source_id??'sha256:'+await sha256(JSON.stringify(identity));
 async function existing(){
  const row=await db.prepare('SELECT * FROM memories WHERE source_id=?').bind(sourceId).first<MemoryRow>();
  if(row){if(Object.entries(identity).some(([key,value])=>row[key as keyof MemoryRow]!==value))throw new MemoryError('source_id_conflict',409);return {...evidence(row),deduplicated:true};}
  return null;
 }
 const prior=await existing();if(prior)return prior;
 const old=c?await db.prepare('SELECT * FROM memories WHERE id=? AND active=1').bind(c.id).first<MemoryRow>():null;
 if(c&&!old)throw new MemoryError('stale_version',409);
 const id=crypto.randomUUID();
 const row:MemoryRow={id,source_id:sourceId,...identity,recorded_at:new Date().toISOString(),active:1,root_id:old?.root_id??id,version:(old?.version??0)+1};
 // One D1 batch transaction + DB triggers prevents races and split version chains.
 const stmts=[db.prepare('INSERT INTO memories (id,source_id,body,kind,source,source_url,occurred_at,recorded_at,active,supersedes,root_id,version,correction_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(row.id,row.source_id,row.body,row.kind,row.source,row.source_url,row.occurred_at,row.recorded_at,1,row.supersedes,row.root_id,row.version,row.correction_reason)];
 // json_each keeps the index update in one statement regardless of original length.
 stmts.push(db.prepare('INSERT INTO memory_terms (memory_id,term) SELECT ?,value FROM json_each(?)').bind(id,JSON.stringify(terms(row.body+' '+row.source))));
 try{await db.batch(stmts);}catch(err){const retry=await existing();if(retry)return retry;if(String(err).includes('stale_version')||String(err).includes('memories.supersedes'))throw new MemoryError('stale_version',409);throw err;}
 return {...evidence(row),deduplicated:false};
}
export async function listMemories(db:D1Database,options:{offset:number;limit:number;include_superseded:boolean;kind?:string}){
 const where=['1=1'];const args:(string|number)[]=[];
 if(!options.include_superseded)where.push('active=1');
 if(options.kind){where.push('kind=?');args.push(options.kind);}
 const clause=where.join(' AND ');
 const rows=await db.prepare(`SELECT * FROM memories WHERE ${clause} ORDER BY recorded_at DESC,id LIMIT ? OFFSET ?`).bind(...args,options.limit,options.offset).all<MemoryRow>();
 const count=await db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${clause}`).bind(...args).first<{count:number}>();
 return {items:rows.results.map(evidence),total:count?.count??0,offset:options.offset};
}
async function embedding(env:Env,text:string,timeout=6000):Promise<number[]>{
 const url=new URL(env.EMBEDDING_URL!);if(url.protocol!=='https:')throw new Error('embedding_requires_https');
 const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...(env.EMBEDDING_API_KEY?{authorization:'Bearer '+env.EMBEDDING_API_KEY}:{})},body:JSON.stringify({model:env.EMBEDDING_MODEL,input:text}),signal:AbortSignal.timeout(timeout),redirect:'error'});
 if(!response.ok)throw new Error('embedding_unavailable');
 const data=await response.json<{data?:{embedding:number[]}[]}>();const v=data.data?.[0]?.embedding;
 if(!Array.isArray(v)||v.length>8192||!v.length||!v.every(x=>typeof x==='number'&&Number.isFinite(x)))throw new Error('invalid_embedding');
 return v;
}
export async function searchMemory(env:Env,input:unknown){
 const args=searchSchema.parse(input);const qt=terms(args.query).slice(0,80);const warnings:string[]=[];
 if(terms(args.query).length>80)warnings.push('检索词超过80个，仅使用前80个。');
 const clauses=['1=1'];const values:string[]=[];
 if(!args.include_superseded)clauses.push('m.active=1');
 if(!args.include_nonfacts)clauses.push("m.kind NOT IN ('dream','reflection')");
 if(args.kind){clauses.push('m.kind=?');values.push(args.kind);}
 const where=clauses.join(' AND ');
 const candidates=qt.length?(await env.DB.prepare(`SELECT m.*,COUNT(*) AS overlaps FROM memories m JOIN memory_terms t ON m.id=t.memory_id WHERE ${where} AND t.term IN (${qt.map(()=>'?').join(',')}) GROUP BY m.id HAVING COUNT(*)>=? ORDER BY overlaps DESC,m.recorded_at DESC LIMIT 100`).bind(...values,...qt,Math.max(1,Math.ceil(qt.length*.18))).all<MemoryRow>()).results:[];
 const rows=new Map(candidates.map(r=>[r.id,r]));const vectors=new Map<string,number>();let mode='lexical';
 if(env.EMBEDDING_MODEL&&env.EMBEDDING_URL){
  try{
   const modelKey=env.EMBEDDING_URL+'#'+env.EMBEDDING_MODEL;const deadline=Date.now()+10000;
   const recent=await env.DB.prepare(`SELECT m.*,e.vector AS cached_vector FROM memories m LEFT JOIN embeddings e ON e.memory_id=m.id AND e.model=? WHERE ${where} ORDER BY m.recorded_at DESC LIMIT 201`).bind(modelKey,...values).all<MemoryRow & {cached_vector:string|null}>();
   if(recent.results.length>200)warnings.push('语义增强仅覆盖最近200条；关键词检索覆盖全部记录。');
   const qv=await embedding(env,args.query);
   // Keep a bounded subrequest budget. Cache misses are filled in groups of 12.
   let generated=0;
   for(const {cached_vector,...r} of recent.results.slice(0,200)){
    const cached=cached_vector;
    if(Date.now()>=deadline)throw new Error('embedding_timeout');
    if(!cached&&generated>=12){if(!warnings.includes('向量缓存尚未完成，本轮只补充12条；关键词仍完整可用。'))warnings.push('向量缓存尚未完成，本轮只补充12条；关键词仍完整可用。');continue;}
    const v=cached?JSON.parse(cached):await embedding(env,r.body,Math.max(1,Math.min(6000,deadline-Date.now())));if(!cached){generated++;await env.DB.prepare('INSERT OR REPLACE INTO embeddings VALUES (?,?,?)').bind(r.id,modelKey,JSON.stringify(v)).run();}
    const score=cosine(qv,v);if(score>=.65){vectors.set(r.id,score);rows.set(r.id,r);}
   }
   mode='hybrid';
  }catch{vectors.clear();rows.clear();for(const r of candidates)rows.set(r.id,r);warnings.push('向量服务不可用，已降级为关键词检索；不代表不存在相关记忆。');}
 }
 const hits=[...rows.values()].map(r=>{const rt=new Set(terms(r.body+' '+r.source));const matched_terms=qt.filter(t=>rt.has(t));const lexical=matched_terms.length/Math.max(1,qt.length);const semantic=vectors.get(r.id)??0;return {...evidence(r),matched_terms,score:Math.round(Math.max(lexical,semantic)*10000)/10000,reason:semantic>lexical?'semantic_similarity':'lexical_overlap'};}).sort((a,b)=>b.score-a.score||b.recorded_at.localeCompare(a.recorded_at)).slice(0,args.limit);
 return {query:args.query,status:hits.length?'matched':'no_match',message:hits.length?`找到 ${hits.length} 条相关记录`:'无匹配记忆',mode,warnings,hits,filters:{include_superseded:args.include_superseded,include_nonfacts:args.include_nonfacts},content_is_untrusted:true};
}
