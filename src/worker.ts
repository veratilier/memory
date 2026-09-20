import {OAuthProvider,AuthorizationError} from '@cloudflare/workers-oauth-provider';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import * as z from 'zod/v4';
import type {Env} from './env';
import {currentUser,login,serviceAuth,SCOPES,COOKIE,type User} from './auth';
import {assertSameOrigin,getCookie,sessionCookie,sha256,hashPassword,verifyPassword,createCsrfToken,verifyCsrfToken} from './security';
import {loginPage,consentPage} from './html';
import {McpApiHandler,handleMcp} from './mcp';
import {saveMemory,searchMemory,getMemory,listMemories,kinds,MemoryError} from './memory';
const app=new Hono<{Bindings:Env;Variables:{user:User}}>();
app.use('*',bodyLimit({maxSize:65536,onError:c=>c.json({error:'request_too_large'},413)}));
const safeReturn=(s:string|undefined)=>s?.startsWith('/')&&!s.startsWith('//')&&!/[\\\r\n]/.test(s)?s:'/';
app.get('/health',c=>c.json({ok:true,service:'memory',version:'1.0.0'}));
app.get('/login',async c=>await currentUser(c.req.raw,c.env)?c.redirect(safeReturn(c.req.query('return_to'))):loginPage(safeReturn(c.req.query('return_to'))));
app.post('/login',async c=>{
 if(!assertSameOrigin(c.req.raw,c.env.APP_ORIGIN))return c.json({error:'invalid_origin'},403);
 const form=await c.req.formData();const username=String(form.get('username')??'');const password=String(form.get('password')??'');
 if(username.length>80||password.length>128)return c.json({error:'invalid_credentials'},400);
 const result=await login(c.env,username,password,c.req.header('cf-connecting-ip')??'local');
 if(!result.token){const r=loginPage(safeReturn(String(form.get('return_to')??'/')),result.status===429?'尝试次数过多，请15分钟后重试。':'用户名或密码错误。');return new Response(r.body,{status:result.status,headers:r.headers});}
 const r=c.redirect(safeReturn(String(form.get('return_to')??'/')),303);r.headers.set('set-cookie',sessionCookie(result.token));return r;
});
app.post('/logout',async c=>{
 if(!assertSameOrigin(c.req.raw,c.env.APP_ORIGIN))return c.json({error:'invalid_origin'},403);
 await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(getCookie(c.req.raw,COOKIE)??'')).run();
 const r=c.redirect('/login',303);r.headers.set('set-cookie',sessionCookie('',0));return r;
});
app.get('/authorize',async c=>{
 const user=await currentUser(c.req.raw,c.env);if(!user)return c.redirect('/login?return_to='+encodeURIComponent(new URL(c.req.url).pathname+new URL(c.req.url).search));
 const req=await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);const client=await c.env.OAUTH_PROVIDER.lookupClient(req.clientId);
 if(!client)return c.text('Unknown OAuth client',400);
 const scopes=req.scope.filter(s=>SCOPES.includes(s));if(!scopes.length)return c.text('Request memory:read and/or memory:write scope',400);
 const csrf=await createCsrfToken(getCookie(c.req.raw,COOKIE)!,c.req.url,c.env.SESSION_SECRET);
 return consentPage(client.clientName??req.clientId,scopes,c.req.url,csrf);
});
app.post('/authorize/decision',async c=>{
 if(!assertSameOrigin(c.req.raw,c.env.APP_ORIGIN))return c.json({error:'invalid_origin'},403);
 const user=await currentUser(c.req.raw,c.env);if(!user)return c.redirect('/login');
 const form=await c.req.formData();const url=String(form.get('authorize_url')??'');
 if(!url.startsWith(c.env.APP_ORIGIN+'/authorize?')||!await verifyCsrfToken(String(form.get('csrf_token')??''),getCookie(c.req.raw,COOKIE)??'',url,c.env.SESSION_SECRET))return c.text('Invalid consent request',403);
 const req=await c.env.OAUTH_PROVIDER.parseAuthRequest(new Request(url));
 if(form.get('decision')!=='approve'){const r=new URL(req.redirectUri);r.searchParams.set('error','access_denied');r.searchParams.set('state',req.state);if(req.issuer)r.searchParams.set('iss',req.issuer);return c.redirect(r.toString(),303);}
 const scopes=req.scope.filter(s=>SCOPES.includes(s));if(!scopes.length)return c.text('Missing scope',400);
 const client=await c.env.OAUTH_PROVIDER.lookupClient(req.clientId);
 const {redirectTo}=await c.env.OAUTH_PROVIDER.completeAuthorization({request:req,userId:user.id,metadata:{clientName:client?.clientName??req.clientId},scope:scopes,props:{userId:user.id,clientId:req.clientId,scopes,authVersion:user.auth_version}});
 return c.redirect(redirectTo,303);
});
app.use('/api/*',async(c,next)=>{
 const user=await currentUser(c.req.raw,c.env);if(!user)return c.json({error:'unauthorized'},401);
 if(!['GET','HEAD'].includes(c.req.method)&&!assertSameOrigin(c.req.raw,c.env.APP_ORIGIN))return c.json({error:'invalid_origin'},403);
 c.set('user',user);await next();
});
app.get('/api/session',c=>c.json({username:c.get('user').username,mcp_url:c.env.APP_ORIGIN+'/mcp',embedding_enabled:Boolean(c.env.EMBEDDING_URL&&c.env.EMBEDDING_MODEL)}));
app.get('/api/memories',async c=>{
 const q=c.req.query();const options=z.object({offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(100).default(40),include_superseded:z.enum(['true','false']).default('false'),kind:z.enum(kinds).optional()}).parse(q);
 return c.json(await listMemories(c.env.DB,{...options,include_superseded:options.include_superseded==='true'}));
});
app.post('/api/memories',async c=>c.json(await saveMemory(c.env.DB,await c.req.json()),201));
app.post('/api/search',async c=>c.json(await searchMemory(c.env,await c.req.json())));
app.get('/api/memories/:id',async c=>c.json(await getMemory(c.env.DB,z.uuid().parse(c.req.param('id')))));
app.post('/api/memories/:id/correct',async c=>c.json(await saveMemory(c.env.DB,{...await c.req.json(),id:c.req.param('id')},true),201));
app.get('/api/connections',async c=>{
 const user=c.get('user');const grants=await c.env.OAUTH_PROVIDER.listUserGrants(user.id);
 const tokens=await c.env.DB.prepare('SELECT id,name,scopes,created_at,expires_at FROM service_tokens WHERE user_id=? AND expires_at>? AND auth_version=?').bind(user.id,Date.now(),user.auth_version).all();
 return c.json({grants:grants.items.map(g=>({id:g.id,clientId:g.clientId,scope:g.scope,metadata:g.metadata,createdAt:g.createdAt})),tokens:tokens.results});
});
app.delete('/api/connections/:id',async c=>{await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param('id'),c.get('user').id);return c.json({revoked:true});});
app.post('/api/tokens',async c=>{
 const a=z.object({name:z.string().trim().min(1).max(80),scopes:z.array(z.enum(['memory:read','memory:write'])).min(1).max(2),days:z.number().int().min(1).max(365).default(90)}).strict().parse(await c.req.json());
 const user=c.get('user'),id=crypto.randomUUID(),token='mem_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 await c.env.DB.prepare('INSERT INTO service_tokens VALUES (?,?,?,?,?,?,?,?)').bind(id,await sha256(token),user.id,a.name,JSON.stringify(a.scopes),user.auth_version,new Date().toISOString(),Date.now()+a.days*86400_000).run();
 return c.json({id,token,expires_in_days:a.days},201);
});
app.delete('/api/tokens/:id',async c=>{await c.env.DB.prepare('DELETE FROM service_tokens WHERE id=? AND user_id=?').bind(c.req.param('id'),c.get('user').id).run();return c.json({revoked:true});});
app.post('/api/password',async c=>{
 const a=z.object({current:z.string().max(128),password:z.string().min(12).max(128)}).parse(await c.req.json());const user=c.get('user');
 if(!await verifyPassword(a.current,user.password_hash))return c.json({error:'invalid_password'},403);
 await c.env.DB.batch([c.env.DB.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?').bind(await hashPassword(a.password),user.id),c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),c.env.DB.prepare('DELETE FROM service_tokens WHERE user_id=?').bind(user.id)]);
 return c.json({changed:true,reconnect_required:true});
});
app.get('/',async c=>await currentUser(c.req.raw,c.env)?c.env.ASSETS.fetch(new Request(new URL('/index.html',c.req.url))):c.redirect('/login'));
app.get('/index.html',async c=>await currentUser(c.req.raw,c.env)?c.env.ASSETS.fetch(c.req.raw):c.redirect('/login'));
app.get('/style.css',c=>c.env.ASSETS.fetch(c.req.raw));
app.get('/app.js',c=>c.env.ASSETS.fetch(c.req.raw));
app.onError((err,c)=>{
 if(err instanceof z.ZodError)return c.json({error:'invalid_arguments',details:err.issues.map(i=>({path:i.path,message:i.message}))},400);
 if(err instanceof MemoryError)return c.json({error:err.code},err.status);
 if(err instanceof AuthorizationError)return c.json({error:err.code},400);
 return c.json({error:'operation_failed'},500);
});
function provider(origin:string){return new OAuthProvider<Env>({
 apiRoute:'/mcp',apiHandler:McpApiHandler,defaultHandler:{fetch:(r,e,c)=>app.fetch(r,e,c)},
 authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
 scopesSupported:SCOPES,accessTokenTTL:3600,refreshTokenTTL:30*86400,clientRegistrationTTL:90*86400,
 allowImplicitFlow:false,allowPlainPKCE:false,clientIdMetadataDocumentEnabled:true,
 resourceMetadata:{resource:origin+'/mcp',scopes_supported:SCOPES,bearer_methods_supported:['header'],resource_name:'Memory · Private Library'},
 clientRegistrationCallback:({clientMetadata})=>{if(!Array.isArray(clientMetadata.redirect_uris)||!clientMetadata.redirect_uris.length||clientMetadata.redirect_uris.length>10)return {description:'Invalid redirect URIs'};},
 onError:()=>{},
});}
function headers(response:Response){const r=new Response(response.body,response);r.headers.set('cache-control','no-store');r.headers.set('x-content-type-options','nosniff');r.headers.set('x-frame-options','DENY');r.headers.set('referrer-policy','same-origin');r.headers.set('strict-transport-security','max-age=31536000');r.headers.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");return r;}
export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext){
  if(!env.SESSION_SECRET||env.SESSION_SECRET.length<32)return headers(Response.json({error:'service_not_configured'},{status:503}));
  const url=new URL(request.url);
  if(url.origin!==env.APP_ORIGIN)return headers(Response.json({error:'invalid_host'},{status:403}));
  if(request.headers.has('origin')&&request.headers.get('origin')!==env.APP_ORIGIN)return headers(Response.json({error:'invalid_origin'},{status:403}));
  // OAuth and MCP body bounds, including chunked requests. Do not log payloads or credentials.
  if(request.body){const reader=request.body.getReader();const chunks:Uint8Array[]=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();return headers(Response.json({error:'request_too_large'},{status:413}));}chunks.push(value);}const body=new Uint8Array(size);let at=0;for(const chunk of chunks){body.set(chunk,at);at+=chunk.length;}request=new Request(request,{body});}
  try{
   if(url.pathname==='/mcp'){
    const auth=await serviceAuth(request,env);
    if(auth)return headers(await handleMcp(request,env,auth));
   }
   return headers(await provider(env.APP_ORIGIN).fetch(request,env,ctx));
  }catch{return headers(Response.json({error:'operation_failed'},{status:500}));}
 },
 async scheduled(_event:ScheduledController,env:Env){
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),env.DB.prepare('DELETE FROM service_tokens WHERE expires_at<?').bind(Date.now()),env.DB.prepare('DELETE FROM login_attempts WHERE window_start<?').bind(Date.now()-86400_000)]);
 },
} satisfies ExportedHandler<Env>;
