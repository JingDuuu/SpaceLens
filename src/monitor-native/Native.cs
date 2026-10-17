using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct Times { public uint Low,High; public ulong Value=>((ulong)High<<32)|Low; }
    [DllImport("kernel32.dll")] internal static extern bool GetSystemTimes(out Times idle,out Times kernel,out Times user);
    [StructLayout(LayoutKind.Sequential)] internal class Memory { public uint Length=(uint)Marshal.SizeOf<Memory>(),Load; public ulong Total,Available,PageTotal,PageAvailable,VirtualTotal,VirtualAvailable,Extended; }
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GlobalMemoryStatusEx([In,Out] Memory memory);
    [StructLayout(LayoutKind.Sequential)] internal struct Io { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [DllImport("kernel32.dll")] internal static extern bool GetProcessIoCounters(nint process,out Io io);
    [DllImport("kernel32.dll")] internal static extern bool IsProcessCritical(nint process,out bool critical);
    [DllImport("kernel32.dll")] internal static extern bool GetProcessTimes(nint process,out Times created,out Times exit,out Times kernel,out Times user);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool TerminateProcess(nint process,uint code);
    [DllImport("kernel32.dll")] internal static extern uint GetPriorityClass(nint process);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool QueryFullProcessImageName(nint handle,uint flags,System.Text.StringBuilder path,ref uint length);
    internal static string ImagePath(nint handle){var buffer=new System.Text.StringBuilder(32768);uint length=32768;return QueryFullProcessImageName(handle,0,buffer,ref length)?buffer.ToString():"";}
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern SafeProcessHandle OpenProcess(uint access,bool inherit,int pid);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(nint process,uint access,out SafeAccessTokenHandle token);
    internal static bool SameUser(nint handle) { if(!OpenProcessToken(handle,8,out var token))return false;using(token)using(var identity=new WindowsIdentity(token.DangerousGetHandle()))return identity.User==WindowsIdentity.GetCurrent().User; }
    [DllImport("ntdll.dll")] internal static extern int NtSuspendProcess(nint process);
    [DllImport("ntdll.dll")] internal static extern int NtResumeProcess(nint process);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct ProcessEntry
    { public uint Size,Usage,Pid; public nuint Heap; public uint Module,Threads,Parent; public int Priority;public uint Flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string Exe; }
    [DllImport("kernel32.dll")] static extern nint CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(nint snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(nint snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(nint handle);
    internal static Dictionary<int,int> Parents() {var map=new Dictionary<int,int>();var snap=CreateToolhelp32Snapshot(2,0);if(snap==-1)return map;try{var row=new ProcessEntry{Size=(uint)Marshal.SizeOf<ProcessEntry>()};if(Process32FirstW(snap,ref row))do{map[(int)row.Pid]=(int)row.Parent;}while(Process32NextW(snap,ref row));}finally{CloseHandle(snap);}return map;}
    internal static HashSet<int> Ancestors(){var map=Parents();var set=new HashSet<int>{0,4};int pid=Environment.ProcessId;while(set.Add(pid)&&map.TryGetValue(pid,out pid)){}return set;}

    // Native hardware-interface flag prevents counting a VPN and its physical adapter twice.
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct InterfaceRow
    {
        public ulong Luid;public uint Index;public Guid Guid;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=257)]public string Alias;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=257)]public string Description;
        public uint AddressLength;[MarshalAs(UnmanagedType.ByValArray,SizeConst=32)]public byte[] Address;
        [MarshalAs(UnmanagedType.ByValArray,SizeConst=32)]public byte[] Permanent;
        public uint Mtu,Type,Tunnel,Media,PhysicalMedium,Access,Direction;public byte Flags;
        public uint OperStatus,AdminStatus,MediaState;public Guid NetworkGuid;public uint Connection;
        public ulong TransmitSpeed,ReceiveSpeed,InOctets,InPackets,InNonUnicast,InDiscards,InErrors,InUnknown,InUnicastBytes,InMulticastBytes,InBroadcastBytes;
        public ulong OutOctets,OutPackets,OutNonUnicast,OutDiscards,OutErrors,OutUnicastBytes,OutMulticastBytes,OutBroadcastBytes,OutQueue;
    }
    [DllImport("iphlpapi.dll")] internal static extern uint GetIfEntry2(ref InterfaceRow row);

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct AdapterDesc
    { [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)]public string Name;public uint Vendor,Device,Subsystem,Revision;public nuint Dedicated, System,Shared;public uint Low;public int High;public uint Flags; }
    [DllImport("dxgi.dll")]static extern int CreateDXGIFactory1(ref Guid iid,out nint factory);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]delegate int EnumAdapter(nint self,uint index,out nint adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]delegate int GetDesc(nint self,out AdapterDesc desc);
    static T Method<T>(nint obj,int slot)where T:Delegate=>Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj),slot*IntPtr.Size));
    internal static List<AdapterDesc> Adapters(){var list=new List<AdapterDesc>();var guid=new Guid("770aae78-f26f-4dba-a829-253c83d1b387");if(CreateDXGIFactory1(ref guid,out var factory)!=0)return list;try{for(uint i=0;i<32;i++){if(Method<EnumAdapter>(factory,12)(factory,i,out var adapter)!=0)break;try{if(Method<GetDesc>(adapter,10)(adapter,out var d)==0&&(d.Flags&2)==0)list.Add(d);}finally{Marshal.Release(adapter);}}}finally{Marshal.Release(factory);}return list;}
}
