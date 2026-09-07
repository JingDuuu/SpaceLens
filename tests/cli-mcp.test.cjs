'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {command,schema}=require('../src/cli.cjs');
const cliPath=path.resolve(__dirname,'../src/cli.cjs');

function client(t,args,env={}){
  const child=spawn(process.execPath,args,{env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const stdout=[],stderr=[],waiters=[];
  let outBuffer='',errorBuffer='';
  const changed=()=>{for(const waiter of [...waiters])waiter();};
  child.stdout.on('data',data=>{outBuffer+=data.toString('utf8');let i;while((i=outBuffer.indexOf('\n'))>=0){const line=outBuffer.slice(0,i);outBuffer=outBuffer.slice(i+1);if(line.trim())stdout.push(JSON.parse(line));}changed();});
  child.stderr.on('data',data=>{errorBuffer+=data.toString('utf8');let i;while((i=errorBuffer.indexOf('\n'))>=0){const line=errorBuffer.slice(0,i);errorBuffer=errorBuffer.slice(i+1);if(line.trim())stderr.push(line);}changed();});
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  const waitFor=(predicate,description)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{remove();reject(new Error('Timed out: '+description+'; stderr: '+stderr.join('\n')));},5000);
    const remove=()=>{clearTimeout(timer);const index=waiters.indexOf(check);if(index>=0)waiters.splice(index,1);};
    const check=()=>{const value=predicate();if(value){remove();resolve(value);}};
    waiters.push(check);check();
  });
  t.after(async()=>{if(child.exitCode===null&&!child.killed)child.kill();await exit;});
  return {child,stdout,stderr,exit,send:value=>child.stdin.write(JSON.stringify(value)+'\n'),raw:value=>child.stdin.write(value+'\n'),
    response:id=>waitFor(()=>stdout.find(r=>r.id===id),'response '+id),event:name=>waitFor(()=>stderr.find(line=>{try{return JSON.parse(line).event===name;}catch{return false;}}),'event '+name)};
}

function temporaryHome(t){
  const prefix=path.join(os.tmpdir(),'spacelens-mcp-');
  const home=fs.mkdtempSync(prefix);
  t.after(()=>{const resolved=path.resolve(home);assert.ok(resolved.startsWith(path.resolve(prefix)));fs.rmSync(resolved,{recursive:true,force:true});});
  return home;
}

function fakeScannerCode({delayedStart=false}={}){
  return `const {mcp}=require(${JSON.stringify(cliPath)});
    let release,started=0;
    const service={scanPromise:null,async scan(){started++;process.stderr.write(JSON.stringify({event:'starting',started})+'\\n');
      ${delayedStart?"await new Promise(r=>setTimeout(r,100));":""}
      service.scanPromise=new Promise(r=>release=r);process.stderr.write(JSON.stringify({event:'started',started})+'\\n');return {started:true};},
      cancel(){process.stderr.write(JSON.stringify({event:'cancelled',started,hasWorker:Boolean(release)})+'\\n');if(release){release({status:'cancelled'});release=null;}return {requested:true};}};
    mcp(service).then(()=>process.stderr.write(JSON.stringify({event:'closed',started})+'\\n'));`;
}

test('CLI enriched node, children and top all collect usage before querying',async()=>{
  for(const name of ['node','children','top']){
    const calls=[];
    const service={usage:async()=>{calls.push('usage');},[name]:args=>{calls.push(name);return args;}};
    assert.deepEqual(await command(service,name,{id:4}),{id:4});
    assert.deepEqual(calls,['usage',name]);
  }
  assert.ok(schema.commands['mcp-config']);
});

test('real CLI stdio recovers from malformed requests and advertises usable filters',{timeout:7000},async t=>{
  const home=temporaryHome(t);
  const connection=client(t,[cliPath,'mcp'],{SPACELENS_HOME:home});
  connection.raw('null');
  connection.raw('{');
  connection.send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
  connection.send({jsonrpc:'2.0',id:2,method:'tools/list'});
  assert.equal((await connection.response(1)).result.serverInfo.name,'SpaceLens');
  const tools=(await connection.response(2)).result.tools;
  assert.equal(connection.stdout.find(r=>r.error?.code===-32600)?.id,null);
  assert.equal(connection.stdout.find(r=>r.error?.code===-32700)?.id,null);
  const children=tools.find(tool=>tool.name==='spacelens_children');
  assert.equal(children.inputSchema.properties.category.type,'string');
  assert.equal(children.inputSchema.properties.olderDays.type,'integer');
  assert.equal(tools.find(tool=>tool.name==='spacelens_errors').inputSchema.properties.snapshot.type,'string');
  connection.send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'spacelens_children',arguments:null}});
  assert.equal((await connection.response(3)).error.code,-32602);
  connection.send({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'spacelens_children',arguments:{id:'zero'}}});
  assert.equal((await connection.response(4)).error.code,-32602);
  connection.send({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'spacelens_history',arguments:{}}});
  assert.deepEqual(JSON.parse((await connection.response(5)).result.content[0].text),[]);
  connection.child.stdin.end();
  assert.equal((await connection.exit).code,0);
  assert.deepEqual(connection.stderr,[]);
});

test('MCP ping and targeted cancellation bypass a running scan',{timeout:7000},async t=>{
  const connection=client(t,['-e',fakeScannerCode()]);
  connection.send({jsonrpc:'2.0',id:'scan-1',method:'tools/call',params:{name:'spacelens_scan',arguments:{path:'C:\\fixture'}}});
  await connection.event('started');
  connection.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'other-request'}});
  connection.send({jsonrpc:'2.0',id:'ping-1',method:'ping'});
  await connection.response('ping-1');
  assert.equal(connection.stderr.some(line=>JSON.parse(line).event==='cancelled'),false);
  connection.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'scan-1'}});
  const cancelled=JSON.parse(await connection.event('cancelled'));
  assert.equal(cancelled.hasWorker,true);
  connection.send({jsonrpc:'2.0',id:'ping-2',method:'ping'});
  await connection.response('ping-2');
  connection.child.stdin.end();
  assert.equal((await connection.exit).code,0);
  assert.equal(connection.stdout.some(response=>response.id==='scan-1'),false);
});

test('MCP disconnect cancels active scan and never starts a queued scan',{timeout:7000},async t=>{
  const connection=client(t,['-e',fakeScannerCode()]);
  const request=id=>({jsonrpc:'2.0',id,method:'tools/call',params:{name:'spacelens_scan',arguments:{path:'C:\\fixture'}}});
  connection.send(request(1));
  await connection.event('started');
  connection.send(request(2));
  connection.child.stdin.end();
  assert.equal((await connection.exit).code,0);
  const events=connection.stderr.map(line=>JSON.parse(line));
  assert.equal(events.filter(event=>event.event==='started').length,1);
  assert.ok(events.some(event=>event.event==='cancelled'&&event.hasWorker));
  assert.equal(events.find(event=>event.event==='closed').started,1);
});

test('cancellation during asynchronous startup is repeated once the worker exists',{timeout:7000},async t=>{
  const connection=client(t,['-e',fakeScannerCode({delayedStart:true})]);
  connection.send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'spacelens_scan',arguments:{path:'C:\\fixture'}}});
  await connection.event('starting');
  connection.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}});
  connection.child.stdin.end();
  assert.equal((await connection.exit).code,0);
  const cancellations=connection.stderr.map(line=>JSON.parse(line)).filter(event=>event.event==='cancelled');
  assert.ok(cancellations.some(event=>!event.hasWorker));
  assert.ok(cancellations.some(event=>event.hasWorker));
});
