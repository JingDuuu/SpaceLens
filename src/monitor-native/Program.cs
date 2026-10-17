using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

internal sealed class Monitor:IDisposable
{
    readonly Counters counters=new();readonly Nvidia nvidia=new();readonly NetworkTrace network=new();readonly Controls controls=new();
    readonly List<Native.AdapterDesc> adapters=Native.Adapters();readonly Dictionary<int,(long created,double cpu,ulong read,ulong write)> previous=new();
    readonly Dictionary<string,(ulong down,ulong up)> previousNics=new();readonly Dictionary<int,(long created,string path)> paths=new();
    ulong oldIdle,oldKernel,oldUser;long last=Stopwatch.GetTimestamp();bool first=true;public int IntervalMs=1000;
    public object Hardware()=>new{elevated=Microsoft.Diagnostics.Tracing.Session.TraceEventSession.IsElevated()==true,cpu=Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0","ProcessorNameString",null)?.ToString()?.Trim(),logicalProcessors=Environment.ProcessorCount,os=Environment.OSVersion.VersionString,avx2=System.Runtime.Intrinsics.X86.Avx2.IsSupported,gpus=adapters.Select(d=>new{name=d.Name,totalBytes=(ulong)d.Dedicated,sharedLimitBytes=(ulong)d.Shared,luid=$"luid_0x{d.High:x8}_0x{d.Low:x8}",vendor=d.Vendor}).ToArray()};
    public object Sample(){var start=Stopwatch.GetTimestamp();double seconds=Math.Max(.05,Stopwatch.GetElapsedTime(last,start).TotalSeconds);last=start;
        Native.GetSystemTimes(out var idle,out var kernel,out var user);ulong total=(kernel.Value-oldKernel)+(user.Value-oldUser);double? cpu=first?null:total==0?0:Math.Clamp((1-(double)(idle.Value-oldIdle)/total)*100,0,100);oldIdle=idle.Value;oldKernel=kernel.Value;oldUser=user.Value;
        var memory=new Native.Memory();if(!Native.GlobalMemoryStatusEx(memory))throw new Exception("内存状态读取失败");var pdh=counters.Read();Dictionary<string,double> Values(string key)=>pdh.GetValueOrDefault(key)??new();
        var engines=Values("gpu");var gpuByPid=engines.GroupBy(p=>Counters.Pid(p.Key)).ToDictionary(g=>g.Key,g=>Math.Min(100,g.GroupBy(p=>Counters.Engine(p.Key)).Select(e=>e.Sum(p=>p.Value)).DefaultIfEmpty().Max()));
        var vramByPid=Values("vram").GroupBy(p=>Counters.Pid(p.Key)).ToDictionary(g=>g.Key,g=>g.Sum(p=>p.Value));
        var parents=Native.Parents();var protectedPids=Native.Ancestors();var processes=new List<object>();var alive=new HashSet<int>();
        foreach(var p in Process.GetProcesses()){using(p){try{int pid=p.Id;alive.Add(pid);using var handle=Native.OpenProcess(0x1000,false,pid);if(handle.IsInvalid||!Native.GetProcessTimes(handle.DangerousGetHandle(),out var birth,out _,out var pk,out var pu))continue;long created=DateTime.FromFileTimeUtc((long)birth.Value).Ticks;double time=(pk.Value+pu.Value)/10000000d;ulong read=0,write=0;if(Native.GetProcessIoCounters(handle.DangerousGetHandle(),out var io)){read=io.ReadBytes;write=io.WriteBytes;}
            previous.TryGetValue(pid,out var before);bool valid=before.created==created;double? pcpu=valid?Math.Clamp((time-before.cpu)/seconds/Environment.ProcessorCount*100,0,100):null;double? pr=valid&&read>=before.read?(read-before.read)/seconds:null,pw=valid&&write>=before.write?(write-before.write)/seconds:null;previous[pid]=(created,time,read,write);
            if(!paths.TryGetValue(pid,out var cached)||cached.created!=created)paths[pid]=(created,Native.ImagePath(handle.DangerousGetHandle()));string exe=paths[pid].path;
            bool paused=controls.IsPaused(pid,created);processes.Add(new{pid,parentPid=parents.GetValueOrDefault(pid),created=created.ToString(),name=p.ProcessName,path=exe,cpu=pcpu,memoryBytes=p.WorkingSet64,privateBytes=p.PrivateMemorySize64,priorityChanged=controls.PriorityChanged(pid,created),ioReadBps=pr,ioWriteBps=pw,gpu=engines.Count>0?gpuByPid.GetValueOrDefault(pid):(double?)null,vramBytes=vramByPid.GetValueOrDefault(pid),paused,priority=Native.GetPriorityClass(handle.DangerousGetHandle())==0x4000?"BelowNormal":"NormalOrOther",canControl=pid>4&&exe.Length>0&&!exe.StartsWith(Environment.GetFolderPath(Environment.SpecialFolder.Windows)+"\\",StringComparison.OrdinalIgnoreCase)&&!protectedPids.Contains(pid)&&!new[]{"SpaceLens.exe","SpaceLens.Monitor.exe"}.Contains(Path.GetFileName(exe),StringComparer.OrdinalIgnoreCase)});
        }catch{/* Protected/exited processes cannot provide all metrics. */}}}
        foreach(int pid in previous.Keys.Where(p=>!alive.Contains(p)).ToArray()){previous.Remove(pid);paths.Remove(pid);}
        var nics=new List<object>();foreach(var nic in NetworkInterface.GetAllNetworkInterfaces()){try{if(nic.OperationalStatus!=OperationalStatus.Up||nic.NetworkInterfaceType==NetworkInterfaceType.Loopback)continue;var row=new Native.InterfaceRow{Guid=Guid.Parse(nic.Id)};if(Native.GetIfEntry2(ref row)!=0){var ip=nic.GetIPProperties().GetIPv4Properties();if(ip==null)continue;row=new Native.InterfaceRow{Index=(uint)ip.Index};if(Native.GetIfEntry2(ref row)!=0)continue;}
            if((row.Flags&2)!=0||row.Type==24||row.ReceiveSpeed==0&&row.TransmitSpeed==0)continue;previousNics.TryGetValue(nic.Id,out var before);double? down=!first&&row.InOctets>=before.down&&previousNics.ContainsKey(nic.Id)?(row.InOctets-before.down)/seconds:null,up=!first&&row.OutOctets>=before.up&&previousNics.ContainsKey(nic.Id)?(row.OutOctets-before.up)/seconds:null;previousNics[nic.Id]=(row.InOctets,row.OutOctets);nics.Add(new{id=nic.Id,name=nic.Name,description=nic.Description,hardware=(row.Flags&1)!=0,downloadBps=down,uploadBps=up,linkDownBps=row.ReceiveSpeed/8d,linkUpBps=row.TransmitSpeed/8d});
        }catch{}}
        var gpu=adapters.Select(d=>{string luid=$"luid_0x{d.High:x8}_0x{d.Low:x8}";var groups=engines.Where(p=>Counters.Luid(p.Key)==luid).GroupBy(p=>Counters.Engine(p.Key)).Select(g=>new{name=g.Key[(g.Key.IndexOf("engtype_")+8)..],use=Math.Min(100,g.Sum(p=>p.Value))}).ToArray();return new{name=d.Name,luid,totalBytes=(ulong)d.Dedicated,usedBytes=Values("adapter").Where(p=>Counters.Luid(p.Key)==luid).Sum(p=>p.Value),sharedBytes=Values("shared").Where(p=>Counters.Luid(p.Key)==luid).Sum(p=>p.Value),utilization=groups.Length>0?groups.Max(e=>e.use):(double?)null,engines=groups.OrderByDescending(e=>e.use).Take(12).ToArray()};}).ToArray();
        double? Disk(string key)=>Values(key).TryGetValue("_Total",out var value)?value:null;var diskBusy=Values("diskIdle").Where(p=>p.Key!="_Total").Select(p=>100-Math.Min(100,p.Value)).ToArray();
        first=false;return new{timestamp=DateTime.UtcNow.ToString("O"),intervalMs=seconds*1000,cpu,memory=new{totalBytes=memory.Total,availableBytes=memory.Available,usedBytes=memory.Total-memory.Available,percent=memory.Load},disk=new{readBps=Disk("diskRead"),writeBps=Disk("diskWrite"),busy=diskBusy.Length>0?diskBusy.Max():(double?)null},gpus=gpu,nvidia=nvidia.Read(),interfaces=nics,processes,processCount=alive.Count,unreadableProcesses=alive.Count-processes.Count,network=network.State(),counterStatus=counters.Status,sampleMs=Stopwatch.GetElapsedTime(start).TotalMilliseconds};
    }
    public object Request(JsonElement q)=>q.GetProperty("method").GetString() switch{"hardware"=>Hardware(),"interval"=>SetInterval(q.GetProperty("milliseconds").GetInt32()),"network-enable"=>network.Enable(),"network-disable"=>StopNetwork(),"control"=>controls.Act(q.GetProperty("action").GetString()!,q.GetProperty("pid").GetInt32(),long.Parse(q.GetProperty("created").GetString()!)),_=>throw new Exception("未知请求")};
    object SetInterval(int ms){IntervalMs=Math.Clamp(ms,1000,5000);return new{intervalMs=IntervalMs};}
    object StopNetwork(){network.Dispose();return new{ok=true};}
    public void Dispose(){controls.Dispose();network.Dispose();counters.Dispose();nvidia.Dispose();}
}
internal static class Program
{
    static readonly object output=new();static void Write(object o){lock(output){Console.WriteLine(JsonSerializer.Serialize(o));Console.Out.Flush();}}
    static async Task Main(string[] args){Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        if(args.FirstOrDefault()=="--network"){await NetworkTrace.Capture(args[1]);return;}
        if(args.FirstOrDefault()=="--pause"){try{await Controls.Pause(int.Parse(args[1]),long.Parse(args[2]));}catch(Exception e){Console.WriteLine(e.Message);}return;}
        using var monitor=new Monitor();using var done=new CancellationTokenSource();var gate=new SemaphoreSlim(1);
        var sampling=Task.Run(async()=>{while(!done.IsCancellationRequested){var before=Stopwatch.GetTimestamp();await gate.WaitAsync();try{Write(new{type="sample",data=monitor.Sample()});}catch(Exception e){Write(new{type="error",error=e.Message});}finally{gate.Release();}try{await Task.Delay(Math.Max(100,monitor.IntervalMs-(int)Stopwatch.GetElapsedTime(before).TotalMilliseconds),done.Token);}catch{break;}}});
        try{string? line;while((line=await Console.In.ReadLineAsync())!=null){if(line.Length>32768)continue;int id=0;await gate.WaitAsync();try{using var q=JsonDocument.Parse(line);id=q.RootElement.GetProperty("id").GetInt32();Write(new{id,result=monitor.Request(q.RootElement)});}catch(Exception e){Write(new{id,error=e.Message});}finally{gate.Release();}}}finally{done.Cancel();await sampling;}
    }
}
