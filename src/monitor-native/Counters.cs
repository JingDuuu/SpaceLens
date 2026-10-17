using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

internal sealed class Counters:IDisposable
{
    [DllImport("pdh.dll",CharSet=CharSet.Unicode)]static extern uint PdhOpenQuery(string? source,nuint user,out nint query);
    [DllImport("pdh.dll",CharSet=CharSet.Unicode)]static extern uint PdhAddEnglishCounter(nint query,string path,nuint user,out nint counter);
    [DllImport("pdh.dll")]static extern uint PdhCollectQueryData(nint query);
    [DllImport("pdh.dll",CharSet=CharSet.Unicode)]static extern uint PdhGetFormattedCounterArray(nint counter,uint format,ref uint size,ref uint count,nint buffer);
    [DllImport("pdh.dll")]static extern uint PdhCloseQuery(nint query);
    [StructLayout(LayoutKind.Sequential)]struct Value{public uint Status;public double Number;}
    [StructLayout(LayoutKind.Sequential)]struct Item{public nint Name;public Value Value;}
    readonly Dictionary<string,nint> handles=new();nint query;public Dictionary<string,string> Status=new();
    public Counters(){if(PdhOpenQuery(null,0,out query)!=0)return;foreach(var (key,p)in new[]{("gpu",@"\GPU Engine(*)\Utilization Percentage"),("vram",@"\GPU Process Memory(*)\Dedicated Usage"),("adapter",@"\GPU Adapter Memory(*)\Dedicated Usage"),("shared",@"\GPU Adapter Memory(*)\Shared Usage"),("diskRead",@"\PhysicalDisk(*)\Disk Read Bytes/sec"),("diskWrite",@"\PhysicalDisk(*)\Disk Write Bytes/sec"),("diskIdle",@"\PhysicalDisk(*)\% Idle Time")})if(PdhAddEnglishCounter(query,p,0,out var handle)==0)handles[key]=handle;PdhCollectQueryData(query);}
    public Dictionary<string,Dictionary<string,double>> Read(){var all=new Dictionary<string,Dictionary<string,double>>();if(query==0)return all;Status["collect"]=PdhCollectQueryData(query).ToString("x");foreach(var (key,h)in handles){var result=new Dictionary<string,double>();uint size=0,count=0;Status[key]=PdhGetFormattedCounterArray(h,0x200|0x8000,ref size,ref count,0).ToString("x")+" / "+size;if(size>0&&size<32*1024*1024){var buffer=Marshal.AllocHGlobal((int)size);try{uint code=PdhGetFormattedCounterArray(h,0x200|0x8000,ref size,ref count,buffer);Status[key]+=" then "+code.ToString("x")+" count "+count;if(code==0){var stride=Marshal.SizeOf<Item>();for(int i=0;i<count;i++){var v=Marshal.PtrToStructure<Item>(buffer+i*stride);if(v.Value.Status<=1&&double.IsFinite(v.Value.Number))result[Marshal.PtrToStringUni(v.Name)??""]=Math.Max(0,v.Value.Number);}}}finally{Marshal.FreeHGlobal(buffer);}}all[key]=result;}return all;}
    public void Dispose(){if(query!=0)PdhCloseQuery(query);query=0;}
    public static int Pid(string s){var m=Regex.Match(s,@"pid_(\d+)_");return m.Success?int.Parse(m.Groups[1].Value):0;}
    public static string Luid(string s){var m=Regex.Match(s,@"luid_(0x[0-9a-f]+_0x[0-9a-f]+)",RegexOptions.IgnoreCase);return m.Value.ToLowerInvariant();}
    public static string Engine(string s)=>Regex.Replace(s,@"^pid_\d+_","");
}
