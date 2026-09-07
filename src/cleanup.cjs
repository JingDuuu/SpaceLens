'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID,createHash}=require('node:crypto');
const DAY=86400000;
function within(child,root){const r=path.relative(root,child);return r!==''&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);}
function defaultRoots(){return [
  {id:'user-temp',label:'当前用户临时文件',path:os.tmpdir()},
  {id:'system-temp',label:'Windows 临时文件',path:path.join(process.env.SystemRoot||'C:\\Windows','Temp')},
  {id:'crash',label:'应用崩溃转储',path:path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CrashDumps')},
  {id:'shader',label:'DirectX 着色器缓存',path:path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'D3DSCache')}
];}
async function noLinks(target){
  const absolute=path.resolve(target),parsed=path.parse(absolute);let current=parsed.root;
  for(const piece of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,piece);const stat=await fs.promises.lstat(current);
    if(stat.isSymbolicLink())throw new Error('目录链接不参与清理');
  }
  return fs.promises.lstat(absolute);
}
function identity(stat){return {size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,dev:stat.dev,ino:stat.ino};}
function unchanged(stat,item){return Object.entries(identity(stat)).every(([k,v])=>item[k]===v);}
class CleanupEngine {
  constructor({roots=defaultRoots(),now=()=>Date.now(),onProgress=()=>{},auditPath}={}){this.roots=roots.map(r=>({...r,path:path.resolve(r.path)}));this.now=now;this.onProgress=onProgress;this.auditPath=auditPath;this.busy=false;this.plan=null;}
  reserve(){if(this.busy)throw new Error('清理任务正在进行');this.busy=true;this.cancelled=false;this.idlePromise=new Promise(resolve=>this.resolveIdle=resolve);}
  finish(){this.busy=false;this.resolveIdle?.();}
  cancel(){this.cancelled=true;return {requested:this.busy};}
  progress(data){this.onProgress({type:'cleanup-progress',...data});}
  async scan(){
    this.reserve();this.plan=null;
    const plan={id:randomUUID(),createdAt:this.now(),cutoff:this.now()-7*DAY,files:[],groups:[],checked:0,limited:false};
    const seen=new Set();
    try{
      for(const root of this.roots){
        const group={id:root.id,label:root.label,path:root.path,bytes:0,count:0,skipped:0,issues:[],samples:[]};plan.groups.push(group);
        try{
          if(root.path===path.parse(root.path).root||!['temp','crashdumps','d3dscache'].includes(path.basename(root.path).toLowerCase()))throw new Error('清理目录不在固定规则中');
          const stat=await noLinks(root.path);if(!stat.isDirectory())throw new Error('清理目标不是目录');
          const key=root.path.toLowerCase();if(seen.has(key)){group.issues.push('与已检查类别重叠，未重复计数');continue;}seen.add(key);
          const stack=[root.path];
          while(stack.length&&!this.cancelled&&!plan.limited){
            const dir=stack.pop();let entries;
            try{await noLinks(dir);entries=await fs.promises.readdir(dir,{withFileTypes:true});}catch{group.issues.length<10&&group.issues.push('有目录无权读取，已跳过');continue;}
            for(const entry of entries){
              if(this.cancelled)break;
              if(++plan.checked>200000){plan.limited=true;break;}
              const target=path.join(dir,entry.name);
              try{
                const st=await fs.promises.lstat(target);
                if(st.isSymbolicLink()){group.skipped++;continue;}
                if(st.isDirectory()){stack.push(target);continue;}
                if(!st.isFile()||Math.max(st.mtimeMs,st.ctimeMs,st.birthtimeMs)>plan.cutoff||st.nlink>1){group.skipped++;continue;}
                const item={path:target,group:root.id,...identity(st)};plan.files.push(item);group.bytes+=st.size;group.count++;
                if(group.samples.length<8)group.samples.push(target);
              }catch{group.skipped++;}
              if(plan.checked%150===0)this.progress({stage:'checking',checked:plan.checked,currentPath:dir,eligible:plan.files.length});
            }
          }
        }catch(e){group.issues.push(e.code==='ENOENT'?'此目录不存在，无需清理':e.message);}
        if(this.cancelled)break;
      }
      if(this.cancelled)throw new Error('已停止垃圾检查');
      this.plan=plan;this.progress({stage:'ready',checked:plan.checked,eligible:plan.files.length});
      return this.summary();
    }finally{this.finish();}
  }
  summary(){if(!this.plan)throw new Error('请先检查垃圾');const {files,...result}=this.plan;return {...result,bytes:files.reduce((s,f)=>s+f.size,0),count:files.length,expiresAt:this.plan.createdAt+15*60*1000,note:'只列出固定临时目录内至少 7 天未变动的普通文件。大小为逻辑长度，实际释放量可能不同；不清理个人文档、下载或应用安装目录。'};}
  review({planId,groups}={}){const p=this.plan;if(!p||p.id!==planId||this.now()-p.createdAt>15*60*1000)throw new Error('清理预览已过期，请重新检查');if(!Array.isArray(groups)||!groups.length||groups.some(id=>!p.groups.some(g=>g.id===id)))throw new Error('请选择有效的清理类别');const selected=p.files.filter(f=>groups.includes(f.group));return {files:selected,bytes:selected.reduce((s,f)=>s+f.size,0),count:selected.length,groups:p.groups.filter(g=>groups.includes(g.id))};}
  details({planId,group,offset=0}={}){const r=this.review({planId,groups:[group]});const start=Math.max(0,Math.floor(Number(offset)||0));return {items:r.files.slice(start,start+100).map(f=>({path:f.path,bytes:f.size})),total:r.count,offset:start};}
  async apply(args){
    const review=this.review(args);this.reserve();this.plan=null;
    const report={at:new Date(this.now()).toISOString(),removed:0,bytes:0,skipped:0,issues:[],cancelled:false};
    try{
      for(const file of review.files){
        if(this.cancelled){report.cancelled=true;break;}
        try{
          const root=this.roots.find(r=>r.id===file.group);
          if(!root||!within(file.path,root.path))throw new Error('路径不在清理范围');
          const st=await noLinks(file.path);
          if(!st.isFile()||st.nlink>1||!unchanged(st,file))throw new Error('文件已变化或存在链接，已跳过');
          await fs.promises.unlink(file.path);report.removed++;report.bytes+=file.size;
        }catch(e){report.skipped++;if(report.issues.length<50)report.issues.push({path:file.path,message:e.message});}
        if((report.removed+report.skipped)%25===0)this.progress({stage:'cleaning',done:report.removed+report.skipped,total:review.count,bytes:report.bytes});
      }
      if(this.auditPath){await fs.promises.mkdir(path.dirname(this.auditPath),{recursive:true});await fs.promises.appendFile(this.auditPath,JSON.stringify(report)+'\n').catch(()=>{});}
      this.progress({stage:'complete',done:report.removed+report.skipped,total:review.count,bytes:report.bytes});return report;
    }finally{this.finish();}
  }
}
function appCandidates(usage,{olderDays=90,minBytes=0,includeUnknown=false}={}){
  const now=Date.now(),days=Math.max(0,Number(olderDays)||0),minimum=Math.max(0,Number(minBytes)||0);
  const all=(usage.apps||[]).map(app=>{const elapsed=app.lastRun?Math.max(0,Math.floor((now-Date.parse(app.lastRun))/DAY)):null;return {...app,id:createHash('sha256').update([app.name,app.installLocation,app.executable].join('\0')).digest('hex').slice(0,24),daysSince:elapsed,estimatedBytes:app.estimatedBytes??null};});
  return {items:all.filter(a=>(a.daysSince===null?includeUnknown:a.source!=='RunningProcess'&&a.daysSince>=days)&&(!minimum||a.estimatedBytes>=minimum)).sort((a,b)=>(b.estimatedBytes??-1)-(a.estimatedBytes??-1)),total:all.length,note:'最后可见启动记录不是完整使用历史；大小来自安装程序登记的估算值。无记录单独归类，不自动卸载。'};
}
module.exports={CleanupEngine,defaultRoots,appCandidates,within,noLinks};
