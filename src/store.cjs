'use strict';
// Snapshot JSON can exceed V8's maximum string size. Import it in a worker,
// one record at a time, and retain only requested rows in the UI process.
const fs = require('node:fs');
const path = require('node:path');
const {Worker} = require('node:worker_threads');
const {DatabaseSync} = require('node:sqlite');
const STORE_VERSION = 1;
const SELECT_NODE = 'id,parent,name,kind,bytes,modified,accessed,files,dirs,category,warning,extra,latest_modified';

function bounded(value,fallback,max=1000){const n=Number(value);return Number.isFinite(n)?Math.max(0,Math.min(max,Math.floor(n))):fallback;}
function abortError(){const error=new Error('已取消快照整理');error.name='AbortError';return error;}
function decodeNode(row){
  if(!row)return undefined;
  const {extra,latest_modified,...node}=row;
  return {...(extra?JSON.parse(extra):{}),...node,latestModified:latest_modified};
}
function filters(options={}){
  const where=[],params=[];
  if(options.search){where.push('instr(name_folded,?)>0');params.push(String(options.search).toLocaleLowerCase());}
  if(options.category&&options.category!=='all'){where.push('category=?');params.push(String(options.category));}
  const days=Number(options.olderDays);
  if(Number.isFinite(days)&&days>0){where.push('(CASE WHEN kind=\'directory\' THEN latest_ms ELSE modified_ms END)<?');params.push(Date.now()-days*86400000);}
  return {where,params};
}
class SnapshotStore {
  constructor(db,id,dbPath){
    this.db=db;this.dbPath=dbPath;this.queryWorker=null;this.pendingQueries=new Map();this.querySequence=0;
    const stored=db.prepare('SELECT value FROM metadata WHERE key=?').get('snapshot');
    const format=db.prepare('SELECT value FROM metadata WHERE key=?').get('storeVersion');
    if(!stored||Number(format?.value)!==STORE_VERSION)throw new Error('快照索引格式不受支持');
    this.meta=JSON.parse(stored.value);
    if(id)this.meta.id=id;
    this.fingerprint=JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get('source').value);
    this.findNode=db.prepare(`SELECT ${SELECT_NODE} FROM nodes WHERE id=?`);
  }
  close(){
    if(this.db){this.db.close();this.db=null;}
    if(this.queryWorker){
      const worker=this.queryWorker;this.queryWorker=null;
      for(const pending of this.pendingQueries.values())pending.reject(new Error('快照已关闭，请重新浏览'));
      this.pendingQueries.clear();worker.unref();this.queryClosing=worker.terminate();
    }
    return this.queryClosing;
  }
  query(method,options){
    if(!this.db)return Promise.reject(new Error('快照已关闭，请重新浏览'));
    if(!this.queryWorker){
      const worker=new Worker(path.join(__dirname,'store-query-worker.cjs'),{workerData:{dbPath:this.dbPath,id:this.meta.id}});
      this.queryWorker=worker;
      const fail=error=>{
        if(this.queryWorker!==worker)return;
        this.queryWorker=null;
        for(const pending of this.pendingQueries.values())pending.reject(error);
        this.pendingQueries.clear();worker.unref();
      };
      worker.on('message',message=>{
        const pending=this.pendingQueries.get(message.requestId);if(!pending)return;
        this.pendingQueries.delete(message.requestId);
        if(message.error){const error=new Error(message.error.message);error.name=message.error.name||'Error';pending.reject(error);}
        else pending.resolve(message.result);
        if(!this.pendingQueries.size)worker.unref();
      });
      worker.on('error',fail);worker.on('exit',code=>fail(new Error(`查询进程已退出 (${code})`)));
    }
    const worker=this.queryWorker,requestId=++this.querySequence;
    worker.ref();
    return new Promise((resolve,reject)=>{
      this.pendingQueries.set(requestId,{resolve,reject});
      try{worker.postMessage({requestId,method,options});}
      catch(error){this.pendingQueries.delete(requestId);if(!this.pendingQueries.size)worker.unref();reject(error);}
    });
  }
  getChildrenAsync(options={}){return this.query('getChildren',options);}
  getTopAsync(options={}){return this.query('getTop',options);}
  getNode(id){return decodeNode(this.findNode.get(Number(id)));}
  getChildren(options={}){
    const {where,params}=filters(options);where.unshift('parent=?');params.unshift(Number(options.id??0));
    const condition=where.join(' AND '),limit=bounded(options.limit,200),offset=bounded(options.offset,0,10000000);
    const counts=this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(bytes),0) AS filteredBytes FROM nodes WHERE ${condition}`).get(...params);
    const items=this.db.prepare(`SELECT ${SELECT_NODE} FROM nodes WHERE ${condition} ORDER BY bytes DESC,name LIMIT ? OFFSET ?`).all(...params,limit,offset).map(decodeNode);
    return {...counts,items};
  }
  getTop(options={}){
    const {where,params}=filters(options);where.unshift("kind='file'");
    const condition=where.join(' AND '),limit=bounded(options.limit,100),offset=bounded(options.offset,0,10000000);
    const {total}=this.db.prepare(`SELECT COUNT(*) AS total FROM nodes WHERE ${condition}`).get(...params);
    const items=this.db.prepare(`SELECT ${SELECT_NODE} FROM nodes WHERE ${condition} ORDER BY bytes DESC,id LIMIT ? OFFSET ?`).all(...params,limit,offset).map(decodeNode);
    return {items,total};
  }
  rootChildren(){return this.db.prepare(`SELECT ${SELECT_NODE} FROM nodes WHERE parent=0 ORDER BY bytes DESC,name`).all().map(decodeNode);}
  getErrors(){return {items:this.db.prepare('SELECT value FROM errors ORDER BY seq LIMIT 10000').all().map(row=>JSON.parse(row.value)),summary:this.meta.summary};}
}
function openStore(dbPath,id){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-16384;');return new SnapshotStore(db,id,dbPath);}
  catch(error){db.close();throw error;}
}
async function prepareStore({jsonPath,dbPath,id,onProgress,signal}){
  if(signal?.aborted)throw abortError();
  const stat=await fs.promises.stat(jsonPath);
  const fingerprint={size:stat.size,mtimeMs:stat.mtimeMs};
  if(fs.existsSync(dbPath)){
    let cached;
    try{
      cached=openStore(dbPath,id);
      if(cached.fingerprint.size===fingerprint.size&&cached.fingerprint.mtimeMs===fingerprint.mtimeMs){
        onProgress?.({stage:'organizing',phase:'ready',processedBytes:stat.size,totalBytes:stat.size,nodes:cached.meta.nodeCount,processedNodes:cached.meta.nodeCount,totalNodes:cached.meta.nodeCount,fraction:1,cached:true});
        if(signal?.aborted){cached.close();throw abortError();}
        return cached;
      }
      cached.close();
    }catch(error){try{cached?.close();}catch{}if(error.name==='AbortError')throw error;}
  }
  await fs.promises.mkdir(path.dirname(dbPath),{recursive:true});
  if(signal?.aborted)throw abortError();
  const cancellation=new Int32Array(new SharedArrayBuffer(4));
  await new Promise((resolve,reject)=>{
    const worker=new Worker(path.join(__dirname,'store-worker.cjs'),{workerData:{jsonPath,dbPath,id,fingerprint,cancellation:cancellation.buffer}});
    let settled=false;
    const abort=()=>Atomics.store(cancellation,0,1);
    const finish=(error)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    worker.on('message',message=>{
      if(message.type==='progress'){try{onProgress?.(message.progress);}catch{/* A UI listener must not invalidate the stored scan. */}}
      else if(message.type==='complete')finish();
      else if(message.type==='error'){const error=new Error(message.message);error.name=message.name||'Error';finish(error);}
    });
    worker.on('error',finish);
    worker.on('exit',code=>{if(!settled)finish(new Error(`快照整理进程意外退出 (${code})`));});
  });
  if(signal?.aborted)throw abortError();
  return openStore(dbPath,id);
}
module.exports={prepareStore,openStore,SnapshotStore,STORE_VERSION};
