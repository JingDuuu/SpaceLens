using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Session;

internal sealed class NetworkTrace:IDisposable
{
    readonly object gate=new();NamedPipeServerStream? pipe;int generation;string mode="disabled",error="";JsonElement? sample;DateTime last;
    public object State(){lock(gate)return new{mode,error,lastUpdate=last==default?(string?)null:last.ToString("O"),sample,stale=mode=="live"&&(DateTime.UtcNow-last).TotalSeconds>4};}
    public object Enable(){int current;NamedPipeServerStream local;string name="SpaceLens-Net-"+Guid.NewGuid().ToString("N");lock(gate){if(mode is "live" or "starting")return new{mode};pipe?.Dispose();local=new NamedPipeServerStream(name,PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);pipe=local;current=++generation;mode="starting";error="";sample=null;last=default;} _=Task.Run(async()=>{try{
        lock(gate){if(current!=generation)return;}
        using var child=Process.Start(new ProcessStartInfo{FileName=Environment.ProcessPath!,Arguments="--network "+name,UseShellExecute=true,Verb=TraceEventSession.IsElevated()==true?"":"runas",WindowStyle=ProcessWindowStyle.Hidden});
        using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(90));await local.WaitForConnectionAsync(timeout.Token);using var reader=new StreamReader(local);
        while(await reader.ReadLineAsync() is {} line){if(line.Length>2_000_000)throw new Exception("流量采集响应过大");using var doc=JsonDocument.Parse(line);lock(gate){if(current!=generation)return;if(doc.RootElement.TryGetProperty("error",out var err)){mode="error";error=err.GetString()??"采集失败";}else{sample=doc.RootElement.Clone();mode="live";last=DateTime.UtcNow;}}}
        lock(gate){if(current==generation&&mode=="live"){mode="error";error="应用流量采集已断开，请重新启用";}}
    }catch(Exception e){lock(gate){if(current==generation&&mode!="disabled"){mode="error";error=e is System.ComponentModel.Win32Exception w&&w.NativeErrorCode==1223?"已取消权限确认；仍可查看网卡总速度。":e.Message;}}}finally{local.Dispose();lock(gate){if(current==generation)pipe=null;}}});return new{mode="starting"};}
    public void Dispose(){lock(gate){generation++;mode="disabled";sample=null;error="";last=default;pipe?.Dispose();pipe=null;}}

    sealed class Flow{public int Pid;public string Address="",Protocol="";public bool Loopback;public long Received,Sent;}
    public static async Task Capture(string name)
    {
        if(!System.Text.RegularExpressions.Regex.IsMatch(name,"^SpaceLens-Net-[a-f0-9]{32}$"))return;
        using var pipe=new NamedPipeClientStream(".",name,PipeDirection.Out,PipeOptions.Asynchronous);try{await pipe.ConnectAsync(15000);}catch{return;}using var writer=new StreamWriter(pipe){AutoFlush=true};
        try{
            using var session=new TraceEventSession(name);session.StopOnDispose=true;session.BufferSizeMB=16;
            var gate=new object();var flows=new Dictionary<string,Flow>();var byPid=new Dictionary<int,(long down,long up)>();long omitted=0;
            void Add(int pid,int bytes,System.Net.IPAddress remote,int port,string protocol,bool receive){if(bytes<=0)return;lock(gate){byPid.TryGetValue(pid,out var totals);byPid[pid]=(totals.down+(receive?bytes:0),totals.up+(receive?0:bytes));string key=$"{pid}/{protocol}/{remote}/{port}";if(!flows.TryGetValue(key,out var f)){if(flows.Count>=4096){omitted++;return;}flows[key]=f=new Flow{Pid=pid,Address=remote+":"+port,Protocol=protocol,Loopback=System.Net.IPAddress.IsLoopback(remote)};}if(receive)f.Received+=bytes;else f.Sent+=bytes;}}
            // Enable the kernel provider before accessing Source (which creates a user session).
            session.EnableKernelProvider(KernelTraceEventParser.Keywords.NetworkTCPIP);
            var k=session.Source.Kernel;
            k.TcpIpSend+=d=>Add(d.ProcessID,d.size,d.daddr,d.dport,"TCP",false);k.TcpIpRecv+=d=>Add(d.ProcessID,d.size,d.saddr,d.sport,"TCP",true);
            k.TcpIpSendIPV6+=d=>Add(d.ProcessID,d.size,d.daddr,d.dport,"TCP6",false);k.TcpIpRecvIPV6+=d=>Add(d.ProcessID,d.size,d.saddr,d.sport,"TCP6",true);
            k.UdpIpSend+=d=>Add(d.ProcessID,d.size,d.daddr,d.dport,"UDP",false);k.UdpIpRecv+=d=>Add(d.ProcessID,d.size,d.saddr,d.sport,"UDP",true);
            k.UdpIpSendIPV6+=d=>Add(d.ProcessID,d.size,d.daddr,d.dport,"UDP6",false);k.UdpIpRecvIPV6+=d=>Add(d.ProcessID,d.size,d.saddr,d.sport,"UDP6",true);
            var processing=Task.Run(()=>session.Source.Process());var clock=Stopwatch.StartNew();double previous=0;
            while(!processing.IsCompleted){await Task.Delay(1000);double now=clock.Elapsed.TotalSeconds,seconds=now-previous;previous=now;object snapshot;lock(gate){snapshot=new{timestamp=DateTime.UtcNow.ToString("O"),intervalMs=seconds*1000,lostEvents=session.EventsLost,omittedFlows=omitted,processes=byPid.Select(p=>new{pid=p.Key,downloadBps=p.Value.down/seconds,uploadBps=p.Value.up/seconds}).ToArray(),flows=flows.Values.OrderByDescending(f=>f.Sent+f.Received).Take(512).Select(f=>new{pid=f.Pid,remote=f.Address,protocol=f.Protocol,loopback=f.Loopback,downloadBps=f.Received/seconds,uploadBps=f.Sent/seconds}).ToArray()};byPid.Clear();flows.Clear();omitted=0;}
                await writer.WriteLineAsync(JsonSerializer.Serialize(snapshot));}
            await processing;
        }catch(Exception e){try{await writer.WriteLineAsync(JsonSerializer.Serialize(new{error=e.Message}));}catch{}}
    }
}
