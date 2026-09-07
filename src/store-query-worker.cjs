'use strict';
// Potentially broad filters run outside Electron's main thread. This worker
// keeps one read-only connection and processes bounded query results in order.
const {parentPort,workerData}=require('node:worker_threads');
const {openStore}=require('./store.cjs');
const store=openStore(workerData.dbPath,workerData.id);
const allowed=new Set(['getChildren','getTop']);
parentPort.on('message',({requestId,method,options})=>{
  try{
    if(!allowed.has(method))throw new Error('不支持的快照查询');
    parentPort.postMessage({requestId,result:store[method](options)});
  }catch(error){parentPort.postMessage({requestId,error:{name:error.name,message:error.message}});}
});
parentPort.on('close',()=>store.close());
