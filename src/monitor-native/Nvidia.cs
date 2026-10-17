using System.Runtime.InteropServices;
using System.Text;

internal sealed class Nvidia:IDisposable
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int Init();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int Count(out uint count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int Handle(uint i,out nint handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int Text(nint h,StringBuilder text,uint size);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int UInt(nint h,out uint v);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int Temp(nint h,uint sensor,out uint v);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int Capability(nint h,out int major,out int minor);
    [StructLayout(LayoutKind.Sequential)]struct Memory{public ulong Total,Free,Used;}
    [StructLayout(LayoutKind.Sequential)]struct Util{public uint Gpu,Memory;}
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int Mem(nint h,out Memory m);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]delegate int Use(nint h,out Util u);
    nint library;bool ready;T? Fn<T>(string name)where T:Delegate=>library!=0&&NativeLibrary.TryGetExport(library,name,out var p)?Marshal.GetDelegateForFunctionPointer<T>(p):null;
    public Nvidia(){foreach(var file in new[]{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"nvml.dll"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"NVIDIA Corporation","NVSMI","nvml.dll")})if(NativeLibrary.TryLoad(file,out library))break;ready=Fn<Init>("nvmlInit_v2")?.Invoke()==0;}
    public object[] Read(){var rows=new List<object>();if(!ready||Fn<Count>("nvmlDeviceGetCount_v2") is not {} count||count(out var n)!=0)return [];for(uint i=0;i<Math.Min(n,16);i++){if(Fn<Handle>("nvmlDeviceGetHandleByIndex_v2")?.Invoke(i,out var h)!=0)continue;var name=new StringBuilder(128);Fn<Text>("nvmlDeviceGetName")?.Invoke(h,name,128);Memory m=default;Util u=default;bool memory=Fn<Mem>("nvmlDeviceGetMemoryInfo")?.Invoke(h,out m)==0,util=Fn<Use>("nvmlDeviceGetUtilizationRates")?.Invoke(h,out u)==0;uint temp=0,power=0,limit=0;int major=0,minor=0;bool t=Fn<Temp>("nvmlDeviceGetTemperature")?.Invoke(h,0,out temp)==0,p=Fn<UInt>("nvmlDeviceGetPowerUsage")?.Invoke(h,out power)==0,l=Fn<UInt>("nvmlDeviceGetEnforcedPowerLimit")?.Invoke(h,out limit)==0,c=Fn<Capability>("nvmlDeviceGetCudaComputeCapability")?.Invoke(h,out major,out minor)==0;rows.Add(new{index=i,name=name.ToString(),totalBytes=memory?(ulong?)m.Total:null,freeBytes=memory?(ulong?)m.Free:null,usedBytes=memory?(ulong?)m.Used:null,utilization=util?(uint?)u.Gpu:null,temperature=t?(uint?)temp:null,powerWatts=p?(double?)power/1000:null,powerLimitWatts=l?(double?)limit/1000:null,computeCapability=c?$"{major}.{minor}":null});}return rows.ToArray();}
    public void Dispose(){if(ready)Fn<Init>("nvmlShutdown")?.Invoke();if(library!=0)NativeLibrary.Free(library);library=0;}
}
