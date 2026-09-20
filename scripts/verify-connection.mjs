/** End-to-end acceptance using exclusively fictional records. Credentials come from environment. */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base=process.env.MEMORY_BASE_URL??'http://localhost:8791';
const username=process.env.MEMORY_USERNAME??'fiction';
const password=process.env.MEMORY_PASSWORD??(base==='http://localhost:8791'?'fiction-local-password':'');
if(!password)throw new Error('Set MEMORY_PASSWORD without putting credentials in command-line arguments.');
const run='fiction-'+randomBytes(8).toString('hex');
const results=[];const check=(name)=>{results.push(name);console.log('PASS '+name);};
const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
async function request(path,options={}){return fetch(base+path,{redirect:'manual',...options});}
assert.equal((await request('/api/memories')).status,401);
assert.equal((await request('/')).status,302);
let unauthorized=await request('/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
assert.equal(unauthorized.status,401);assert.match(unauthorized.headers.get('www-authenticate'),/resource_metadata/);check('unauthorized page, API and MCP rejected');
const discovery=await(await request('/.well-known/oauth-authorization-server')).json();assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
const protectedResource=await(await request('/.well-known/oauth-protected-resource')).json();assert.equal(protectedResource.resource,base+'/mcp');check('OAuth discovery and canonical MCP audience');
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROME?{channel:'chrome'}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
const grantIds=[];const clients=[];
try{
 await page.goto(base+'/');await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录'}).click();await page.waitForURL(base+'/');await page.locator('#new-button').waitFor();
 const cookie=(await context.cookies(base)).map(c=>`${c.name}=${c.value}`).join('; ');
 async function web(path,data,method='POST'){return request(path,{method,headers:{...headers,cookie,origin:base},...(data?{body:JSON.stringify(data)}:{})});}
 assert.equal((await request('/api/memories',{method:'POST',headers:{...headers,cookie,origin:'https://evil.example'},body:'{}'})).status,403);
 check('real browser login and cross-origin write rejection');
 const body=`虚构验收 ${run}：蓝色纸船放在北窗木盒里。`;
 await page.locator('#new-button').click();await page.locator('#body').fill(body);await page.locator('#source').fill('虚构验收来源 / '+run);await page.locator('.optional-fields summary').click();await page.locator('#source-id').fill(run+'-v1');await page.locator('#save-button').click();await page.locator('#detail[open]').waitFor();
 const list=await(await request('/api/memories',{headers:{cookie}})).json();const record=list.items.find(r=>r.source_id===run+'-v1');assert.ok(record);assert.equal(record.body,body);check('page saved exact fictional original to persistent database');
 async function authorize(scope){
  const registration=await request('/oauth/register',{method:'POST',headers,body:JSON.stringify({client_name:'Fiction acceptance '+run,redirect_uris:['http://localhost:9457/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
  assert.equal(registration.status,201);const client=await registration.json();
  const verifier=randomBytes(48).toString('base64url');const state=randomBytes(16).toString('hex');
  const query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'http://localhost:9457/callback',scope,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:base+'/mcp'});
  const url=base+'/authorize?'+query;
  const consent=await request('/authorize?'+query,{headers:{cookie}});assert.equal(consent.status,200);const html=await consent.text();
  const csrf=html.match(/name="csrf_token" value="([^"]+)"/)?.[1];assert.ok(csrf);
  const denied=await request('/authorize/decision',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie,origin:base},body:new URLSearchParams({authorize_url:url,csrf_token:'wrong',decision:'approve'})});assert.equal(denied.status,403);
  const approve=await request('/authorize/decision',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie,origin:base},body:new URLSearchParams({authorize_url:url,csrf_token:csrf,decision:'approve'})});assert.equal(approve.status,303);
  const callback=new URL(approve.headers.get('location'));assert.equal(callback.searchParams.get('state'),state);const code=callback.searchParams.get('code');assert.ok(code);
  const tokenResponse=await request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:'http://localhost:9457/callback',code,code_verifier:verifier,resource:base+'/mcp'})});
  assert.equal(tokenResponse.status,200);const token=await tokenResponse.json();assert.ok(token.access_token);

  const grants=await(await request('/api/connections',{headers:{cookie}})).json();grantIds.push(...grants.grants.filter(g=>g.clientId===client.client_id).map(g=>g.id));
  return {...token,clientId:client.client_id,code,verifier};
 }
 const token=await authorize('memory:read memory:write');check('DCR → authenticated consent → PKCE → resource-bound access token; CSRF rejected');
 async function connect(accessToken){const client=new Client({name:'Memory fictional acceptance',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+accessToken}}}));clients.push(client);return client;}
 const client=await connect(token.access_token);const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),['memory_correct','memory_get','memory_save','memory_search']);check('official MCP SDK initialized and listed all four tools');
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.equal(r.isError,undefined,JSON.stringify(r.content));return r.structuredContent??JSON.parse(r.content[0].text);};
 let hits=await call('memory_search',{query:run});assert.ok(hits.hits.some(r=>r.id===record.id&&r.body===body&&r.source==='虚构验收来源 / '+run));
 assert.equal((await call('memory_get',{id:record.id})).body,body);check('MCP search sees the page write; ID lookup returns exact original and source');
 const newer=await call('memory_correct',{id:record.id,body:`虚构验收 ${run}：蓝色纸船实际上放在银色抽屉里。`,kind:'episode',source:'虚构纠正来源 / '+run,source_id:run+'-v2',correction_reason:'虚构测试纠正位置'});
 hits=await call('memory_search',{query:run});assert.ok(hits.hits.some(r=>r.id===newer.id));assert.ok(!hits.hits.some(r=>r.id===record.id));
 assert.equal((await call('memory_get',{id:record.id})).body,body);assert.equal((await call('memory_get',{id:newer.id})).versions.length,2);
 check('MCP correction returns new version; default search excludes old; both originals remain traceable');
 const stale=await client.callTool({name:'memory_correct',arguments:{id:record.id,body:'虚构冲突修改',kind:'episode',source:'fiction',correction_reason:'stale'}});assert.equal(stale.isError,true);
 const saved=await call('memory_save',{body:`虚构梦境 ${run}：纸船飞上月亮。`,kind:'dream',source:'虚构梦境',source_id:run+'-dream'});
 assert.ok(!(await call('memory_search',{query:run})).hits.some(r=>r.id===saved.id));assert.equal((await call('memory_search',{query:'zznomatch'+randomBytes(12).toString('hex')})).status,'no_match');check('stale corrections rejected; dreams excluded; unmatched query explicitly no_match');
 const ro=await authorize('memory:read');const reader=await connect(ro.access_token);assert.equal((await reader.callTool({name:'memory_save',arguments:{body:'forbidden',kind:'episode',source:'fiction'}})).isError,true);check('read-only OAuth cannot save');
 const replay=await request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:ro.clientId,redirect_uri:'http://localhost:9457/callback',code:ro.code,code_verifier:ro.verifier,resource:base+'/mcp'})});assert.equal(replay.status,400);check('authorization code replay rejected');
 const wrongAudience=await request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:token.clientId,refresh_token:token.refresh_token,resource:'https://other.example/mcp'})});assert.equal(wrongAudience.status,400);check('wrong token audience rejected');
 const refresh=await request('/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:token.clientId,refresh_token:token.refresh_token,resource:base+'/mcp'})});assert.equal(refresh.status,200);const refreshed=await refresh.json();assert.ok(refreshed.access_token);assert.notEqual(refreshed.refresh_token,token.refresh_token);check('OAuth access renewal with refresh-token rotation');
 const serviceResponse=await web('/api/tokens',{name:'fiction-'+run,scopes:['memory:read'],days:1});assert.equal(serviceResponse.status,201);const service=await serviceResponse.json();const serviceClient=await connect(service.token);assert.ok((await serviceClient.listTools()).tools.length===4);await web('/api/tokens/'+service.id,null,'DELETE');await assert.rejects(serviceClient.listTools());check('Vesper Bearer service token works and revocation denies reuse');
 await page.locator('[data-close="detail"]').click();await page.locator('#query').fill(run);await page.locator('#search-form button[type=submit]').click();await page.locator(`[data-id="${newer.id}"]`).waitFor();await expect(page.locator(`[data-id="${record.id}"]`)).toHaveCount(0);
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'artifacts/mobile.png',fullPage:true});await page.locator('.memory-row').first().click();await page.locator('#detail[open]').waitFor();await page.screenshot({path:'artifacts/mobile-detail.png',fullPage:true});
 assert.deepEqual(pageErrors,[]);check('desktop/mobile page reflects MCP correction; 390px layout has no horizontal overflow or JS errors');
 const report={base,run,ids:{old:record.id,current:newer.id,dream:saved.id},checks:results,verified_at:new Date().toISOString()};
 await writeFile('artifacts/acceptance.json',JSON.stringify(report,null,2));
 for(const id of grantIds)await web('/api/connections/'+id,null,'DELETE');grantIds.length=0;
 await assert.rejects(client.listTools());check('revoked OAuth grant rejected');
 const logout=await request('/logout',{method:'POST',headers:{cookie,origin:base}});assert.equal(logout.status,303);assert.equal((await request('/api/memories',{headers:{cookie}})).status,401);check('logout invalidates server-side session');
 await writeFile('artifacts/acceptance.json',JSON.stringify(report,null,2));
 console.log(`Acceptance passed (${results.length} checks). Fictional IDs written to ignored artifacts/acceptance.json.`);
}finally{for(const c of clients)await c.close().catch(()=>{});await browser.close();}
