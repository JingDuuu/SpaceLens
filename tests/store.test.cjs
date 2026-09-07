'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {once}=require('node:events');
const {constants:bufferConstants}=require('node:buffer');
const {prepareStore,openStore}=require('../src/store.cjs');
const recent='2026-09-05T06:07:08.123Z';
function fixture(){return {
  unknown:{discard:[1,{'奇怪键':['ignored']}]},
  nodes:[
    {id:0,parent:null,name:'C:\\',kind:'directory',bytes:36,modified:'2000-01-01T00:00:00Z',category:'directory'},
    {id:1,parent:0,name:'素材 📽 "\\\n資料',kind:'directory',bytes:25,modified:'2000-01-01T00:00:00Z',files:2,dirs:1},
    {id:2,parent:1,name:'nested',kind:'directory',bytes:20,modified:null},
    {id:3,parent:2,name:'PV_日本語.mov',kind:'file',bytes:20,category:'video',modified:recent,accessed:null,custom:{x:'💾'}},
    {id:4,parent:1,name:'ARCHIVE.zip',kind:'file',bytes:5,category:'archive',modified:'2010-01-01T00:00:00Z'},
    {id:5,parent:0,name:'empty.txt',kind:'file',bytes:0,category:'document',warning:null},
    {id:6,parent:0,name:'A & B.js',kind:'file',bytes:11,category:'code',modified:'2010-01-01T00:00:00Z'}
  ],
  errors:[{path:'C:\\System Volume Information',message:'Access denied',code:5}],
  schemaVersion:1,id:'embedded-id',rootPath:'C:\\',startedAt:'2026-09-05T01:00:00Z',finishedAt:'2026-09-05T01:00:30Z',status:'partial',summary:{bytes:36,files:4,dirs:2,errors:1}
};}
function files(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spacelens-store-')),stores=[];t.after(async()=>{await Promise.all(stores.map(store=>store.close()));fs.rmSync(dir,{recursive:true,force:true});});return {dir,jsonPath:path.join(dir,'fixture.json'),dbPath:path.join(dir,'fixture.sqlite'),id:'filename-id',track(store){stores.push(store);return store;}};}
test('streamed store preserves Unicode, escaping, metadata and partial scan evidence',async t=>{
  const input=files(t),data=fixture(),progress=[];fs.writeFileSync(input.jsonPath,JSON.stringify(data,null,2));
  const store=input.track(await prepareStore({...input,onProgress:p=>progress.push(p)}));
  assert.equal(store.meta.id,'filename-id');assert.equal(store.meta.status,'partial');assert.equal(store.meta.nodeCount,7);
  assert.deepEqual(store.meta.summary,data.summary);assert.equal(store.getNode(1).name,data.nodes[1].name);
  assert.deepEqual(store.getNode(3).custom,{x:'💾'});assert.equal(store.getNode(3).accessed,null);
  assert.equal(store.getNode(0).latestModified,recent);assert.equal(store.getNode(1).latestModified,recent);assert.equal(store.getNode(2).latestModified,recent);
  assert.equal(store.getNode(99),undefined);assert.deepEqual(store.getErrors(),{items:data.errors,summary:data.summary});
  assert.ok(progress.some(p=>p.stage==='indexing'));assert.ok(progress.some(p=>p.stage==='organizing'));assert.equal(progress.at(-1).fraction,1);
});
test('database queries filter, sort, page and include zero-byte children',async t=>{
  const input=files(t);fs.writeFileSync(input.jsonPath,JSON.stringify(fixture()));const store=input.track(await prepareStore(input));
  const children=store.getChildren({id:0});assert.equal(children.total,3);assert.equal(children.filteredBytes,36);assert.deepEqual(children.items.map(n=>n.id),[1,6,5]);
  assert.equal(store.getChildren({id:0,search:'EMPTY'}).items[0].bytes,0);
  assert.deepEqual(store.getChildren({id:0,offset:1,limit:1}).items.map(n=>n.id),[6]);
  assert.equal(store.getChildren({id:0,olderDays:365}).items.some(n=>n.id===1),false);
  assert.deepEqual(store.getTop({category:'archive',olderDays:180}).items.map(n=>n.id),[4]);
  assert.equal(store.getTop({limit:1}).total,4);assert.equal(store.getTop({limit:1}).items[0].bytes,20);
  assert.equal(store.getChildren({id:0,search:'%'}).total,0);assert.equal(store.rootChildren().length,3);
});
test('multibyte characters survive a source chunk boundary',async t=>{
  const input=files(t),data=fixture(),prefix='{"padding":"',rest='",'+JSON.stringify(data).slice(1);
  const padding=262143-Buffer.byteLength(prefix+rest.slice(0,rest.indexOf('📽')));
  fs.writeFileSync(input.jsonPath,prefix+'x'.repeat(padding)+rest);
  const store=input.track(await prepareStore(input));assert.equal(store.getNode(1).name,data.nodes[1].name);
});
test('async queries preserve filters and pagination while leaving main-loop timers responsive',async t=>{
  const input=files(t);fs.writeFileSync(input.jsonPath,JSON.stringify(fixture()));const store=input.track(await prepareStore(input));
  let timerFired=false;setTimeout(()=>{timerFired=true;},0);
  const [children,top]=await Promise.all([store.getChildrenAsync({id:0,offset:1,limit:1}),store.getTopAsync({category:'video',limit:1})]);
  assert.equal(timerFired,true);assert.deepEqual(children.items.map(n=>n.id),[6]);assert.equal(children.total,3);assert.deepEqual(top.items.map(n=>n.id),[3]);
  assert.deepEqual(await store.getTopAsync({search:'DOES_NOT_EXIST'}),{items:[],total:0});
});
test('closing a store rejects pending async queries and releases its worker',async t=>{
  const input=files(t);fs.writeFileSync(input.jsonPath,JSON.stringify(fixture()));const store=input.track(await prepareStore(input));
  const pending=assert.rejects(store.getTopAsync({limit:1}),/关闭/);await store.close();await pending;
  await assert.rejects(store.getChildrenAsync(),/关闭/);
});
test('cache uses source size and timestamp and requested filename identity',async t=>{
  const input=files(t);fs.writeFileSync(input.jsonPath,JSON.stringify(fixture()));(await prepareStore(input)).close();
  const progress=[];const cached=await prepareStore({...input,id:'renamed-id',onProgress:p=>progress.push(p)});assert.equal(cached.meta.id,'renamed-id');cached.close();assert.equal(progress.length,1);assert.equal(progress[0].cached,true);
  const changed=fixture();changed.summary.bytes=999;fs.writeFileSync(input.jsonPath,JSON.stringify(changed));
  const updated=await prepareStore(input);assert.equal(updated.meta.summary.bytes,999);updated.close();
  const reopened=openStore(input.dbPath,'different-id');assert.equal(reopened.meta.id,'different-id');reopened.close();
});
test('simultaneous imports can reuse the same atomically published cache',async t=>{
  const input=files(t);fs.writeFileSync(input.jsonPath,JSON.stringify(fixture()));
  const results=await Promise.all([prepareStore(input),prepareStore(input)]);
  for(const result of results){input.track(result);assert.equal(result.meta.nodeCount,7);assert.equal(result.getNode(3).name,'PV_日本語.mov');}
  assert.deepEqual(fs.readdirSync(input.dir).sort(),['fixture.json','fixture.sqlite']);
});
test('malformed sources cannot overwrite a valid cache or leave temporary databases',async t=>{
  const input=files(t);fs.writeFileSync(input.jsonPath,JSON.stringify(fixture()));(await prepareStore(input)).close();
  fs.writeFileSync(input.jsonPath,'{"nodes":[{"id":');await assert.rejects(prepareStore(input));
  const prior=openStore(input.dbPath);assert.equal(prior.meta.nodeCount,7);prior.close();
  assert.deepEqual(fs.readdirSync(input.dir).sort(),['fixture.json','fixture.sqlite']);
});
test('cancellation retains the source and removes only this incomplete cache',async t=>{
  const input=files(t);fs.writeFileSync(input.jsonPath,JSON.stringify(fixture()));fs.writeFileSync(path.join(input.dir,'unrelated.tmp'),'keep');
  const before=new AbortController();before.abort();await assert.rejects(prepareStore({...input,signal:before.signal}),{name:'AbortError'});
  const controller=new AbortController();await assert.rejects(prepareStore({...input,signal:controller.signal,onProgress:p=>{if(p.stage==='indexing')controller.abort();}}),{name:'AbortError'});
  assert.ok(fs.existsSync(input.jsonPath));assert.equal(fs.readFileSync(path.join(input.dir,'unrelated.tmp'),'utf8'),'keep');assert.ok(!fs.existsSync(input.dbPath));
  assert.equal(fs.readdirSync(input.dir).filter(n=>n.endsWith('.tmp')).length,1);
});
test('bad parent relationships are rejected before publishing the cache',async t=>{
  const input=files(t),data=fixture();data.nodes[3].parent=999;fs.writeFileSync(input.jsonPath,JSON.stringify(data));await assert.rejects(prepareStore(input),/目录关系/);assert.ok(!fs.existsSync(input.dbPath));
});
test('streaming import crosses the V8 maximum string length with bounded records', {skip:process.env.SPACELENS_LARGE_STORE_TEST!=='1',timeout:240000},async t=>{
  const input=files(t),output=fs.createWriteStream(input.jsonPath),padding='x'.repeat(420);
  const count=1050000;
  async function write(text){if(!output.write(text))await once(output,'drain');}
  await write('{"schemaVersion":1,"rootPath":"C:\\\\","status":"complete","summary":{"bytes":1050000,"files":1050000},"nodes":[{"id":0,"parent":null,"name":"C:","kind":"directory","bytes":1050000}');
  let chunk='';for(let i=1;i<=count;i++){chunk+=','+JSON.stringify({id:i,parent:0,name:`file-${i}-${padding}.dat`,kind:'file',bytes:1,category:'other',modified:'2020-01-01T00:00:00Z'});if(i%1000===0){await write(chunk);chunk='';}}
  if(chunk)await write(chunk);await write(']}');output.end();await once(output,'close');
  const size=fs.statSync(input.jsonPath).size;assert.ok(size>bufferConstants.MAX_STRING_LENGTH,`${size} exceeds ${bufferConstants.MAX_STRING_LENGTH}`);
  const start=Date.now();const store=input.track(await prepareStore(input));
  assert.equal(store.meta.nodeCount,count+1);assert.equal(store.getTop({limit:3}).total,count);assert.equal(store.getChildren({id:0,limit:2}).filteredBytes,count);
  t.diagnostic(`Imported ${size} bytes / ${count+1} nodes in ${Date.now()-start} ms; queries return bounded pages.`);
});
