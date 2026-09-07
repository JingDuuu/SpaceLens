'use strict';
// Tests the distributable with synthetic data only. Never cleans user data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {_electron}=require(process.env.SPACELENS_PLAYWRIGHT||'playwright-core');
const project=path.resolve(__dirname,'..'),root=path.resolve(process.env.SPACELENS_TEST_RELEASE||path.join(project,'dist','SpaceLens'));
const snapshots=path.join(root,'data','snapshots');fs.mkdirSync(snapshots,{recursive:true});
const demo={schemaVersion:1,id:'demo',rootPath:'D:\\SpaceLens Demo',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),status:'complete',summary:{bytes:120e9,files:6,dirs:4,elapsedMs:950,errors:0,skipped:0},nodes:[
 {id:0,parent:null,name:'SpaceLens Demo',kind:'directory',category:'folder',bytes:120e9,files:6,dirs:4},
 {id:1,parent:0,name:'Film Projects',kind:'directory',category:'folder',bytes:80e9,files:3,dirs:2},
 {id:2,parent:0,name:'Creative Tools',kind:'directory',category:'folder',bytes:30e9,files:2,dirs:0},
 {id:3,parent:0,name:'Archive',kind:'directory',category:'folder',bytes:10e9,files:1,dirs:0},
 {id:4,parent:1,name:'Footage',kind:'directory',category:'folder',bytes:52e9,files:1,dirs:0},
 {id:5,parent:1,name:'Renders',kind:'directory',category:'folder',bytes:20e9,files:1,dirs:0},
 {id:6,parent:1,name:'Storyboard.psd',kind:'file',category:'image',bytes:8e9,files:1,dirs:0},
 {id:7,parent:2,name:'Editor Cache',kind:'file',category:'application',bytes:25e9,files:1,dirs:0},
 {id:8,parent:2,name:'Texture Library',kind:'file',category:'archive',bytes:5e9,files:1,dirs:0},
 {id:9,parent:3,name:'Archive.zip',kind:'file',category:'archive',bytes:10e9,files:1,dirs:0},
 {id:10,parent:4,name:'Scene.mov',kind:'file',category:'video',bytes:52e9,files:1,dirs:0},
 {id:11,parent:5,name:'Render.mov',kind:'file',category:'video',bytes:20e9,files:1,dirs:0}
],errors:[]};
fs.writeFileSync(path.join(snapshots,'demo.json'),JSON.stringify(demo));fs.writeFileSync(path.join(root,'data','active.json'),JSON.stringify({id:'demo'}));
const scratch=path.join(root,'data','test-fixture','Temp');fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(path.join(scratch,'disposable.tmp'),'test only');
let electron,page;const report={checks:[],errors:[]};
(async()=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 electron=await _electron.launch({executablePath:path.join(root,'SpaceLens.exe'),env,timeout:30000});page=await electron.firstWindow();page.on('pageerror',e=>report.errors.push(e.message));
 await page.waitForFunction(()=>document.querySelector('#summary-files')?.textContent==='6');
 await page.locator('#treemap').click({position:{x:80,y:60}});
 await page.waitForFunction(()=>document.querySelector('#treemap').dataset.previewId==='1'&&document.querySelector('#treemap').dataset.previewCount==='3');
 assert.equal(await page.locator('#detail-name').innerText(),'Film Projects');
 assert.ok(!(await page.locator('#breadcrumbs').innerText()).includes('Film Projects'));
 await page.mouse.move(10,10);await page.waitForTimeout(180);fs.mkdirSync(path.join(project,'assets','demo'),{recursive:true});
 await page.screenshot({path:path.join(project,'assets','demo','folder-preview.png')});
 await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('#treemap').dataset.previewId==='2');
 await page.keyboard.press('Home');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#breadcrumbs').textContent.includes('Film Projects'));await page.locator('#up-button').click();
 report.checks.push('Mouse single-click selection previews one layer without navigation; quick reselection and enter/up');
 await electron.evaluate(({shell},args)=>{
   const {SpaceService}=process.mainModule.require(args.service);const {CleanupEngine}=process.mainModule.require(args.cleanup);
   Object.defineProperty(SpaceService.prototype,'cleaner',{configurable:true,get(){if(!this.cleanupEngine)this.cleanupEngine=new CleanupEngine({roots:[{id:'temp',label:'Disposable test files',path:args.scratch}],now:()=>Date.now()+30*86400000,onProgress:p=>this.emit('progress',p)});return this.cleanupEngine;}});
   SpaceService.prototype.usage=async()=>({apps:[{name:'Demo Video Editor',publisher:'Example Studio',version:'1.0',installLocation:'D:\\Tools\\Demo',lastRun:new Date(Date.now()-200*86400000).toISOString(),estimatedBytes:9e9,source:'UserAssist',confidence:'observed'},{name:'Unknown Demo App',estimatedBytes:2e9,lastRun:null,source:'Unavailable'}]});
   globalThis.testExternal=[];shell.openExternal=async url=>{globalThis.testExternal.push(url);};
 },{service:path.join(root,'src','service.cjs'),cleanup:path.join(root,'src','cleanup.cjs'),scratch});
 await page.locator('#cleanup-launch').click();await page.locator('#cleanup-scan').click();
 await page.waitForFunction(()=>document.querySelector('#cleanup-status').textContent.includes('检查完成'));
 await page.locator('#cleanup-groups input[type=checkbox]').check();assert.equal(await page.locator('#cleanup-apply').isEnabled(),true);
 await page.getByRole('button',{name:'查看文件',exact:true}).click();assert.match(await page.locator('#cleanup-details').innerText(),/disposable.tmp/);
 await electron.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0});});await page.locator('#cleanup-apply').click();await page.waitForFunction(()=>document.querySelector('#cleanup-status').textContent.includes('已取消'));assert.ok(fs.existsSync(path.join(scratch,'disposable.tmp')));
 await electron.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});await page.locator('#cleanup-apply').click();await page.waitForFunction(()=>document.querySelector('#cleanup-status').textContent.includes('已删除 1'));assert.equal(fs.existsSync(path.join(scratch,'disposable.tmp')),false);
 report.checks.push('Reviewed cleanup native confirmation boundary: Cancel preserves fixture; Confirm removes only disposable fixture');
 await page.locator('#cleanup-tab-apps').click();await page.waitForFunction(()=>document.querySelector('#cleanup-app-list').textContent.includes('Demo Video Editor'));assert.ok(!(await page.locator('#cleanup-app-list').innerText()).includes('Unknown Demo App'));
 await page.locator('#cleanup-unknown').check();assert.match(await page.locator('#cleanup-app-list').innerText(),/Unknown Demo App/);
 await page.locator('#cleanup-app-list .cleanup-app').filter({hasText:'Demo Video Editor'}).getByRole('button').click();await page.waitForFunction(()=>document.querySelector('#cleanup-status').textContent.includes('名称已复制'));
 const native=await electron.evaluate(async({clipboard})=>({urls:globalThis.testExternal,copied:await clipboard.readText()}));assert.equal(native.urls[0],'ms-settings:appsfeatures');assert.equal(native.copied,'Demo Video Editor');
 report.checks.push('App estimates, age/unknown separation, exact copied name and fixed Windows uninstall URI');
 await page.screenshot({path:path.join(project,'assets','demo','app-cleanup.png')});
 await page.locator('#cleanup-close').click();await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,740));await page.waitForFunction(()=>innerWidth<1100);await page.locator('#cleanup-launch').click();
 const overflow=await page.evaluate(()=>{const d=document.querySelector('#cleanup-dialog');return d.scrollWidth>d.clientWidth;});assert.equal(overflow,false);report.checks.push('Cleanup center fits narrow desktop window');assert.deepEqual(report.errors,[]);report.passed=true;
})().catch(e=>{report.error=e.stack;process.exitCode=1;console.error(e.stack);}).finally(async()=>{if(page&&!report.passed)await page.screenshot({path:path.join(project,'tests','product-failure.png')}).catch(()=>{});if(electron)await electron.close();fs.writeFileSync(path.join(project,'tests','product-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));});


