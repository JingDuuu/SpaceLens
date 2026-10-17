'use strict';
// Control tests target only a child created here. ETW opt-in runs on an elevated CI runner.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{spawn}=require('node:child_process'),readline=require('node:readline'),net=require('node:net');
const root=process.env.SPACELENS_TEST_RELEASE||path.resolve(__dirname,'..'),exe=path.join(root,'runtime','monitor','SpaceLens.Monitor.exe');
let collector,worker,server,socket,timer,latest,id=0,ticks=0;const pending=new Map(),samples=[];
const wait=async(condition,timeout=15000)=>{const until=Date.now()+timeout;while(!condition()){if(Date.now()>until)throw Error('Timed out waiting for native state');await new Promise(r=>setTimeout(r,100));}};
function request(method,args={}){const key=++id;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(key);reject(Error('Request timeout: '+method));},20000);pending.set(key,{resolve:r=>{clearTimeout(timeout);resolve(r);},reject:e=>{clearTimeout(timeout);reject(e);}});collector.stdin.write(JSON.stringify({id:key,method,...args})+'\n');});}
(async()=>{
 collector=spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});collector.stderr.resume();readline.createInterface({input:collector.stdout}).on('line',line=>{const r=JSON.parse(line);if(r.type==='sample'){latest=r.data;samples.push(r.data);}else if(pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(r.result);}});
 await wait(()=>latest?.cpu!==null&&latest?.cpu!==undefined);assert.ok(latest.memory.totalBytes>0);assert.ok(latest.cpu>=0&&latest.cpu<=100);assert.ok(latest.interfaces.every(n=>n.downloadBps===null||n.downloadBps>=0));const hardware=await request('hardware');assert.ok(hardware.logicalProcessors>0);
 worker=spawn(process.execPath,['-e','setInterval(()=>process.stdout.write("tick\\n"),100)'],{windowsHide:true,stdio:['ignore','pipe','ignore']});worker.stdout.on('data',b=>ticks+=b.length);await wait(()=>latest.processes.some(p=>p.pid===worker.pid));const target=latest.processes.find(p=>p.pid===worker.pid);assert.ok(target.created);
 await assert.rejects(request('control',{action:'terminate',pid:worker.pid,created:String(BigInt(target.created)+1n)}),/重新启动/);assert.equal(worker.exitCode,null);
 await assert.rejects(request('control',{action:'terminate',pid:process.pid,created:'1'}),/受保护/);
 await request('control',{action:'lower',pid:worker.pid,created:target.created});await wait(()=>latest.processes.find(p=>p.pid===worker.pid)?.priority==='BelowNormal');await request('control',{action:'restore',pid:worker.pid,created:target.created});
 await request('control',{action:'pause',pid:worker.pid,created:target.created});await new Promise(r=>setTimeout(r,200));const stopped=ticks;await new Promise(r=>setTimeout(r,400));assert.equal(ticks,stopped);await request('control',{action:'resume',pid:worker.pid,created:target.created});await wait(()=>ticks>stopped);
 let etw='not requested';
 if(process.env.SPACELENS_TEST_ETW==='1'){
   assert.equal(hardware.elevated,true,'ETW contract must run elevated; never trigger UAC in CI');await request('network-enable');await wait(()=>latest.network.mode==='live'||latest.network.mode==='error',25000);assert.equal(latest.network.mode,'live',latest.network.error);
   server=net.createServer(socket=>socket.on('data',()=>{}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));socket=net.connect(server.address().port,'127.0.0.1');await new Promise(resolve=>socket.once('connect',resolve));timer=setInterval(()=>socket.write(Buffer.alloc(65536)),40);
   await wait(()=>latest.network.sample?.processes?.some(p=>p.pid===process.pid&&p.uploadBps>50000&&p.downloadBps>50000),15000);clearInterval(timer);timer=null;socket.end();await new Promise(resolve=>server.close(resolve));server=null;etw='real TCP loopback send/receive attributed to fixture PID';await request('network-disable');
 }
 // Closing the collector must resume a suspended fixture even when no UI remains.
 await request('control',{action:'pause',pid:worker.pid,created:target.created});const before=ticks;collector.stdin.end();await wait(()=>collector.exitCode!==null);await wait(()=>ticks>before);
 // Restart the collector and end only the same disposable fixture, verifying its identity again.
 collector=spawn(exe,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});collector.stderr.resume();readline.createInterface({input:collector.stdout}).on('line',line=>{const r=JSON.parse(line);if(r.type==='sample')latest=r.data;else if(pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(r.result);}});
 await request('control',{action:'terminate',pid:worker.pid,created:target.created});await wait(()=>worker.exitCode!==null);assert.equal(worker.exitCode,1);collector.stdin.end();await wait(()=>collector.exitCode!==null);
 console.log(JSON.stringify({passed:true,samples:samples.length,controls:'PID reuse rejected; parent protected; lower/restore; pause/resume; resume on close; terminate fixture',etw,sampleMs:samples.slice(-3).map(s=>Math.round(s.sampleMs))}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(timer)clearInterval(timer);socket?.destroy();server?.close();if(collector?.exitCode===null){collector.stdin.end();await new Promise(r=>setTimeout(r,1500));}worker?.kill();});
