'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,clipboard,Menu,nativeImage}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
process.env.SPACELENS_HOME=root;
const {SpaceService}=require('./service.cjs');
const data=path.join(root,'data');
fs.mkdirSync(data,{recursive:true});
app.setPath('userData',path.join(data,'desktop'));
app.setPath('sessionData',path.join(data,'desktop','session'));
app.setAppUserModelId('studio.spacelens.desktop');
const gotLock=app.requestSingleInstanceLock();
let win,service,quitting=false,searchStopped=false;
app.on('before-quit',event=>{quitting=true;if(service?.scanning){event.preventDefault();service.cancel();service.idlePromise.finally(()=>app.quit());}else if(service?.cleanupEngine?.busy){event.preventDefault();service.cleanupEngine.cancel();service.cleanupEngine.idlePromise.finally(()=>app.quit());}else if(service?.searcher&&!searchStopped){event.preventDefault();searchStopped=true;service.searcher.shutdown().finally(()=>app.quit());}else service?.close();});
if(!gotLock)app.quit();
else {
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(async()=>{
    service=new SpaceService(root);
    Menu.setApplicationMenu(null);
    win=new BrowserWindow({title:'SpaceLens · 空间透镜',width:1500,height:980,minWidth:960,minHeight:700,backgroundColor:'#10151c',icon:path.join(root,'assets','spacelens.ico'),show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',e=>e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    win.webContents.session.setPermissionCheckHandler(()=>false);
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_d,cb)=>cb({cancel:true}));
    service.on('progress',p=>{if(win&&!win.isDestroyed())win.webContents.send('spacelens:progress',p);});
    const allowed=new Set(['drives','state','scan','cancel','children','node','top','usage','history','load','compare','errors','cleanupScan','cleanupDetails','cleanupCancel','cleanupApps','initializeSpace','searchStatus','search']);
    ipcMain.handle('spacelens:invoke',async(event,method,args={})=>{
      if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('无效的请求来源');
      if(allowed.has(method))return service[method](args);
      if(method==='searchEnable')return service.searchEngine.installService();
      if(method==='searchRefresh')return service.searchEngine.refresh();
      if(['searchOpen','searchReveal','searchCopy','searchThumbnail'].includes(method)){
        const target=args.path;if(typeof target!=='string'||!path.isAbsolute(target)||target.includes('\0'))throw Error('无效文件路径');
        if(method==='searchCopy'){await clipboard.writeText(target);return {ok:true};}
        const stat=await fs.promises.lstat(target);
        if(method==='searchThumbnail'){
          if(stat.isSymbolicLink()||!stat.isFile()||stat.size>250*1024*1024||target.startsWith('\\\\'))return {data:null};
          // Shell previews stay off the input/search critical path. Do not hydrate cloud placeholders.
          const item=service.searchEngine.seen?.get(target.toLowerCase());if(!item||item.attributes&(0x1000|0x40000|0x400000))return {data:null};
          try{const bitmap=await nativeImage.createThumbnailFromPath(target,{width:440,height:300});return {data:bitmap.isEmpty()?null:bitmap.toDataURL()};}catch{return {data:null};}
        }
        if(method==='searchReveal'){if(stat.isDirectory()){const error=await shell.openPath(target);if(error)throw Error(error);}else shell.showItemInFolder(target);return {ok:true};}
        if(/\.(exe|com|bat|cmd|ps1|vbs|js|msi|lnk)$/i.test(target)){const answer=await dialog.showMessageBox(win,{type:'question',message:'运行这个程序或脚本？',detail:target,buttons:['取消','打开'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};}
        const error=await shell.openPath(target);if(error)throw Error(error);return {ok:true};
      }
      if(method==='cleanupApply'){
        const review=service.cleaner.review(args);
        if(!review.count)return {removed:0,bytes:0,skipped:0,issues:[]};
        const answer=await dialog.showMessageBox(win,{type:'warning',title:'确认清理这些临时文件',message:`永久删除 ${review.count.toLocaleString()} 个临时文件？`,detail:review.groups.map(g=>g.label+' — '+g.path).join('\n')+'\n\n约 '+(review.bytes/1000000).toFixed(1)+' MB 逻辑大小。只处理刚才预览中选中的文件，文件有变化或正在占用会跳过。此操作不进入回收站。',buttons:['取消','清理所选文件'],defaultId:0,cancelId:0,noLink:true});
        if(answer.response!==1)return {cancelled:true};return service.cleaner.apply(args);
      }
      if(method==='cleanupQuick'){
        const plan=await service.cleaner.scan();const groups=plan.groups.filter(g=>g.count).map(g=>g.id);
        if(!groups.length)return {removed:0,bytes:0,skipped:0,issues:[]};
        return service.cleaner.apply({planId:plan.id,groups});
      }
      if(method==='cleanupLarge'){
        const r=await service.search({query:'file: size:>=1gb',sort:'size',limit:80,offset:args.offset||0});
        return {...r,items:r.items.map(n=>({...n,protected:require('./reviewed-files.cjs').protectedPath(n.path)}))};
      }
      if(method==='cleanupTrash'){
        if(!service.remover)service.remover=new(require('./reviewed-files.cjs').ReviewedFiles)();
        const plan=await service.remover.prepare(args.paths);
        const answer=await dialog.showMessageBox(win,{type:'warning',message:`将所选 ${plan.files.length} 个文件移入回收站？`,detail:plan.files.map(f=>f.path).join('\n')+'\n\n可在回收站恢复。只有清空回收站后才会实际释放空间。',buttons:['取消','移入回收站'],defaultId:0,cancelId:0,noLink:true});
        if(answer.response!==1)return {cancelled:true};return service.remover.apply(plan.id,p=>shell.trashItem(p),p=>service.emit('progress',{type:'cleanup-progress',stage:'recycling',...p}));
      }
      if(method==='cleanupUninstall'){
        if(service.uninstalling)throw Error('请先完成正在进行的卸载');
        const result=await service.cleanupApps({olderDays:0,includeUnknown:true,refresh:true});const selected=result.items.find(a=>a.id===args.id);if(!selected?.uninstall)throw Error('没有可用卸载入口，请使用应用自身的卸载功能');
        const answer=await dialog.showMessageBox(win,{type:'warning',message:'卸载 '+selected.name+'？',detail:'将直接运行此应用的卸载程序。请根据卸载窗口选择是否保留个人设置；卸载可能需要 Windows 权限确认。',buttons:['取消','开始卸载'],defaultId:0,cancelId:0});if(answer.response!==1)return {cancelled:true};
        service.uninstalling=true;try{return await new Promise((resolve,reject)=>{const child=require('node:child_process').spawn(path.join(root,'runtime','search','SpaceLens.Search.exe'),['--uninstall'],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>{output=(output+b).slice(-64000);});child.stderr.resume();child.on('error',reject);child.on('close',()=>{try{const r=JSON.parse(output.trim().split(/\r?\n/).at(-1));r.error?reject(Error(r.error)):resolve(r);}catch{reject(Error('卸载程序已退出，请重新检查安装列表'));}});child.stdin.end(JSON.stringify(selected.uninstall)+'\n');});}finally{service.uninstalling=false;}
      }
      if(method==='openStorage'){await shell.openExternal('ms-settings:storagesense');return {ok:true};}
      if(method==='openUninstall'){
        const result=await service.cleanupApps({olderDays:0,includeUnknown:true,refresh:true});
        const selected=result.items.find(a=>a.id===args.id);if(!selected)throw new Error('应用记录已变化，请重新检查');
        await clipboard.writeText(selected.name);await shell.openExternal('ms-settings:appsfeatures');return {ok:true,name:selected.name,note:'名称已复制，在 Windows 已安装的应用中粘贴搜索并卸载。'};
      }
      if(method==='chooseFolder'){const result=await dialog.showOpenDialog(win,{title:'选择要查看的硬盘或文件夹',properties:['openDirectory','dontAddToRecent']});return result.canceled?null:result.filePaths[0];}
      if(method==='open'||method==='openPath'){
        const target=method==='open'?service.nodePath(args.id):args.path;
        if(typeof target!=='string'||!path.isAbsolute(target))throw new Error('不是有效的完整路径');
        const stat=await fs.promises.stat(target);
        if(stat.isDirectory()){const err=await shell.openPath(target);if(err)throw new Error(err);}else shell.showItemInFolder(target);
        return {ok:true,path:target};
      }
      if(method==='copy'){const p=service.nodePath(args.id);await clipboard.writeText(p);return {ok:true};}
      if(method==='export'){service.requireSnapshot();const result=await dialog.showSaveDialog(win,{title:'导出扫描快照',defaultPath:path.join(root,'SpaceLens-'+service.snapshot.id+'.json'),filters:[{name:'SpaceLens 扫描快照',extensions:['json']}],properties:['showOverwriteConfirmation','dontAddToRecent']});return result.canceled?null:service.exportTo(result.filePath);}
      throw new Error('不支持此操作');
    });
    win.on('ready-to-show',()=>win.show());
    win.on('close',event=>{if(service?.uninstalling||service?.remover?.busy){event.preventDefault();void dialog.showMessageBox(win,{type:'info',message:service.uninstalling?'应用正在卸载':'正在将文件移入回收站',detail:'操作完成后即可关闭 SpaceLens。',buttons:['继续等待']});}});
    win.on('closed',()=>{win=null;});
    await win.loadFile(path.join(__dirname,'ui','index.html'));

  }).catch(e=>{if(!quitting)dialog.showErrorBox('SpaceLens 启动失败',e.message+'\n请确认整个文件夹已完整解压且可写。');app.quit();});
  app.on('window-all-closed',()=>app.quit());
}
