'use strict';
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {parentPort,workerData}=require('node:worker_threads');
const {Writable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {DatabaseSync}=require('node:sqlite');
const Parser=require('./vendor/stream-json/Parser');
const {jsonPath,dbPath,id,fingerprint}=workerData;
const cancellation=new Int32Array(workerData.cancellation);
const temporary=dbPath+'.'+randomUUID()+'.tmp';
const knownNodeKeys=new Set(['id','parent','name','kind','bytes','modified','accessed','files','dirs','category','warning','latestModified']);
let db,source,nodes=0,errors=0,lastProgress=0;
function checkAbort(){if(Atomics.load(cancellation,0)){const error=new Error('已取消快照整理');error.name='AbortError';throw error;}}
function progress(stage,extra={},force=false){
  const now=Date.now();if(!force&&now-lastProgress<180)return;lastProgress=now;
  const processedBytes=Math.min(source?.bytesRead||0,fingerprint.size);
  parentPort.postMessage({type:'progress',progress:{stage,processedBytes,totalBytes:fingerprint.size,nodes,fraction:stage==='indexing'?(fingerprint.size?processedBytes/fingerprint.size:0):null,...extra}});
}
function milliseconds(value){if(value===null||value===undefined)return null;const ms=Date.parse(value);return Number.isFinite(ms)?ms:null;}
function nullable(value){return value===undefined?null:value;}
function matchingPublishedCache(){
  let published;
  try{
    published=new DatabaseSync(dbPath,{readOnly:true});
    const sourceRow=published.prepare('SELECT value FROM metadata WHERE key=?').get('source');
    const version=published.prepare('SELECT value FROM metadata WHERE key=?').get('storeVersion');
    const snapshot=published.prepare('SELECT value FROM metadata WHERE key=?').get('snapshot');
    const cached=JSON.parse(sourceRow?.value||'null'),meta=JSON.parse(snapshot?.value||'null');
    return version?.value==='1'&&cached?.size===fingerprint.size&&cached?.mtimeMs===fingerprint.mtimeMs&&meta?.nodeCount===nodes;
  }catch{return false;}finally{try{published?.close();}catch{}}
}
// Assemble only one node, error, or small metadata value. The outer nodes/errors
// arrays are consumed directly, so their length never controls JavaScript heap.
class ValueBuilder{
  constructor(){this.stack=[];this.value=undefined;this.done=false;}
  attach(value){
    const parent=this.stack[this.stack.length-1];
    if(!parent)this.value=value;
    else if(Array.isArray(parent.value))parent.value.push(value);
    else {parent.value[parent.key]=value;parent.key=null;}
  }
  consume(token){
    const {name,value}=token;
    if(name==='keyValue'){this.stack[this.stack.length-1].key=value;return;}
    if(name==='startObject'||name==='startArray'){
      const result=name==='startArray'?[]:Object.create(null);this.attach(result);this.stack.push({value:result,key:null});return;
    }
    if(name==='endObject'||name==='endArray'){this.stack.pop();this.done=this.stack.length===0;return;}
    this.attach(name==='numberValue'?Number(value):name==='stringValue'?value:name==='trueValue'?true:name==='falseValue'?false:null);
    this.done=this.stack.length===0;
  }
}
async function run(){
  checkAbort();
  db=new DatabaseSync(temporary);
  db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768;
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE nodes(id INTEGER PRIMARY KEY,parent INTEGER,name TEXT NOT NULL,name_folded TEXT NOT NULL,kind TEXT NOT NULL,bytes INTEGER NOT NULL,modified TEXT,accessed TEXT,files INTEGER,dirs INTEGER,category TEXT,warning TEXT,extra TEXT,modified_ms INTEGER,latest_ms INTEGER,latest_modified TEXT);
    CREATE TABLE errors(seq INTEGER PRIMARY KEY,value TEXT NOT NULL);
    BEGIN;`);
  const insert=db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertError=db.prepare('INSERT INTO errors(value) VALUES(?)');
  const meta=Object.create(null),metadataKeys=new Set(['schemaVersion','id','rootPath','startedAt','finishedAt','status','summary']);
  let rootStarted=false,rootEnded=false,rootKey=null,arrayKey=null,builder=null,builderKey=null,skipDepth=0,sawNodes=false,tokenCount=0;
  const storeValue=(key,value)=>{
    if(key==='nodes'){
      if(!value||!Number.isSafeInteger(value.id)||value.id<0||typeof value.name!=='string'||!['file','directory'].includes(value.kind)||!Number.isSafeInteger(value.bytes)||value.bytes<0)throw new Error('快照包含无效的文件记录');
      const parent=nullable(value.parent);
      if(value.id===0?parent!==null:!Number.isSafeInteger(parent)||parent<0||parent>=value.id)throw new Error('快照目录关系无效');
      let extra=null;for(const key of Object.keys(value)){if(!knownNodeKeys.has(key)){extra??=Object.create(null);extra[key]=value[key];}}
      const modified=nullable(value.modified),ms=milliseconds(modified);
      insert.run(value.id,parent,value.name,value.name.toLocaleLowerCase(),value.kind,value.bytes,modified,nullable(value.accessed),nullable(value.files),nullable(value.dirs),nullable(value.category),nullable(value.warning),extra?JSON.stringify(extra):null,ms,ms,ms===null?null:modified);
      nodes++;
      if(nodes%2000===0){checkAbort();db.exec('COMMIT; BEGIN;');progress('indexing');}
    }else if(key==='errors'){insertError.run(JSON.stringify(value));errors++;}
    else meta[key]=value;
  };
  const consume=token=>{
    if((++tokenCount&4095)===0)checkAbort();
    if(skipDepth){if(token.name==='startObject'||token.name==='startArray')skipDepth++;else if(token.name==='endObject'||token.name==='endArray')skipDepth--;return;}
    if(builder){builder.consume(token);if(builder.done){storeValue(builderKey,builder.value);builder=null;}return;}
    if(!rootStarted){if(token.name!=='startObject')throw new Error('快照必须是 JSON 对象');rootStarted=true;return;}
    if(rootEnded)throw new Error('快照包含多余内容');
    if(arrayKey){
      if(token.name==='endArray'){arrayKey=null;return;}
      builderKey=arrayKey;builder=new ValueBuilder();builder.consume(token);if(builder.done){storeValue(builderKey,builder.value);builder=null;}return;
    }
    if(token.name==='keyValue'){rootKey=token.value;return;}
    if(token.name==='endObject'){rootEnded=true;return;}
    if(rootKey==='nodes'||rootKey==='errors'){
      if(token.name==='nullValue'&&rootKey==='errors'){rootKey=null;return;}
      if(token.name!=='startArray')throw new Error('快照文件列表格式不受支持');
      if(rootKey==='nodes'){if(sawNodes)throw new Error('快照文件列表重复');sawNodes=true;}
      arrayKey=rootKey;rootKey=null;return;
    }
    if(!metadataKeys.has(rootKey)){if(token.name==='startObject'||token.name==='startArray')skipDepth=1;rootKey=null;return;}
    builderKey=rootKey;rootKey=null;builder=new ValueBuilder();builder.consume(token);if(builder.done){storeValue(builderKey,builder.value);builder=null;}
  };
  source=fs.createReadStream(jsonPath,{highWaterMark:256*1024});
  progress('indexing',{},true);
  const parser=new Parser({packKeys:true,packStrings:true,packNumbers:true,streamKeys:false,streamStrings:false,streamNumbers:false});
  await pipeline(source,parser,new Writable({objectMode:true,write(token,encoding,callback){try{consume(token);callback();}catch(error){callback(error);}}}));
  if(!rootEnded||!sawNodes||meta.schemaVersion!==1||typeof meta.rootPath!=='string'||!meta.rootPath||!nodes)throw new Error('快照格式不受支持或内容不完整');
  const root=db.prepare('SELECT kind FROM nodes WHERE id=0').get();
  if(root?.kind!=='directory')throw new Error('快照缺少根目录');
  if(db.prepare('SELECT 1 FROM nodes n LEFT JOIN nodes p ON n.parent=p.id WHERE n.id<>0 AND (p.id IS NULL OR p.kind<>\'directory\') LIMIT 1').get())throw new Error('快照目录不完整');
  db.exec('COMMIT;');checkAbort();
  progress('indexing',{processedBytes:fingerprint.size,fraction:1},true);
  progress('organizing',{phase:'dates',processedNodes:0,totalNodes:nodes,fraction:0},true);
  // Parents precede children in scanner IDs. Reverse batches propagate each
  // subtree's newest timestamp without an in-memory tree or unbounded array.
  const batch=db.prepare('SELECT id,parent,kind,latest_ms,latest_modified FROM nodes WHERE id<? ORDER BY id DESC LIMIT 2000');
  const currentDate=db.prepare('SELECT latest_ms,latest_modified FROM nodes WHERE id=?');
  const update=db.prepare('UPDATE nodes SET latest_ms=?,latest_modified=? WHERE id=? AND (latest_ms IS NULL OR latest_ms<?)');
  let cursor=Number.MAX_SAFE_INTEGER,processedNodes=0;
  while(true){
    checkAbort();const rows=batch.all(cursor);if(!rows.length)break;
    db.exec('BEGIN;');
    for(const row of rows){
      // A directory may have been updated by an earlier child in this batch.
      const latest=row.kind==='directory'?currentDate.get(row.id):row;
      if(row.parent!==null&&latest.latest_ms!==null)update.run(latest.latest_ms,latest.latest_modified,row.parent,latest.latest_ms);
    }
    db.exec('COMMIT;');cursor=rows[rows.length-1].id;processedNodes+=rows.length;
    progress('organizing',{phase:'dates',processedNodes,totalNodes:nodes,fraction:processedNodes/nodes*.8});
  }
  checkAbort();progress('organizing',{phase:'indexes',processedNodes:nodes,totalNodes:nodes,fraction:.8},true);
  db.exec('CREATE INDEX nodes_parent_bytes ON nodes(parent,bytes DESC,name);');
  checkAbort();progress('organizing',{phase:'indexes',processedNodes:nodes,totalNodes:nodes,fraction:.9},true);
  db.exec('CREATE INDEX nodes_kind_bytes ON nodes(kind,bytes DESC,id);');
  checkAbort();
  const after=fs.statSync(jsonPath);
  if(after.size!==fingerprint.size||after.mtimeMs!==fingerprint.mtimeMs)throw new Error('整理期间快照文件发生变化，请重新打开');
  const snapshot={schemaVersion:1,id:id||meta.id,rootPath:meta.rootPath,startedAt:meta.startedAt,finishedAt:meta.finishedAt,status:meta.status,summary:meta.summary||{},nodeCount:nodes};
  const save=db.prepare('INSERT INTO metadata VALUES(?,?)');
  db.exec('BEGIN;');save.run('storeVersion','1');save.run('source',JSON.stringify(fingerprint));save.run('snapshot',JSON.stringify(snapshot));db.exec('COMMIT;');
  db.close();db=null;checkAbort();
  try{fs.renameSync(temporary,dbPath);}
  catch(error){
    // A CLI and the desktop may finish importing the same immutable scan at
    // once. Windows can lock the winning cache as soon as it is opened; reuse
    // that complete cache instead of failing or removing a file another reader owns.
    if(!matchingPublishedCache())throw error;
    fs.unlinkSync(temporary);
  }
  progress('organizing',{phase:'ready',processedNodes:nodes,totalNodes:nodes,fraction:1},true);
  parentPort.postMessage({type:'complete'});
}
run().catch(error=>{
  try{source?.destroy();}catch{}
  try{db?.close();}catch{}
  // Only this worker's randomly named incomplete cache may be removed.
  for(const suffix of ['', '-journal','-wal','-shm']){try{fs.unlinkSync(temporary+suffix);}catch{}}
  parentPort.postMessage({type:'error',name:error.name,message:error.message});
});
