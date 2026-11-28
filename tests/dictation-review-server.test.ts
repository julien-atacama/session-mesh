// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {fixture,identityHeaders,processBirth,until} from '../checks/dictation-fixture.ts';

async function controlled(t:TestContext,childTempDepth=0,sessions=['alpha']){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-admission-'));
  fs.chmodSync(directory,0o700);
  const worker=path.join(directory,'worker.cjs'),preload=path.join(directory,'hold.cjs');
  const control=path.join(directory,'control'),release=path.join(directory,'release'),trace=path.join(directory,'trace'),bootstrap=path.join(directory,'bootstrap');
  // This preload runs only in our own worker. It pauses private HTTP replies,
  // without patching Python or adding a route to the application.
  fs.writeFileSync(preload,`const fs=require('node:fs'),http=require('node:http'),create=http.createServer;
const trace=${JSON.stringify(trace)},control=${JSON.stringify(control)},release=${JSON.stringify(release)};
const log=row=>fs.appendFileSync(trace,JSON.stringify(row)+'\\n');
const write=process.stdout.write;
process.stdout.write=function(part){if(String(part).startsWith('{"socket":'))fs.writeFileSync(${JSON.stringify(bootstrap)},JSON.stringify({socket:JSON.parse(String(part)).socket,pid:process.pid}));return write.apply(this,arguments);};
http.createServer=function(options,listener){return create.call(this,options,(req,res)=>{
 log({event:'request',path:req.url});
 const rule=fs.existsSync(control)?JSON.parse(fs.readFileSync(control,'utf8')):null;
 if(rule&&rule.paths.some(path=>path.endsWith('*')?req.url.startsWith(path.slice(0,-1)):path===req.url)){
  if(rule.mode==='drop'){
   log({event:'held',path:req.url});
   const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);req.socket.destroy();}},5);
   return;
  }
  const end=res.end;res.end=function(...args){
  const body=JSON.parse(args[0]);log({event:'held',path:req.url,status:res.statusCode,
    next:body.next,prepared:typeof body.claim==='string'&&body.claim.length>0,
    job:body.job?.job_id??body.job_id,error:body.error?.code});
  const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);end.apply(res,args);}},5);return res;
 };}return listener(req,res);
});};`);
  await build({entryPoints:['backend/dictation-main.ts'],outfile:worker,bundle:true,platform:'node',format:'cjs',target:'node22',logLevel:'silent'});
  let f:Awaited<ReturnType<typeof fixture>>|undefined;
  t.after(async()=>{try{if(f)await f.close();}finally{fs.rmSync(directory,{recursive:true,force:true});}});
  f=await fixture(true,false,undefined,{workerEntry:worker,workerPreload:preload,childTempDepth,sessions});
   const events=():{event:string;path:string;status?:number;next?:string;prepared?:boolean;job?:string;error?:string}[]=>fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
   const pauseRoutes=(paths:string[])=>fs.writeFileSync(control,JSON.stringify({paths}));
   const identity=()=>JSON.parse(fs.readFileSync(bootstrap,'utf8')) as {socket:string;pid:number};
   return {f,events,pause:(route:string)=>pauseRoutes([route]),pauseRoutes,
     drop:(route:string)=>fs.writeFileSync(control,JSON.stringify({paths:[route],mode:'drop'})),
     release:()=>fs.writeFileSync(release,'go'),clearTrace:()=>fs.writeFileSync(trace,''),
     socket:()=>identity().socket,identity};
}

for (const revoked of [true, false]) test(
  `private transport failure ${revoked ? 'after cookie revocation returns 401' : 'without revocation returns 503'}`,
  async t => {
    const c = await controlled(t), f = c.f;
    const login = await f.call(`/login?token=${encodeURIComponent(f.token)}`);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    c.drop('/internal/relay/upload');
    const pending = f.call('/api/transcribe', 'POST', {Cookie:cookie, ...identityHeaders()}, 'synthetic audio');
    void pending.catch(() => {});
    await until(() => c.events().some(event => event.event === 'held' && event.path === '/internal/relay/upload'));
    if (revoked) {
      assert.equal((await f.call('/api/logout-all', 'POST', f.auth)).status, 200);
    }
    c.release();
    const response = await pending;
    assert.equal(response.status, revoked ? 401 : 503, JSON.stringify(response.body));
    assert.equal(f.upstreamCalls, 0);
    assert.equal(c.events().filter(event => event.event === 'request' &&
      event.path === '/internal/relay/commit').length, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /synthetic audio|job_id|preparation/);
  },
);

