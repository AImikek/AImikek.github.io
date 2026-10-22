import test from 'node:test';
import assert from 'node:assert/strict';
import {hubOwner, hubSummary} from './hub-summary.mjs';
const now = Math.floor(Date.now()/1000);
const claims = {aud:'mikek-tasks',iss:'https://securetoken.google.com/mikek-tasks',sub:'owner-id',exp:now+3600,auth_time:now-10};
const request = (overrides={}) => new Request('https://example.com/api/hub/summary',{headers:{Authorization:'Bearer h.'+Buffer.from(JSON.stringify({...claims,...overrides})).toString('base64url')+'.s'}});
const user = {localId:'owner-id',email:'m@mikek.ai',emailVerified:true,validSince:now-20};
const lookup = (u=user) => async () => Response.json({users:[u]});
test('DUA summary requires a Google-validated, current owner token',async()=>{
  assert.equal(await hubOwner(request(),lookup()),true);
  for (const u of [{...user,email:'visitor@example.com'},{...user,emailVerified:false},{...user,disabled:true},{...user,validSince:now},{...user,localId:'other'}]) assert.equal(await hubOwner(request(),lookup(u)),false);
  for(const c of [{aud:'another-project'},{iss:'wrong'},{exp:now-1},{auth_time:now+60}]) assert.equal(await hubOwner(request(c),()=>{throw Error('Must reject before lookup');}),false);
  assert.equal(await hubOwner(request(),async()=>new Response('',{status:400})),false);
  assert.equal(await hubOwner(new Request('https://example.com'),lookup()),false);
});
test('unauthorized requests cannot query signer records; allowed responses exclude private evidence',async()=>{
  let queries=0;const env={DB:{prepare(sql){queries++;return {first:async()=>({total:2,signed:1,legacy:1}),all:async()=>({results:[{id:'1',name:'Example',company:'Co',agreement_type:'signed_nda_prior',acknowledged_at:'2026-10-01T00:00:00Z',email:'private',ip_address:'private',electronic_signature:'private'}]})};}}};
  assert.equal((await hubSummary(new Request('https://example.com'),env,new Headers(),lookup())).status,401);
  assert.equal(queries,0);
  const result=await hubSummary(request(),env,new Headers(),lookup());
  assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  const data=await result.json();assert.equal(data.signed,1);assert.equal(data.rows[0].status,'Signed NDA');assert.equal(JSON.stringify(data).includes('private'),false);
});
