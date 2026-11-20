// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {encode,request,waitFor} from './ptyhost-wire-lib.ts';

for(const partial of [Buffer.alloc(0),encode('C',Buffer.from('[]')).subarray(0,6)]){
  test(`native fixture request rejects a premature close after ${partial.length} bytes`,{timeout:2000},async t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dreq-'));
    const socket=path.join(directory,'p.sock');
    const server=net.createServer(peer=>{peer.once('data',()=>peer.end(partial));});
    await new Promise<void>(resolve=>server.listen(socket,resolve));
    t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true});});
    await assert.rejects(request(socket,{op:'list'}),/closed|truncated|incomplete/i);
  });
}

for(const signal of ['SIGTERM','SIGINT'] as const){
  test(`native fixture owner closes stdin when ${signal} initiates shutdown`,{timeout:15000},async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dstop-'));
    const native=process.env.MESH_PTYHOST_CMD;
    if(native)assert.ok(path.isAbsolute(native)&&fs.existsSync(native),'MESH_PTYHOST_CMD must name the native executable');
    const child=spawn(process.execPath,['--experimental-strip-types',path.resolve('checks/dictation-ptyhost.ts')],{
      env:{PATH:process.env.PATH,HOME:directory,TMPDIR:directory,...(native?{MESH_PTYHOST_CMD:native}:{})},stdio:['pipe','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
    const exited=()=>child.exitCode!==null||child.signalCode!==null;
    try{
      await waitFor('private fixture ready',7000,()=>{assert.equal(exited(),false,errors);return output.includes('\n');});
      child.kill(signal);
      await waitFor('private fixture shutdown with stdin still open',2500,exited);
      assert.equal(child.exitCode,0,errors);
    }finally{
      child.stdin.end();
      if(!exited()){child.kill('SIGCONT');child.kill('SIGTERM');try{await waitFor('fixture cleanup',3000,exited);}catch{child.kill('SIGKILL');}}
      if(!exited())await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
      child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
      fs.rmSync(directory,{recursive:true,force:true});
    }
  });
}
