'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),readline=require('node:readline');
const exec=promisify(execFile);
const TYPES={folder:'folder:',image:'ext:jpg;jpeg;png;gif;webp;bmp;tif;tiff;heic;avif;svg;psd;exr',video:'ext:mp4;mov;mkv;avi;webm;m4v;wmv;flv;mpg;mpeg;ts',audio:'ext:mp3;wav;flac;aac;ogg;m4a;wma',document:'ext:pdf;doc;docx;xls;xlsx;ppt;pptx;txt;md;csv;rtf',archive:'ext:zip;7z;rar;tar;gz;iso',application:'ext:exe;msi;msix;appx'};
const bound=(n,f,max)=>Number.isFinite(Number(n))?Math.max(0,Math.min(max,Math.floor(Number(n)))):f;
function mergeIni(current,managed){
 const values=new Map(managed.slice(1).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
 const lines=String(current||'').replace(/^\uFEFF/,'').split(/\r?\n/),out=[];let section='',found=false;
 const flush=()=>{for(const [key,value]of values)out.push(key+'='+value);values.clear();};
 for(const line of lines){const header=line.match(/^\[([^\]]+)\]$/);if(header){if(section==='everything')flush();section=header[1].toLowerCase();if(section==='everything')found=true;out.push(line);continue;}
   const at=line.indexOf('=');if(section==='everything'&&at>0&&values.has(line.slice(0,at).toLowerCase())){const key=line.slice(0,at).toLowerCase();out.push(key+'='+values.get(key));values.delete(key);}else out.push(line);
 }if(!found)out.push('[Everything]');flush();return out.join('\r\n');
}
function compile(args={}){
 const query=String(args.query||'').trim();if(query.length>2000)throw Error('搜索词过长');
 const types=Array.isArray(args.types)?args.types:args.type?[args.type]:[];if(types.some(t=>!TYPES[t]))throw Error('未知类型筛选');
 let parts=[];if(query)parts.push(args.regex?'regex:"'+query.replaceAll('"','""')+'"':'<'+query+'>');if(types.length)parts.push('<'+types.map(t=>TYPES[t]).join('|')+'>');
 if(args.drive){if(!/^[A-Za-z]:\\$/.test(args.drive))throw Error('无效磁盘');parts.push(args.drive);}
 if(args.minBytes)parts.push('file: size:>='+bound(args.minBytes,0,Number.MAX_SAFE_INTEGER));
 return {query:parts.join(' '),offset:bound(args.offset,0,100000000),limit:bound(args.limit,80,200),sort:({name:1,size:6,modified:14})[args.sort]||1,flags:(args.matchCase?1:0)|(args.matchPath?4:0)};
}
class SearchEngine{
 constructor(root,drives){this.root=root;this.drives=drives;this.instance='SpaceLens-'+crypto.createHash('sha256').update(root.toLowerCase()+'|'+os.hostname()).digest('hex').slice(0,12);this.dir=path.join(root,'data','search');this.runtime=path.join(root,'runtime','search');this.pending=new Map();this.seen=new Map();this.seq=0;this.readyPromise=null;this.closed=false;this.startedAt=Date.now();}
 bridge(){if(this.child)return;const child=spawn(path.join(this.runtime,'SpaceLens.Search.exe'),[this.instance],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;child.stdin.on('error',()=>{});child.stderr.resume();readline.createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line),pending=this.pending.get(r.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(r.id);r.error?pending.reject(Error(r.error)):pending.resolve(r);}catch{}});const fail=()=>{if(this.child===child)this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('搜索连接已断开，请重试'));}this.pending.clear();};child.on('error',fail);child.on('close',fail);}
 request(method,args={}){if(this.closed)return Promise.reject(Error('搜索已关闭'));this.bridge();const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('搜索连接超时，请重试'));},20000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({...args,id,method})+'\n');});}
 async start(){if(this.readyPromise)return this.readyPromise;this.readyPromise=this.prepare().catch(e=>{this.readyPromise=null;throw e;});return this.readyPromise;}
 async prepare(){fs.mkdirSync(this.dir,{recursive:true});this.volumes=await this.drives();const nonNtfs=this.volumes.filter(d=>!['NTFS','ReFS'].includes(d.format));
   const config=path.join(this.dir,'Everything.ini');
   const settings=['[Everything]','app_data=0','service_pipe_name=\\\\.\\pipe\\Everything Service','run_as_admin=0','run_in_background=1','show_tray_icon=0','check_for_updates_on_startup=0','auto_include_fixed_volumes=1','auto_include_removable_volumes=1','auto_include_fixed_refs_volumes=1','auto_include_removable_refs_volumes=1','auto_remove_offline_ntfs_volumes=1','exclude_hidden_files_and_folders=0','exclude_system_files_and_folders=0','exclude_list_enabled=0','index_size=1','index_date_modified=1','index_attributes=1','fast_size_sort=1','fast_date_modified_sort=1','ipc=1','allow_window_message_filter=1','http_server_enabled=0','etp_server_enabled=0','folders='+nonNtfs.map(d=>d.path).join(','),'folder_monitor_changes='+nonNtfs.map(()=>1).join(','),'folder_update_types='+nonNtfs.map(()=>1).join(','),'folder_update_intervals='+nonNtfs.map(()=>5).join(','),'folder_update_interval_types='+nonNtfs.map(()=>0).join(',')];
   const current=await this.request('status');if(!current.connected){fs.writeFileSync(config,mergeIni(fs.existsSync(config)?fs.readFileSync(config,'utf8'):'',settings));const child=spawn(path.join(this.runtime,'Everything.exe'),['-instance',this.instance,'-config',config,'-db',path.join(this.dir,'Everything-'+os.hostname()+'.db'),'-startup'],{windowsHide:true,stdio:'ignore'});this.engine=child;child.unref();child.on('error',e=>{this.startError=e.message;});}
   return this.status(false);
 }
 async status(start=true){if(start)await this.start();const r=await this.request('status');return {...r,instance:this.instance,elapsedMs:Date.now()-this.startedAt,volumes:this.volumes||[],error:this.startError||null};}
 async query(args={}){await this.start();const started=performance.now();const r=await this.request('query',compile(args));for(const item of r.items){this.seen.set(item.path.toLowerCase(),item);if(this.seen.size>2000)this.seen.delete(this.seen.keys().next().value);}return {...r,elapsedMs:performance.now()-started,engine:'Everything 1.4 IPC',items:r.items.map(n=>({...n,category:n.kind==='directory'?'folder':category(n.path)}))};}
 async installService(){await exec(path.join(this.runtime,'Everything.exe'),['-install-service'],{windowsHide:true,timeout:120000});return this.status();}
 async refresh(){await this.start();await exec(path.join(this.runtime,'Everything.exe'),['-instance',this.instance,'-rescan-all'],{windowsHide:true,timeout:15000});return this.status();}
 async shutdown(){if(this.readyPromise)await this.readyPromise.catch(()=>{});const owned=this.engine;await exec(path.join(this.runtime,'Everything.exe'),['-instance',this.instance,'-exit'],{windowsHide:true,timeout:10000}).catch(()=>{});
   // Let the engine finish writing its database before the parent process exits.
   if(owned&&owned.exitCode===null&&owned.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,60000);owned.once('exit',()=>{clearTimeout(timer);resolve();});});
 }
 close(){this.closed=true;this.child?.stdin.end();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('搜索已关闭'));}this.pending.clear();/* The owned engine remains background-local to preserve its live index for CLI and other windows. */}
}
function category(file){const ext=path.extname(file).slice(1).toLowerCase();for(const [type,rule]of Object.entries(TYPES))if(rule.startsWith('ext:')&&rule.slice(4).split(';').includes(ext))return type;return 'other';}
module.exports={SearchEngine,compile,category,TYPES,mergeIni};
