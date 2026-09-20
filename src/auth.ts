import type { Env, AuthProps } from './env';
import {getCookie,sha256,verifyPassword} from './security';
export const COOKIE='__Host-memory-session';
export const SCOPES=['memory:read','memory:write'];
export type User={id:string;username:string;password_hash:string;auth_version:number};
export async function userById(env:Env,id:string){return env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first<User>();}
export async function currentUser(request:Request,env:Env){
 const token=getCookie(request,COOKIE);if(!token)return null;
 return env.DB.prepare('SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.auth_version=u.auth_version').bind(await sha256(token),Date.now()).first<User>();
}
export async function login(env:Env,username:string,password:string,ip:string){
 const hash=await sha256(ip);const cutoff=Date.now()-15*60_000;
 // Atomic reservation before password verification prevents concurrent attempts bypassing the limit.
 const attempt=await env.DB.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts').bind(hash,Date.now(),cutoff,cutoff).first<{attempts:number}>();
 if((attempt?.attempts??99)>8)return {status:429,token:null};
 const user=await env.DB.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').bind(username).first<User>();
 if(!user||!await verifyPassword(password,user.password_hash))return {status:401,token:null};
 const token=crypto.randomUUID()+crypto.randomUUID();
 await env.DB.batch([
  env.DB.prepare('INSERT INTO sessions VALUES (?,?,?,?)').bind(await sha256(token),user.id,user.auth_version,Date.now()+8*3600_000),
  env.DB.prepare('DELETE FROM login_attempts WHERE ip_hash=?').bind(hash),
 ]);
 return {status:200,token};
}
export async function serviceAuth(request:Request,env:Env):Promise<AuthProps|null>{
 const token=request.headers.get('authorization')?.match(/^Bearer (mem_[A-Za-z0-9_-]+)$/)?.[1];if(!token)return null;
 const row=await env.DB.prepare('SELECT t.*,u.auth_version AS current_version FROM service_tokens t JOIN users u ON t.user_id=u.id WHERE t.token_hash=? AND t.expires_at>?').bind(await sha256(token),Date.now()).first<{user_id:string;id:string;scopes:string;auth_version:number;current_version:number}>();
 if(!row||row.auth_version!==row.current_version)return null;
 return {userId:row.user_id,clientId:'service:'+row.id,scopes:JSON.parse(row.scopes),authVersion:row.auth_version};
}
