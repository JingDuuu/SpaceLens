using System.Diagnostics;
using System.Text.Json;

internal sealed class Controls:IDisposable
{
    readonly Dictionary<string,Process> paused=new();readonly Dictionary<string,ProcessPriorityClass> priorities=new();
    static string Key(int pid,long created)=>$"{pid}/{created}";
    public static Process Validate(int pid,long created){if(Native.Ancestors().Contains(pid))throw new Exception("系统及 SpaceLens 自身进程受保护");var p=Process.GetProcessById(pid);try{
        if(!Native.GetProcessTimes(p.Handle,out var birth,out _,out _,out _)||DateTime.FromFileTimeUtc((long)birth.Value).Ticks!=created)throw new Exception("进程已重新启动，请重新选择");
        string file=p.MainModule?.FileName??"";string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows)+Path.DirectorySeparatorChar;
        if(string.IsNullOrEmpty(file)||file.StartsWith(windows,StringComparison.OrdinalIgnoreCase)||new[]{"SpaceLens.exe","SpaceLens.Monitor.exe"}.Contains(Path.GetFileName(file),StringComparer.OrdinalIgnoreCase)||!Native.SameUser(p.Handle)||!Native.IsProcessCritical(p.Handle,out bool critical)||critical)throw new Exception("系统、其他账户或受保护进程不允许控制");return p;
    }catch{p.Dispose();throw;}}
    public bool IsPaused(int pid,long created){string key=Key(pid,created);if(paused.TryGetValue(key,out var guardian)){if(!guardian.HasExited)return true;guardian.Dispose();paused.Remove(key);}return false;}
    public bool PriorityChanged(int pid,long created)=>priorities.ContainsKey(Key(pid,created));
    public object Act(string action,int pid,long created){string key=Key(pid,created);if(action=="resume"){if(!paused.Remove(key,out var guardian))throw new Exception("此进程未由 SpaceLens 暂停，或已自动恢复");try{guardian.StandardInput.WriteLine("resume");guardian.WaitForExit(5000);}finally{guardian.Dispose();}return new{ok=true};}
        using var p=Validate(pid,created);switch(action){
            case "terminate":if(!Native.TerminateProcess(p.Handle,1))throw new Exception("系统拒绝结束进程");break;
            case "pause":if(IsPaused(pid,created))return new{ok=true};var guardian=Process.Start(new ProcessStartInfo{FileName=Environment.ProcessPath!,Arguments=$"--pause {pid} {created}",UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true})!;var line=guardian.StandardOutput.ReadLine();if(line!="paused"){guardian.Dispose();throw new Exception(line??"暂停失败");}paused[key]=guardian;break;
            case "lower":if(!priorities.ContainsKey(key))priorities[key]=p.PriorityClass;p.PriorityClass=ProcessPriorityClass.BelowNormal;break;
            case "restore":if(!priorities.TryGetValue(key,out var original))throw new Exception("没有由 SpaceLens 修改的优先级");p.PriorityClass=original;priorities.Remove(key);break;
            default:throw new Exception("不支持的进程操作");
        }return new{ok=true};
    }
    public static async Task Pause(int pid,long created){bool suspended=false;using var p=Validate(pid,created);try{if(Native.NtSuspendProcess(p.Handle)!=0)throw new Exception("系统拒绝暂停");suspended=true;Console.WriteLine("paused");Console.Out.Flush();await Task.WhenAny(Console.In.ReadLineAsync(),Task.Delay(60000));}finally{if(suspended)Native.NtResumeProcess(p.Handle);}}
    public void Dispose(){foreach(var p in paused.Values){try{p.StandardInput.WriteLine("resume");p.WaitForExit(5000);}catch{}p.Dispose();}paused.Clear();foreach(var (key,value)in priorities){var parts=key.Split('/');try{using var p=Validate(int.Parse(parts[0]),long.Parse(parts[1]));p.PriorityClass=value;}catch{}}priorities.Clear();}
}