for(const mode of ['initial liveness','preparation reply','final liveness','commit reply'] as const)
for(const credential of ['cookie','master'] as const)test(`HTTP admission rechecks ${credential} generation after ${mode}`,async t=>{
  const c=await controlled(t),f=c.f;
  const login=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
  const auth=credential==='cookie'?{Cookie:login.headers['set-cookie']![0]!.split(';')[0]!}:f.auth;
  const headers={...auth,...identityHeaders()};
  if(mode==='commit reply'){
    f.setResponse('application/json','{"text":"synthetic retained text"}');
    c.pause('/internal/relay/commit');
  }else if(mode==='preparation reply')c.pause('/internal/relay/upload');
  let held:((created?:number)=>void)|undefined,calls=0;
  if(mode==='initial liveness'||mode==='final liveness')f.onInventory(reply=>{
    calls++;
    if(calls===(mode==='initial liveness'?1:2))held=reply;else reply();
  });
  c.clearTrace();
  const pending=f.call('/api/transcribe','POST',headers,'synthetic audio');
  void pending.catch(()=>{});
  await until(()=>held!==undefined||c.events().some(event=>event.event==='held'));
  if(mode==='preparation reply'||mode==='commit reply'){
    const route=mode==='preparation reply'?'/internal/relay/upload':'/internal/relay/commit';
    const reply=c.events().find(event=>event.event==='held'&&event.path===route);
    assert.equal(reply?.status,200,'the held phase succeeded before generation changed');
    assert.equal(reply.next,mode==='preparation reply'?'commit':'done');
    if(mode==='commit reply')await until(()=>f.upstreamCalls===1);
  }
  const generation=path.join(f.config,'cookie-generation');
  fs.writeFileSync(generation,String(Number(fs.readFileSync(generation,'utf8'))+1));
  if(held)held();else c.release();
  const response=await pending;
  assert.equal(response.status,401,JSON.stringify(response.body));
  assert.doesNotMatch(JSON.stringify(response.body),/synthetic retained text/);
  const operations=c.events().filter(event=>event.event==='request').map(event=>event.path);
  assert.equal(operations.filter(route=>route==='/internal/relay/upload').length,mode==='initial liveness'?0:1);
  assert.equal(operations.filter(route=>route==='/internal/relay/commit').length,mode==='commit reply'?1:0);
  assert.equal(f.upstreamCalls,mode==='commit reply'?1:0);
});

test('one matching HTTP retry failing liveness cannot abort its successful peer',async t=>{
  const c=await controlled(t),f=c.f,headers={...f.auth,...identityHeaders()};
  const initial:((created?:number)=>void)[]=[],final:((created?:number)=>void)[]=[];
  let calls=0;
  f.onInventory(reply=>{
    calls++;
    if(calls<=2){initial.push(reply);if(initial.length===2)for(const send of initial)send();}
    else if(calls<=4)final.push(reply);
    else reply();
  });
  const one=f.call('/api/transcribe','POST',headers,'synthetic audio');
  const two=f.call('/api/transcribe','POST',headers,'synthetic retry');
  void one.catch(()=>{});void two.catch(()=>{});
  await until(()=>final.length===2);
  assert.equal(f.upstreamCalls,0);
  final[0]!(2);
  const failed=await Promise.race([one,two]);assert.equal(failed.status,409);
  assert.equal(f.upstreamCalls,0,'no inference before the remaining attempt commits');
  final[1]!();
  const responses=await Promise.all([one,two]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[202,409]);
  const accepted=responses.find(response=>response.status===202)!;
  await until(async()=>(await f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers)).body.state==='ready');
  assert.equal((await f.call(`/api/transcribe/${accepted.body.job_id}`,'GET',headers)).body.state,'ready');
  assert.equal(f.upstreamCalls,1);
  assert.equal(c.events().some(event=>event.path.startsWith('/internal/abort/')),false);
});

test('HTTP lookup hides a prepared reservation before and after failed final admission',async t=>{
  const c=await controlled(t),f=c.f,headers={...f.auth,...identityHeaders()};
  let calls=0,final:((created?:number)=>void)|undefined;
  f.onInventory(reply=>{if(++calls===2)final=reply;else reply();});
  const pending=f.call('/api/transcribe','POST',headers,'synthetic audio');
  void pending.catch(()=>{});
  await until(()=>final!==undefined);
  const lookup=()=>f.call(`/api/transcribe/request/${headers['X-Mesh-Request-Id']}`,'GET',headers);
  assert.equal((await lookup()).status,404,'private preparation is not admitted work');
  final!(2);assert.equal((await pending).status,409);
  assert.equal((await lookup()).status,404,'failed admission cannot leave a public queued job');
  assert.equal(f.upstreamCalls,0);
});

