'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {noLinks,within}=require('./cleanup.cjs');
const protectedRoots=()=>[process.env.SystemRoot||'C:\\Windows',process.env.ProgramFiles||'C:\\Program Files',process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)',process.env.ProgramData||'C:\\ProgramData',process.env.LOCALAPPDATA,process.env.APPDATA].filter(Boolean).map(p=>path.resolve(p));
function protectedPath(file){const resolved=path.resolve(file);return protectedRoots().some(root=>resolved.toLowerCase()===root.toLowerCase()||within(resolved.toLowerCase(),root.toLowerCase()))||/(?:^|[\\/])(?:\$Recycle\.Bin|System Volume Information)(?:[\\/]|$)/i.test(resolved);}
function identity(st){return {size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs,ino:st.ino,dev:st.dev};}
class ReviewedFiles{
 constructor(){this.plans=new Map();this.busy=false;}
 async prepare(paths){if(!Array.isArray(paths)||!paths.length||paths.length>100)throw Error('请选择 1–100 个文件');const files=[];for(const file of [...new Set(paths)]){if(typeof file!=='string'||!path.isAbsolute(file)||protectedPath(file))throw Error('系统和应用数据目录不参与大文件清理');const st=await noLinks(file);if(!st.isFile()||st.nlink>1)throw Error('只支持普通文件；目录与链接不会删除');files.push({path:file,...identity(st)});}const plan={id:crypto.randomUUID(),created:Date.now(),files};this.plans.clear();this.plans.set(plan.id,plan);return {id:plan.id,files:files.map(f=>({path:f.path,bytes:f.size})),bytes:files.reduce((s,f)=>s+f.size,0)};}
 async apply(id,trash,onProgress=()=>{}){if(this.busy)throw Error('正在处理上一批文件');const plan=this.plans.get(id);if(!plan||Date.now()-plan.created>5*60000)throw Error('选择已过期，请重新选择');this.plans.delete(id);this.busy=true;const report={removed:0,bytes:0,skipped:0,issues:[]};try{for(const file of plan.files){try{if(protectedPath(file.path))throw Error('保护目录');const st=await noLinks(file.path);if(!st.isFile()||st.nlink>1||Object.entries(identity(st)).some(([key,v])=>v!==file[key]))throw Error('文件已变化，请重新检查');await trash(file.path);report.removed++;report.bytes+=file.size;}catch(e){report.skipped++;report.issues.push({path:file.path,message:e.message});}onProgress({done:report.removed+report.skipped,total:plan.files.length});}return report;}finally{this.busy=false;}}
}
module.exports={ReviewedFiles,protectedPath};
