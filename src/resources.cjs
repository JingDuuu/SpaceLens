'use strict';
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const readline=require('node:readline');
const path=require('node:path');

class ResourceMonitor extends EventEmitter {
  constructor(root){super();this.root=root;this.seq=0;this.pending=new Map();this.latest=null;this.child=null;this.hardware=null;}
  start(){if(this.child)return;const child=spawn(path.join(this.root,'runtime','monitor','SpaceLens.Monitor.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;this.startedAt=Date.now();child.stdin.on('error',()=>{});child.stderr.resume();
    readline.createInterface({input:child.stdout}).on('line',line=>{try{if(line.length>8_000_000)throw Error('资源采样响应过大');const r=JSON.parse(line);if(r.type==='sample'){this.latest=r.data;this.emit('sample',r.data);}else if(r.type==='error')this.emit('status',{error:r.error});else if(this.pending.has(r.id)){const p=this.pending.get(r.id);clearTimeout(p.timer);this.pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(r.result);}}catch(e){this.emit('status',{error:e.message});}});
    const fail=e=>{if(this.child!==child)return;this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('资源采集连接已关闭'));}this.pending.clear();if(!this.closing)this.emit('status',{error:e?.message||'采集进程已退出，点击重新连接。'});};child.once('error',fail);child.once('exit',()=>fail());
  }
  request(method,args={}){this.start();const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('资源操作超时，请检查状态'));},20000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,...args})+'\n');});}
  async snapshot(){this.start();if(this.latest&&Date.now()-Date.parse(this.latest.timestamp)<6500&&this.latest.cpu!==null)return this.latest;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.off('sample',on);reject(Error('正在初始化采集器，请重试'));},20000);const on=s=>{if(s.cpu===null)return;clearTimeout(timer);this.off('sample',on);resolve(s);};this.on('sample',on);});}
  async getHardware(){if(!this.hardware)this.hardware=await this.request('hardware');return this.hardware;}
  control(args){if(!['terminate','pause','resume','lower','restore'].includes(args.action)||!Number.isInteger(args.pid)||args.pid<=4||!/^\d{15,20}$/.test(String(args.created)))throw Error('无效进程操作');return this.request('control',{action:args.action,pid:args.pid,created:String(args.created)});}
  async close(){const child=this.child;if(!child)return;this.closing=true;child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const t=setTimeout(resolve,15000);child.once('exit',()=>{clearTimeout(t);resolve();});});this.child=null;this.latest=null;this.hardware=null;this.closing=false;}
}
module.exports={ResourceMonitor};
