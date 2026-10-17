'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('spaceLens',Object.freeze({invoke:(method,args)=>ipcRenderer.invoke('spacelens:invoke',method,args),onProgress:callback=>{const handler=(_event,p)=>callback(p);ipcRenderer.on('spacelens:progress',handler);return ()=>ipcRenderer.removeListener('spacelens:progress',handler);},onResources:callback=>{const handler=(_event,p)=>callback(p);ipcRenderer.on('spacelens:resources',handler);return ()=>ipcRenderer.removeListener('spacelens:resources',handler);}}));
