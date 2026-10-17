#!/usr/bin/env node
'use strict';
const {SpaceService}=require('./service.cjs');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const VERSION='2.1.0';
const schema={name:'SpaceLens',version:VERSION,platform:'Windows x64',output:'JSON on stdout; scan progress JSONL on stderr',readOnly:true,commands:{resources:{mode:'read-only current CPU, GPU, memory, disk and adapter rates'},hardware:{mode:'detected hardware capabilities'},search:{query:'Everything syntax',type:'folder|image|video|audio|document|archive|application',drive:'optional C:\\\\',sort:'name|size|modified',limit:'0–200',offset:'pagination'},'search-status':{},cleanup:{mode:'preview only; deletion requires desktop review'},'cleanup-apps':{olderDays:'90 by default',minBytes:'registered estimated size',includeUnknown:'optional true'},drives:{},scan:{path:'absolute directory path (required)',workers:'optional 1–32',output:'optional copy of snapshot'},children:{snapshot:'optional snapshot id',id:'directory node id, default 0',search:'optional name fragment',category:'all|video|audio|image|archive|code|document|application|other|folder',olderDays:'days since last modification, NOT last use',limit:'1–1000',offset:'pagination offset'},top:{snapshot:'optional',limit:'1–1000',category:'optional',olderDays:'optional'},node:{id:'node id',snapshot:'optional'},apps:{},history:{},diff:{before:'previous snapshot id',snapshot:'current snapshot id (optional)'},errors:{snapshot:'optional'},open:{path:'absolute path OR use --id with current snapshot; Explorer only'},export:{output:'destination json path'},schema:{},'mcp-config':{output:'ready-to-use MCP server configuration for this portable folder'},mcp:{transport:'stdio JSON-RPC 2.0'}},notes:['There is deliberately no delete, execute, uninstall, or shell command tool.','Unknown launch history does not mean unused.','Sizes are logical file sizes; hard links may count more than once, compressed/sparse files differ from occupied space.','Cancelled/partial snapshots are explicitly labelled.']};
function parse(argv){const out={};for(let i=0;i<argv.length;i++){const arg=argv[i];if(!arg.startsWith('--'))throw new Error('Unexpected argument: '+arg);const key=arg.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());if(argv[i+1]===undefined||argv[i+1].startsWith('--'))out[key]=true;else out[key]=argv[++i];}return out;}
async function reveal(target){if(typeof target!=='string'||!path.isAbsolute(target))throw new Error('An absolute path is required');const stat=await fs.promises.stat(target);const explorer=path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe');const child=spawn(explorer,[stat.isDirectory()?target:'/select,'+target],{detached:true,stdio:'ignore',windowsHide:false});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {ok:true,path:target,action:stat.isDirectory()?'open-directory':'select-file'};}
async function command(service,name,args={},context={}){if(context.isCancelled?.())throw new Error('Request cancelled');if(args.snapshot)await service.load({id:args.snapshot});else if(['node','children','top','errors','diff','export'].includes(name)&&!service.snapshot&&typeof service.initializeSpace==='function')await service.initializeSpace();if(context.isCancelled?.())throw new Error('Request cancelled');switch(name){case 'schema':case 'help':return schema;case 'mcp-config':return {mcpServers:{spacelens:{command:path.join(service.root,'SpaceLens.exe'),args:[path.join(service.root,'src','cli.cjs'),'mcp'],env:{ELECTRON_RUN_AS_NODE:'1',SPACELENS_HOME:service.root}}}};case 'resources':case 'hardware':case 'drives':case 'history':case 'errors':return service[name]();case 'scan':await service.scan(args);if(context.isCancelled?.())service.cancel();const result=await service.scanPromise;if(args.output&&!context.isCancelled?.())await service.exportTo(path.resolve(args.output));return result;case 'node':case 'children':case 'top':await service.usage();return service[name](args);case 'search':return service.search({...args,regex:args.regex===true||args.regex==='true',matchCase:args.matchCase===true||args.matchCase==='true',matchPath:args.matchPath===true||args.matchPath==='true'});case 'search_status':case 'search-status':return service.searchStatus();case 'apps':return service.usage();case 'cleanup':return service.cleanupScan();case 'cleanup_apps':case 'cleanup-apps':return service.cleanupApps({...args,includeUnknown:args.includeUnknown===true||args.includeUnknown==='true'});case 'diff':return service.compare({id:args.before});case 'open':return reveal(args.path||service.nodePath(args.id));case 'export':if(!args.output)throw new Error('--output is required');return service.exportTo(path.resolve(args.output));default:throw new Error('Unknown command: '+name+'. Run spacelens.cmd help');}}
const definitions=[
  ['resources','Read current CPU, GPU, memory, disk and adapter rates. No process control.',{}],
  ['hardware','Read CPU, GPU memory and instruction-set capabilities; no unmeasured throughput claims.',{}],
  ['search','Instant filename search across the Everything index. Supports wildcards and Everything syntax. Index must be ready.',{query:{type:'string'},type:{type:'string'},drive:{type:'string'},sort:{type:'string'},limit:{type:'integer',minimum:0,maximum:200},offset:{type:'integer',minimum:0},regex:{type:'boolean'},matchCase:{type:'boolean'},matchPath:{type:'boolean'}}],
  ['search_status','Check search index readiness and connected volumes.',{}],
  ['cleanup','Preview old temporary files in fixed cleanup categories. Does not delete files.',{}],
  ['cleanup_apps','Find apps by last observed launch and registered estimated size. Unknown is not unused.',{olderDays:{type:'integer',minimum:0},minBytes:{type:'integer',minimum:0},includeUnknown:{type:'boolean'}}],
  ['drives','List available Windows drives',{}],
  ['scan','Scan a chosen absolute directory or drive. Read-only, metadata only.',{path:{type:'string'},workers:{type:'integer',minimum:1,maximum:32}},['path']],
  ['children','Browse immediate children of a scanned directory; id 0 is root. olderDays filters modification time, not usage.',{id:{type:'integer'},snapshot:{type:'string'},search:{type:'string'},category:{type:'string'},olderDays:{type:'integer',minimum:0},limit:{type:'integer'},offset:{type:'integer'}}],
  ['top','Largest files in current or chosen snapshot.',{snapshot:{type:'string'},limit:{type:'integer'},category:{type:'string'},olderDays:{type:'integer'}}],
  ['node','File details with explicit usage evidence and confidence.',{id:{type:'integer'},snapshot:{type:'string'}},['id']],
  ['apps','Installed apps and observed execution evidence. Missing history is unknown.',{}],
  ['history','List locally stored scan snapshots.',{}],
  ['diff','Compare root children between snapshots of the same path.',{before:{type:'string'},snapshot:{type:'string'}},['before']],
  ['errors','Read permission errors and skipped-item counts in the current or chosen snapshot.',{snapshot:{type:'string'}}],
  ['open','Open a directory in Explorer or select a file. Never executes or deletes it.',{path:{type:'string'}},['path']]
].map(([name,description,properties,required=[]])=>({name:'spacelens_'+name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:name!=='open',destructiveHint:false,openWorldHint:false}}));
function isObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function isRequestId(value){return typeof value==='string'||(typeof value==='number'&&Number.isFinite(value));}
function validateToolArguments(def,args){
  if(!isObject(args))throw new Error('Tool arguments must be an object');
  for(const key of def.inputSchema.required)if(!Object.hasOwn(args,key))throw new Error('Missing required argument: '+key);
  for(const [key,value] of Object.entries(args)){
    if(!Object.hasOwn(def.inputSchema.properties,key))throw new Error('Unknown argument: '+key);
    const rule=def.inputSchema.properties[key];
    if(rule.type==='string'&&typeof value!=='string')throw new Error(key+' must be a string');
    if(rule.type==='boolean'&&typeof value!=='boolean')throw new Error(key+' must be a boolean');
    if(rule.type==='integer'&&!Number.isInteger(value))throw new Error(key+' must be an integer');
    if(rule.minimum!==undefined&&value<rule.minimum)throw new Error(key+' is below its minimum');
    if(rule.maximum!==undefined&&value>rule.maximum)throw new Error(key+' exceeds its maximum');
  }
}
async function mcp(service){
  const input=readline.createInterface({input:process.stdin});
  const pending=new Map();
  let chain=Promise.resolve(),active=null,disconnected=false;
  const write=obj=>{if(!process.stdout.destroyed)process.stdout.write(JSON.stringify(obj)+'\n');};
  const error=(id,code,message)=>write({jsonrpc:'2.0',id,error:{code,message}});
  const cancel=state=>{
    state.cancelled=true;
    if(active===state&&(state.name==='scan'||service.scanning)){
      try{service.cancel();}catch(e){process.stderr.write(e.message+'\n');}
    }
  };
  const disconnect=()=>{
    if(disconnected)return;
    disconnected=true;
    for(const state of pending.values())cancel(state);
  };
  // Protocol control messages bypass the work queue so cancellation and ping remain
  // responsive even while a long metadata scan is waiting for its worker process.
  input.on('line',line=>{
    let req;
    try{req=JSON.parse(line);}catch{error(null,-32700,'Parse error');return;}
    if(!isObject(req)||req.jsonrpc!=='2.0'||typeof req.method!=='string'||!req.method||
      (Object.hasOwn(req,'id')&&!isRequestId(req.id))){error(isRequestId(req?.id)?req.id:null,-32600,'Invalid Request');return;}
    const notification=!Object.hasOwn(req,'id');
    if(req.params!==undefined&&!isObject(req.params)){if(!notification)error(req.id,-32602,'Params must be an object');return;}
    if(notification){
      if(req.method==='notifications/cancelled'&&isRequestId(req.params?.requestId)){
        const state=pending.get(req.params.requestId);
        if(state)cancel(state);
      }
      return;
    }
    if(pending.has(req.id)){error(req.id,-32600,'Duplicate active request id');return;}
    const respond=result=>write({jsonrpc:'2.0',id:req.id,result});
    switch(req.method){
      case 'initialize':respond({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(req.params?.protocolVersion)?req.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'SpaceLens',version:VERSION},instructions:'Inspect space with scan and browse commands. Unknown execution history is not unused. No delete tool exists.'});return;
      case 'ping':respond({});return;
      case 'tools/list':respond({tools:definitions});return;
      case 'tools/call':break;
      default:error(req.id,-32601,'Method not found');return;
    }
    const def=definitions.find(t=>t.name===req.params?.name);
    if(!def){error(req.id,-32602,'Unknown tool');return;}
    const args=req.params.arguments===undefined?{}:req.params.arguments;
    try{validateToolArguments(def,args);}catch(e){error(req.id,-32602,e.message);return;}
    const state={id:req.id,name:def.name.slice(10),cancelled:false};
    pending.set(req.id,state);
    chain=chain.then(async()=>{
      try{
        if(disconnected||state.cancelled)return;
        active=state;
        const value=await command(service,state.name,args,{isCancelled:()=>disconnected||state.cancelled});
        if(!disconnected&&!state.cancelled)respond({content:[{type:'text',text:JSON.stringify(value)}],isError:false});
      }catch(e){if(!disconnected&&!state.cancelled)respond({content:[{type:'text',text:e.message}],isError:true});}
      finally{pending.delete(req.id);if(active===state)active=null;}
    }).catch(e=>process.stderr.write(e.message+'\n'));
  });
  const outputError=()=>{disconnect();input.close();};
  process.stdout.on('error',outputError);
  await new Promise(resolve=>input.once('close',()=>{disconnect();resolve();}));
  await chain;
  // Keep the stdout error handler until process exit: buffered writes can report
  // a closed client pipe after stdin has already closed and the work queue drained.
}
async function main(){const argv=process.argv.slice(2);const name=argv.shift()||'help';if(name==='--version'){console.log(VERSION);return;}if(name==='--help'){console.log(JSON.stringify(schema,null,2));return;}const service=new SpaceService();process.on('SIGINT',()=>{if(service.scanning)service.cancel();else process.exit(130);});service.on('progress',p=>{if(p.type==='progress')process.stderr.write(JSON.stringify(p)+'\n');});try{if(!['help','schema','mcp-config','drives','history','scan','cleanup','cleanup-apps','search','search-status','resources','hardware','mcp'].includes(name))await service.initialize();if(name==='mcp'){await mcp(service);return;}const result=await command(service,name,parse(argv));process.stdout.write(JSON.stringify(result,null,2)+'\n');}finally{service.close();}}
if(require.main===module)main().catch(e=>{process.stderr.write(JSON.stringify({error:e.message})+'\n');process.exitCode=1;});
module.exports={parse,command,definitions,schema,mcp};
