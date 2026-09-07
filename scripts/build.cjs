'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const runtimeArg=process.argv.indexOf('--runtime');
const runtime=runtimeArg>=0?path.resolve(process.argv[runtimeArg+1]):path.join(root,'node_modules','electron','dist');
const out=path.join(root,'dist','SpaceLens');
function run(exe,args){const result=spawnSync(exe,args,{cwd:root,stdio:'inherit',windowsHide:true});if(result.status!==0)throw new Error(`${exe} failed (${result.status})`);}
function copy(from,to){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}
function tree(from,to,filter=()=>true){for(const entry of fs.readdirSync(from,{withFileTypes:true})){if(!filter(entry.name))continue;const src=path.join(from,entry.name),dst=path.join(to,entry.name);if(entry.isDirectory())tree(src,dst,filter);else copy(src,dst);}}
if(process.platform!=='win32')throw new Error('Build on Windows x64.');
if(!fs.existsSync(runtime))run(process.execPath,[path.join(root,'node_modules','electron','install.js')]);
if(fs.existsSync(out))throw new Error('dist/SpaceLens already exists; move the previous build before creating another release.');
fs.mkdirSync(out,{recursive:true});
const names=['chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','ffmpeg.dll','icudtl.dat','LICENSES.chromium.html','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','version','vk_swiftshader_icd.json','vk_swiftshader.dll','vulkan-1.dll'];
for(const name of names)copy(path.join(runtime,name),path.join(out,name));
copy(path.join(runtime,fs.existsSync(path.join(runtime,'SpaceLens.exe'))?'SpaceLens.exe':'electron.exe'),path.join(out,'SpaceLens.exe'));
const editor=process.env.SPACELENS_RCEDIT||path.join(root,'node_modules','rcedit','bin','rcedit-x64.exe');
run(editor,[path.join(out,'SpaceLens.exe'),'--set-icon',path.join(root,'assets','spacelens.ico'),'--set-file-version',version,'--set-product-version',version,'--set-version-string','ProductName','SpaceLens','--set-version-string','FileDescription','SpaceLens disk explorer']);
tree(path.join(runtime,'locales'),path.join(out,'locales'));
tree(path.join(root,'src'),path.join(out,'src'),name=>!['bin','obj'].includes(name));
for(const name of ['spacelens.ico','spacelens.png'])copy(path.join(root,'assets',name),path.join(out,'assets',name));
for(const name of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json'])copy(path.join(root,name),path.join(out,name));
copy(path.join(root,'licenses','Electron-LICENSE.txt'),path.join(out,'licenses','Electron-LICENSE.txt'));
for(const name of ['DotNet-LICENSE.txt','DotNet-ThirdPartyNotices.txt'])copy(path.join(root,'licenses',name),path.join(out,'licenses',name));
copy(path.join(root,'docs','OPEN_SOURCE.md'),path.join(out,'docs','OPEN_SOURCE.md'));
if(fs.existsSync(path.join(root,'assets','demo')))tree(path.join(root,'assets','demo'),path.join(out,'assets','demo'));
fs.mkdirSync(path.join(out,'resources','app'),{recursive:true});
fs.writeFileSync(path.join(out,'resources','app','package.json'),JSON.stringify({name:'spacelens',version,main:'../../src/main.cjs'}));
fs.writeFileSync(path.join(out,'spacelens.cmd'),'@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "SPACELENS_HOME=%~dp0"\r\n"%~dp0SpaceLens.exe" "%~dp0src\\cli.cjs" %*\r\n');
fs.writeFileSync(path.join(out,'Start SpaceLens.cmd'),'@echo off\r\nstart "" "%~dp0SpaceLens.exe"\r\n');
run('dotnet',['publish',path.join(root,'src','scanner','SpaceLens.Scanner.csproj'),'-c','Release','-r','win-x64','--self-contained','true','-o',path.join(out,'runtime','scanner')]);
if(fs.existsSync(path.join(out,'data')))throw new Error('A release must not include local data.');
console.log('Portable build: '+out);
if(process.argv.includes('--zip')){
 const zip=path.join(root,'dist',`SpaceLens-${version}-Windows-x64.zip`);
 run('tar.exe',['-a','-c','-f',zip,'-C',path.join(root,'dist'),'SpaceLens']);
 const hash=crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');fs.writeFileSync(zip+'.sha256',`${hash}  ${path.basename(zip)}\n`);console.log('ZIP SHA-256: '+hash);
}
