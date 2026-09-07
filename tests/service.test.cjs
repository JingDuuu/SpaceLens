'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {SpaceService}=require('../src/service.cjs');
const {parse,definitions}=require('../src/cli.cjs');
const fixture=(id='sample',size=20)=>({schemaVersion:1,id,rootPath:'C:\\演示 & files',startedAt:'2026-09-05T00:00:00Z',finishedAt:'2026-09-05T00:01:00Z',status:'complete',summary:{bytes:size+10,files:3,dirs:1},nodes:[{id:0,parent:null,name:'演示 & files',kind:'directory',bytes:size+10},{id:1,parent:0,name:'素材',kind:'directory',bytes:size},{id:2,parent:1,name:'PV.mp4',kind:'file',bytes:size,category:'video',modified:'2020-01-01T00:00:00Z'},{id:3,parent:0,name:'empty.txt',kind:'file',bytes:0,category:'document'},{id:4,parent:0,name:'script & more.js',kind:'file',bytes:10,category:'code',modified:new Date().toISOString()}],errors:[]});
test('query preserves unicode and zero sizes, reconstructs paths, and bounds top results',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const service=new SpaceService(dir);service.index(fixture());const children=service.children({id:0});assert.equal(children.total,3);assert.equal(children.items[0].kind,'directory');assert.ok(children.items.some(n=>n.bytes===0));assert.equal(service.node({id:2}).path,'C:\\演示 & files\\素材\\PV.mp4');assert.equal(service.top({category:'video',olderDays:180}).items[0].id,2);assert.equal(service.top({limit:1}).items.length,1);assert.equal(service.children({offset:2,limit:1}).items.length,1);assert.equal(service.children({search:'EMPTY'}).total,1);assert.equal(service.node({id:3}).evidence.confidence,'unknown');assert.throws(()=>service.file('..\\escape'));assert.throws(()=>service.node({id:999}));});
test('snapshot comparisons avoid nesting double counting and reject different roots',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const service=new SpaceService(dir);fs.writeFileSync(service.file('before'),JSON.stringify(fixture('before',20)));service.index(fixture('after',50));const diff=await service.compare({id:'before'});assert.equal(diff.items[0].delta,30);assert.equal(diff.items.reduce((s,x)=>s+x.delta,0),30);assert.equal(diff.items[0].name,'素材');const other=fixture('other');other.rootPath='D:\\other';fs.writeFileSync(service.file('other'),JSON.stringify(other));await assert.rejects(service.compare({id:'other'}),/相同/);});
test('CLI preserves shell characters as arguments and MCP exposes no destructive tool',()=>{assert.deepEqual(parse(['--path','C:\\a & b','--older-days','90']),{path:'C:\\a & b',olderDays:'90'});assert.throws(()=>parse(['bad']));assert.ok(definitions.every(d=>!/(delete|execute|uninstall)/i.test(d.name)));assert.ok(definitions.some(d=>d.name==='spacelens_scan'));});
test('folder-age filters account for changed descendants rather than directory timestamp alone',t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const service=new SpaceService(dir),s=fixture();s.nodes[1].modified='2010-01-01T00:00:00Z';s.nodes[2].modified=new Date().toISOString();service.index(s);assert.equal(service.children({olderDays:180}).items.filter(n=>n.id===1).length,0);assert.equal(service.node({id:1}).latestModified,s.nodes[2].modified);});
test('simultaneous scans are reserved before async validation, and invalid startup releases idle state',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const service=new SpaceService(dir);const first=service.scan({path:path.join(dir,'nonexistent')});assert.equal(service.scanning,true);await assert.rejects(service.scan({path:dir}),/已有扫描/);await assert.rejects(first);await service.idlePromise;assert.equal(service.scanning,false);});
test('comparison reserves indexing, reports progress and preserves the active snapshot',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-compare-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const service=new SpaceService(dir),events=[];service.index(fixture('after',50));fs.writeFileSync(service.file('before'),JSON.stringify(fixture('before',20)));service.on('progress',p=>events.push(p));
  const comparison=service.compare({id:'before'});assert.equal(service.scanning,true);await assert.rejects(service.load({id:'before'}),/已有扫描或整理/);
  const result=await comparison;assert.equal(result.items[0].delta,30);assert.equal(service.snapshot.id,'after');assert.equal(service.scanning,false);
  assert.ok(events.some(p=>p.stage==='indexing'));assert.equal(events.at(-1).type,'operation-complete');assert.equal(events.at(-1).operation,'compare');assert.equal(events.some(p=>p.type==='complete'),false);
});
test('comparison cancellation during preparation retains current data and releases reservation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-compare-cancel-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const service=new SpaceService(dir);service.index(fixture('after'));fs.writeFileSync(service.file('before'),JSON.stringify(fixture('before')));
  let resume;service.history=()=>new Promise(resolve=>{resume=resolve;});
  const comparison=service.compare({id:'before'});assert.equal(service.cancel().requested,true);resume([]);
  await assert.rejects(comparison,{name:'AbortError'});assert.equal(service.snapshot.id,'after');assert.equal(service.scanning,false);assert.equal(service.abortController,null);assert.ok(!fs.existsSync(path.join(service.snapshots,'before.sqlite')));
});
test('comparison rejects a known different root before attempting an expensive import',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-compare-root-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const service=new SpaceService(dir);service.index(fixture('after'));service.history=async()=>[{id:'other',rootPath:'D:\\other',summary:{}}];let imported=false;
  service.prepare=async()=>{imported=true;throw new Error('Unexpected import');};
  await assert.rejects(service.compare({id:'other'}),/相同扫描路径/);assert.equal(imported,false);assert.equal(service.scanning,false);
});
test('store-backed service browsing awaits worker queries and enriches the matching snapshot',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-service-query-')),service=new SpaceService(dir);
  t.after(async()=>{await service.store?.close();service.close();fs.rmSync(dir,{recursive:true,force:true});});
  fs.writeFileSync(service.file('sample'),JSON.stringify(fixture()));await service.load({id:'sample'});
  const children=service.children({id:0});assert.ok(children instanceof Promise);
  const result=await children;assert.equal(result.total,3);assert.ok(result.items.every(n=>n.path.startsWith('C:\\演示 & files\\')));
  assert.equal((await service.top({category:'video'})).items[0].path,'C:\\演示 & files\\素材\\PV.mp4');
});
