'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {spawn,execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');
const readline = require('node:readline');
const prepareStore = options => require('./store.cjs').prepareStore(options);
const exec = promisify(execFile);
const ROOT = process.env.SPACELENS_HOME || path.resolve(__dirname,'..');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
function integer(value,fallback,max=1000){const n=Number(value);return Number.isFinite(n)?Math.max(0,Math.min(max,Math.floor(n))):fallback;}
function samePath(a,b){return path.resolve(a).replace(/[\\/]+$/,'').toLowerCase()===path.resolve(b).replace(/[\\/]+$/,'').toLowerCase();}
function meta(s){return {schemaVersion:s.schemaVersion,id:s.id,rootPath:s.rootPath,startedAt:s.startedAt,finishedAt:s.finishedAt,status:s.status,summary:s.summary,nodeCount:s.nodeCount??s.nodes?.length??0};}
class SpaceService extends EventEmitter {
  constructor(root=ROOT){super();this.root=root;this.data=path.join(root,'data');this.snapshots=path.join(this.data,'snapshots');fs.mkdirSync(this.snapshots,{recursive:true});this.snapshot=null;this.store=null;this.nodes=new Map();this.childMap=new Map();this.scanning=false;this.loading=false;this.progress=null;this.usageData=null;this.scanPromise=null;}
  async history(){
    const names=await fsp.readdir(this.snapshots),result=[],known=new Set();
    for(const name of names.filter(n=>n.endsWith('.meta.json'))){try{const m=JSON.parse(await fsp.readFile(path.join(this.snapshots,name),'utf8'));if(m.id&&m.rootPath){result.push(m);known.add(m.id);}}catch{}}
    // A previous version could finish scanning but fail to read its >512 MiB JSON.
    // Recover the small leading header only; never read the entire snapshot here.
    for(const name of names.filter(n=>n.endsWith('.json')&&!n.endsWith('.meta.json'))){const id=name.slice(0,-5);if(known.has(id))continue;let handle;try{handle=await fsp.open(this.file(id),'r');const buffer=Buffer.alloc(65536),{bytesRead}=await handle.read(buffer,0,buffer.length,0);const text=buffer.toString('utf8',0,bytesRead),marker=/,\s*"nodes"\s*:\s*\[/.exec(text);if(!marker)continue;const s=JSON.parse(text.slice(0,marker.index)+'}');if(s.schemaVersion===1&&s.rootPath&&s.summary)result.push({...meta(s),id,nodeCount:s.summary.files+s.summary.dirs+1,needsIndex:true,recovered:true});}catch{}finally{await handle?.close();}}
    return result.sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)));
  }
  file(id){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('无效的快照 ID');return path.join(this.snapshots,id+'.json');}
  async initialize(){try{const active=JSON.parse(await fsp.readFile(path.join(this.data,'active.json'),'utf8'));await this.load({id:active.id});}catch(e){if(e.code!=='ENOENT'&&this.progress?.type!=='error')this.reportError(e);}return this;}
  index(s){if(s.schemaVersion!==1||!Array.isArray(s.nodes)||!s.nodes.length||!s.rootPath)throw new Error('快照格式不受支持');const nodes=new Map(),children=new Map();for(const n of s.nodes){if(nodes.has(n.id))throw new Error('快照节点重复');n.latestModified=n.modified||null;nodes.set(n.id,n);if(n.parent!==null&&n.parent!==undefined){if(!children.has(n.parent))children.set(n.parent,[]);children.get(n.parent).push(n.id);}}if(!nodes.has(0))throw new Error('快照缺少根目录');for(const n of [...nodes.values()].sort((a,b)=>b.id-a.id)){const p=nodes.get(n.parent);if(p&&n.latestModified&&(!p.latestModified||Date.parse(n.latestModified)>Date.parse(p.latestModified)))p.latestModified=n.latestModified;}this.snapshot=s;this.nodes=nodes;this.childMap=children;return meta(s);}
  begin(operation,target){if(this.scanning)throw new Error('已有扫描或整理正在进行，请等待完成或停止');this.scanning=true;this.loading=operation!=='scan';this.cancelRequested=false;this.operationStarted=Date.now();this.idlePromise=new Promise(resolve=>{this.idleResolve=resolve;});this.progress={type:'progress',stage:'preparing',operation,files:0,dirs:0,bytes:0,elapsedMs:0,currentPath:target,phaseProgress:null};this.emit('progress',this.progress);}
  publish(update){this.progress={...this.progress,...update,elapsedMs:Date.now()-this.operationStarted,type:'progress'};this.emit('progress',this.progress);}
  async prepare(id){return prepareStore({jsonPath:this.file(id),dbPath:path.join(this.snapshots,id+'.sqlite'),id,signal:this.abortController?.signal,onProgress:p=>this.publish({...p,stage:p.stage,phaseProgress:p.fraction??p.phaseProgress??null})});}
  adopt(store){this.store?.close();this.store=store;this.snapshot=store.meta;this.nodes.clear();this.childMap.clear();return meta(this.snapshot);}
  async persist(){const m=meta(this.snapshot);await fsp.writeFile(path.join(this.snapshots,m.id+'.meta.json'),JSON.stringify(m));await this.saveActive();return m;}
  complete(m){const operation=this.progress?.operation;this.finishScan();this.progress={type:'complete',stage:'ready',operation,snapshot:m};this.emit('progress',this.progress);return m;}
  reportError(e){const operation=this.progress?.operation,currentPath=this.progress?.currentPath;this.finishScan();const message=e.name==='AbortError'?'已停止整理；原始扫描结果已保留，可以从扫描历史重新载入。':e.message;this.progress={type:'error',operation,currentPath,message,previousSnapshot:this.snapshot?meta(this.snapshot):null};try{fs.writeFileSync(path.join(this.data,'last-error.json'),JSON.stringify({at:new Date().toISOString(),...this.progress,code:e.code||null}));}catch{}this.emit('progress',this.progress);}
  async load({id}){this.file(id);this.begin('load',id);this.abortController=new AbortController();try{const info=(await this.history()).find(m=>m.id===id);if(info)this.publish({currentPath:info.rootPath,operation:info.recovered?'recover':'load',files:info.summary.files,dirs:info.summary.dirs,bytes:info.summary.bytes});const store=await this.prepare(id);const m=this.adopt(store);await this.persist();return this.complete(m);}catch(e){this.reportError(e);throw e;}finally{this.abortController=null;}}
  async saveActive(){const tmp=path.join(this.data,randomUUID()+'.tmp');await fsp.writeFile(tmp,JSON.stringify({id:this.snapshot.id}));await fsp.rename(tmp,path.join(this.data,'active.json'));}
  requireSnapshot(){if(!this.snapshot)throw new Error('请先选择硬盘或文件夹进行扫描');}
  lookup(id){return id===null||id===undefined?undefined:this.store?this.store.getNode(Number(id)):this.nodes.get(Number(id));}
  raw(id){this.requireSnapshot();const n=this.lookup(id);if(!n)throw new Error('找不到该文件，请刷新扫描');return n;}
  nodePath(id){const n=this.raw(id);if(n.id===0)return this.snapshot.rootPath;const parts=[];let cur=n;let hops=0;while(cur&&cur.id!==0){if(++hops>Math.min(meta(this.snapshot).nodeCount,4096))throw new Error('快照目录存在循环');parts.push(cur.name);cur=this.lookup(cur.parent);}if(!cur)throw new Error('快照目录不完整');return path.join(this.snapshot.rootPath,...parts.reverse());}
  enrich(n,withEvidence=true){const p=this.nodePath(n.id);let evidence={lastRun:null,daysSince:null,source:'unknown',confidence:'unknown',note:'没有可靠的启动记录；不能据此判断未使用。'};if(withEvidence&&this.usageData)evidence=require('./usage.cjs').evidenceForPath(p,this.usageData);return {...n,path:p,evidence};}
  node({id=0}){return this.enrich(this.raw(id));}
  match(n,{search='',category='all',olderDays=0}={}){const modified=n.kind==='directory'?n.latestModified:n.modified;return (!search||n.name.toLocaleLowerCase().includes(String(search).toLocaleLowerCase()))&&(!category||category==='all'||n.category===category)&&(!Number(olderDays)||(modified&&Date.parse(modified)<Date.now()-Number(olderDays)*86400000));}
  children(options={}){
    const n=this.raw(options.id??0),store=this.store;
    const finish=result=>{
      if(this.store!==store)throw new Error('快照已切换，请重新浏览');
      const ancestors=[];let cur=n;
      while(cur){if(ancestors.length>4096)throw new Error('快照目录存在循环');ancestors.unshift(this.enrich(cur,false));cur=this.lookup(cur.parent);}
      return {...result,node:this.enrich(n),ancestors,items:result.items.map(n=>this.enrich(n))};
    };
    if(store)return store.getChildrenAsync(options).then(finish);
    const filtered=(this.childMap.get(n.id)||[]).map(id=>this.nodes.get(id)).filter(n=>this.match(n,options)).sort((a,b)=>b.bytes-a.bytes||a.name.localeCompare(b.name));
    const offset=integer(options.offset,0,10000000),limit=integer(options.limit,200,1000);
    return finish({items:filtered.slice(offset,offset+limit),total:filtered.length,filteredBytes:filtered.reduce((s,n)=>s+n.bytes,0)});
  }
  top(options={}){this.requireSnapshot();const store=this.store;if(store)return store.getTopAsync(options).then(r=>{if(this.store!==store)throw new Error('快照已切换，请重新浏览');return {...r,items:r.items.map(n=>this.enrich(n))};});const limit=integer(options.limit,100,1000);let total=0;const selected=[];for(const n of this.snapshot.nodes){if(n.kind!=='file'||!this.match(n,options))continue;total++;if(selected.length===limit&&n.bytes<=selected[selected.length-1]?.bytes)continue;selected.push(n);selected.sort((a,b)=>b.bytes-a.bytes);if(selected.length>limit)selected.pop();}return {items:selected.map(n=>this.enrich(n)),total};}
  async state(){return {scanning:this.scanning,loading:this.loading,progress:this.progress,snapshot:this.snapshot?meta(this.snapshot):null,history:await this.history()};}
  async drives(){const code="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $d=@([System.IO.DriveInfo]::GetDrives() | Where-Object {$_.IsReady} | ForEach-Object {[pscustomobject]@{path=$_.Name;label=$_.VolumeLabel;total=$_.TotalSize;free=$_.AvailableFreeSpace;type=$_.DriveType.ToString();format=$_.DriveFormat}}); ConvertTo-Json -InputObject $d -Compress";const {stdout}=await exec(POWERSHELL,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:1024*1024,encoding:'utf8'});return JSON.parse(stdout.trim()||'[]');}
  async usage({refresh=false}={}){if(refresh)this.usagePromise=null;if(!this.usagePromise){this.usagePromise=require('./usage.cjs').collectUsage().then(data=>{this.usageData=data;return data;}).catch(e=>{this.usagePromise=null;throw e;});}return this.usagePromise;}
  async scan({path:target,workers}={}){
    if(this.scanning)throw new Error('已有扫描正在进行');
    if(typeof target!=='string'||!target.trim()||!path.isAbsolute(target))throw new Error('请输入完整的硬盘或文件夹路径');
    this.begin('scan',target);
    try {
      target=path.resolve(target);
      const stat=await fsp.stat(target);
      if(!stat.isDirectory())throw new Error('扫描目标必须是文件夹或硬盘');
      const id=new Date().toISOString().replace(/[^0-9]/g,'')+'-'+randomUUID().slice(0,8);
      const output=this.file(id),scanner=path.join(this.root,'runtime','scanner','SpaceLens.Scanner.exe');
      if(!fs.existsSync(scanner))throw new Error('缺少扫描引擎，请完整复制 SpaceLens 文件夹');
      this.publish({stage:'scanning',currentPath:target});
      const args=['scan','--path',target,'--output',output];
      if(workers)args.push('--workers',String(integer(workers,4,32)||1));
      this.scanPromise=new Promise((resolve,reject)=>{
        const child=spawn(scanner,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
        this.child=child;let stderr='',spawnError=null,completion=null;
        child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-16000);});
        child.stdin.on('error',()=>{});
        if(this.cancelRequested)child.stdin.write('cancel\n');
        const lines=readline.createInterface({input:child.stdout});
        lines.on('line',line=>{try{const p=JSON.parse(line);if(p.type==='progress')this.publish(p);else if(p.type==='complete')completion=p;}catch{}});
        child.on('error',e=>{spawnError=e;});
        child.on('close',async code=>{
          this.child=null;
          try {
            if(spawnError)throw spawnError;
            if(!fs.existsSync(output))throw new Error(stderr||`扫描引擎退出 (${code})`);
            if(code!==0&&!['partial','cancelled'].includes(completion?.status))throw new Error(stderr||`扫描未正常完成 (${code})`);
            this.abortController=new AbortController();
            this.publish({stage:'indexing',phaseProgress:0});
            const store=await this.prepare(id);const m=this.adopt(store);
            await this.persist();resolve(this.complete(m));
          }catch(e){this.reportError(e);reject(e);}finally{this.abortController=null;}
        });
      });
      this.scanPromise.catch(()=>{});
      return {started:true,id};
    }catch(e){this.reportError(e);throw e;}
  }
  finishScan(){this.scanning=false;this.loading=false;this.idleResolve?.();this.idleResolve=null;}
  cancel(){if(!this.scanning)return {requested:false};this.cancelRequested=true;if(this.child)this.child.stdin.write('cancel\n');else this.abortController?.abort();return {requested:true};}
  async compare({id}){
    this.requireSnapshot();this.file(id);
    const after=meta(this.snapshot);
    this.begin('compare',after.rootPath);this.abortController=new AbortController();
    let store;
    try{
      const info=(await this.history()).find(item=>item.id===id);
      if(info&&!samePath(info.rootPath,after.rootPath))throw new Error('请选择相同扫描路径的快照进行对比');
      if(info)this.publish({currentPath:info.rootPath,files:info.summary?.files||0,dirs:info.summary?.dirs||0,bytes:info.summary?.bytes||0});
      store=await this.prepare(id);
      const before=store.meta;
      if(!samePath(before.rootPath,after.rootPath))throw new Error('请选择相同扫描路径的快照进行对比');
      const curr=(this.store?this.store.rootChildren():this.snapshot.nodes.filter(n=>n.parent===0));
      const prev=new Map(store.rootChildren().map(n=>[n.name.toLowerCase(),n]));
      const result=[];
      for(const n of curr){const old=prev.get(n.name.toLowerCase());prev.delete(n.name.toLowerCase());result.push({path:this.nodePath(n.id),id:n.id,name:n.name,before:old?.bytes||0,after:n.bytes,delta:n.bytes-(old?.bytes||0)});}
      for(const n of prev.values())result.push({path:path.join(before.rootPath,n.name),id:null,name:n.name,before:n.bytes,after:0,delta:-n.bytes});
      result.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
      const response={items:result,before:meta(before),after,scope:'root-children',note:'对比根目录下每个项目的累计大小；部分扫描的差值不能视为实际增减。'};
      this.finishScan();this.progress={type:'operation-complete',stage:'ready',operation:'compare',currentPath:after.rootPath};this.emit('progress',this.progress);
      return response;
    }catch(e){this.reportError(e);throw e;}finally{store?.close();this.abortController=null;}
  }
  async exportTo(destination){this.requireSnapshot();await fsp.copyFile(this.file(this.snapshot.id),destination);return {path:destination};}
  errors(){this.requireSnapshot();return this.store?this.store.getErrors():{items:this.snapshot.errors||[],summary:this.snapshot.summary};}
  get cleaner(){if(!this.cleanupEngine)this.cleanupEngine=new (require('./cleanup.cjs').CleanupEngine)({auditPath:path.join(this.data,'cleanup-audit.jsonl'),onProgress:p=>this.emit('progress',p)});return this.cleanupEngine;}
  cleanupScan(){return this.cleaner.scan();}
  cleanupDetails(args){return this.cleaner.details(args);}
  cleanupCancel(){return this.cleaner.cancel();}
  async cleanupApps(args={}){return require('./cleanup.cjs').appCandidates(await this.usage({refresh:Boolean(args.refresh)}),args);}
  get searchEngine(){if(!this.searcher)this.searcher=new (require("./search.cjs").SearchEngine)(this.root,()=>this.drives());return this.searcher;}
  async initializeSpace(){if(!this.spaceInit)this.spaceInit=this.initialize();await this.spaceInit;return this.state();}
  searchStatus(){return this.searchEngine.status();}
  search(args){return this.searchEngine.query(args);}
  get resourcesEngine(){if(!this.resourcesReader)this.resourcesReader=new(require('./resources.cjs').ResourceMonitor)(this.root);return this.resourcesReader;}
  resources(){return this.resourcesEngine.snapshot();}
  hardware(){return this.resourcesEngine.getHardware();}
  close(){this.searcher?.close();this.resourcesReader?.close();this.store?.close();this.store=null;}
}
module.exports={SpaceService,ROOT,meta,samePath};