test('deep child TMPDIR does not lengthen the private worker socket or break the connector',async t=>{
  const c=await controlled(t,8),f=c.f;
  assert.equal((await f.call('/api/transcribe/config','GET',f.auth)).body.enabled,true);
  const socket=c.socket();assert.ok(Buffer.byteLength(socket)<100,socket);
  assert.equal(fs.statSync(path.dirname(socket)).mode&0o777,0o700);
  const headers={...f.auth,...identityHeaders()};
  const admitted=await f.call('/api/transcribe','POST',headers,'synthetic audio');assert.equal(admitted.status,202);
  await until(async()=>(await f.call(`/api/transcribe/${admitted.body.job_id}`,'GET',headers)).body.state==='ready');
  assert.equal(f.upstreamCalls,1);
});

for(const phase of ['preparation reply','commit reply'] as const)
for(const credential of ['cookie','master'] as const)test(`worker loss during ${credential} ${phase} and concurrent logout stays fenced`,async t=>{
  const c=await controlled(t,0,['alpha','beta']),f=c.f,identity=c.identity();
  const login=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
  const cookie={Cookie:login.headers['set-cookie']![0]!.split(';')[0]!};
  const headers={...(credential==='cookie'?cookie:f.auth),...identityHeaders(),'X-Mesh-Session':'beta'};
  let priorJob:string|undefined;
  if(phase==='preparation reply'){
    const seed={...f.auth,...identityHeaders()};
    const old=await f.call('/api/transcribe','POST',seed,'existing audio');
    assert.equal(old.status,202);priorJob=old.body.job_id;
    await until(async()=>(await f.call(`/api/transcribe/${priorJob}`,'GET',seed)).body.state==='ready');
  }
  c.clearTrace();
  c.pauseRoutes(['/internal/principal',phase==='preparation reply'?'/internal/relay/upload':'/internal/relay/commit']);
  const pending=f.call('/api/transcribe','POST',headers,'synthetic private audio');
  void pending.catch(()=>{});
  await finish(pending);

  async function finish(pending:ReturnType<typeof f.call>){
    await until(()=>c.events().some(event=>event.event==='held'&&event.path!=='/internal/principal'));
    const phaseReply=c.events().find(event=>event.event==='held'&&
      event.path===(phase==='preparation reply'?'/internal/relay/upload':'/internal/relay/commit'));
    assert.equal(phaseReply?.status,200,'the held reply must be a successful relay phase');
    assert.equal(phaseReply?.next,phase==='preparation reply'?'commit':'done');
    if(phase==='preparation reply')assert.equal(phaseReply.prepared,true,'the pending upload was prepared');
    else assert.ok(phaseReply.job,'the pending transfer was committed');
    const job=priorJob??phaseReply.job;
    assert.ok(job,'fixture observed an actual prepared/committed job');
    if(phase==='commit reply')await until(()=>f.upstreamCalls===1);
    const logout=f.call('/api/logout-all','POST',cookie);
    void logout.catch(()=>{});
    await until(()=>c.events().some(event=>event.event==='held'&&event.path==='/internal/principal'));
    assert.equal(fs.readFileSync(path.join(f.config,'cookie-generation'),'utf8').trim(),'1');
    process.kill(identity.pid,'SIGKILL');
    const [transfer,revocation]=await Promise.all([pending,logout]);
    assert.ok([401,503].includes(transfer.status),JSON.stringify(transfer.body));
    assert.equal(revocation.status,200);assert.deepEqual(revocation.body,{ok:true,generation:1});
    assert.equal((await f.call(`/api/transcribe/${job}`,'GET',{...identityHeaders(),...cookie})).status,401);
    await until(async()=>(await f.call('/api/transcribe/config','GET',f.auth)).body.enabled===false);
    assert.deepEqual((await f.call('/api/transcribe/config','GET',f.auth)).body,{enabled:false,disabled_reason:'worker_failed'});
    const freshLogin=await f.call(`/login?token=${encodeURIComponent(f.token)}`);
    const fresh={Cookie:freshLogin.headers['set-cookie']![0]!.split(';')[0]!};
    const lookup=await f.call(`/api/transcribe/${job}`,'GET',{...identityHeaders(),...fresh});
    assert.equal(lookup.status,503);assert.equal(lookup.body.error.code,'disabled');
    assert.equal((await f.call('/api/sessions','GET',fresh)).status,200);
    const commits=c.events().filter(event=>event.event==='request'&&event.path==='/internal/relay/commit');
    assert.equal(commits.length,phase==='preparation reply'?0:1);
    assert.equal(f.upstreamCalls,1,'the pending transfer never adds inference after the held phase');
    await until(()=>processBirth(identity.pid)===null&&!fs.existsSync(path.dirname(identity.socket)));
    assert.doesNotMatch(f.errors,/synthetic private|Traceback|Task exception was never retrieved|Session is closed/);
    assert.doesNotMatch(JSON.stringify(transfer.body),/synthetic private|job_id|text/);
  }
});
