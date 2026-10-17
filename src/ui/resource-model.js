(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ResourceModel=factory();})(typeof globalThis==='object'?globalThis:this,()=>{
  'use strict';const GiB=2**30;
  const sum=(rows,key)=>{const values=rows.map(n=>n[key]).filter(Number.isFinite);return values.length?values.reduce((a,b)=>a+b,0):null;};
  function networkTotal(snapshot,interfaceId='physical'){
    const all=snapshot.interfaces||[],selected=interfaceId==='physical'?all.filter(n=>n.hardware):all.filter(n=>n.id===interfaceId);
    return {downloadBps:sum(selected,'downloadBps'),uploadBps:sum(selected,'uploadBps'),interfaces:selected,scope:interfaceId};
  }
  function groups(snapshot,group=true){
    const live=snapshot.network?.mode==='live'&&!snapshot.network.stale,net=new Map((live?snapshot.network.sample?.processes||[]:[]).map(p=>[p.pid,p]));
    const rows=new Map();for(const p of snapshot.processes||[]){const n=net.get(p.pid),item={...p,downloadBps:live?(n?.downloadBps||0):null,uploadBps:live?(n?.uploadBps||0):null};net.delete(p.pid);const key=group?(p.path||p.name).toLowerCase():p.pid+'/'+p.created;if(!rows.has(key))rows.set(key,{key,name:p.name,path:p.path,processes:[]});rows.get(key).processes.push(item);}
    for(const [pid,n]of net)rows.set('unknown/'+pid,{key:'unknown/'+pid,name:'已退出 / 无法读取的进程',path:'',processes:[{pid,created:null,canControl:false,...n}]});
    return [...rows.values()].map(g=>({...g,cpu:sum(g.processes,'cpu'),memoryBytes:sum(g.processes,'memoryBytes'),vramBytes:sum(g.processes,'vramBytes'),gpu:g.processes.some(p=>Number.isFinite(p.gpu))?Math.max(...g.processes.map(p=>p.gpu||0)):null,downloadBps:sum(g.processes,'downloadBps'),uploadBps:sum(g.processes,'uploadBps'),network:live?(sum(g.processes,'downloadBps')||0)+(sum(g.processes,'uploadBps')||0):null,io:sum(g.processes,'ioReadBps')===null?null:(sum(g.processes,'ioReadBps')||0)+(sum(g.processes,'ioWriteBps')||0)}));
  }
  // Generic decoder-only structures, not model throughput promises.
  const profiles={8:{layers:32,heads:8,dim:128},14:{layers:48,heads:8,dim:128},32:{layers:64,heads:8,dim:128},70:{layers:80,heads:8,dim:128}};
  function estimate({parameters=8,bits=4,context=8192,batch=1,totalBytes=0,freeBytes=0,ramAvailable=0}){
    if(!profiles[parameters]||![4,8,16].includes(bits)||!Number.isFinite(context)||context<512||context>131072||![1,2,4,8].includes(batch))throw Error('无效显存预算参数');
    const p=profiles[parameters],weights=parameters*1e9*bits/8*1.15,kv=context*batch*p.layers*p.heads*p.dim*2*2,overhead=2*GiB,total=weights+kv+overhead;
    const fit=freeBytes>0&&total<=freeBytes?'now':totalBytes>0&&total<=totalBytes*.9?'after-freeing':total-totalBytes*.85<=ramAvailable*.7&&totalBytes>0?'offload':'insufficient';
    return {weights,kv,overhead,total,fit,headroom:freeBytes-total};
  }
  return {GiB,networkTotal,groups,estimate,profiles};
});
