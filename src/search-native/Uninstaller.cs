using Microsoft.Win32;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
internal static class Uninstaller
{
 public static void Run(){try{
  using var doc=JsonDocument.Parse(Console.ReadLine()??"{}");var q=doc.RootElement;
  string hive=q.GetProperty("hive").GetString()??"",view=q.GetProperty("view").GetString()??"",key=q.GetProperty("key").GetString()??"";
  if(!new[]{"LocalMachine","CurrentUser"}.Contains(hive)||!new[]{"Registry32","Registry64"}.Contains(view)||key.Contains('\\')||key.Length>255)throw new Exception("无效安装记录");
  using var root=RegistryKey.OpenBaseKey(Enum.Parse<RegistryHive>(hive),Enum.Parse<RegistryView>(view));
  using var app=root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\"+key,false)??throw new Exception("安装记录已不存在");
  var name=app.GetValue("DisplayName") as string;if(string.IsNullOrWhiteSpace(name))throw new Exception("应用名称缺失");
  var command=Environment.ExpandEnvironmentVariables(app.GetValue("UninstallString") as string??"").Trim();string exe,arguments;
  if(Convert.ToInt32(app.GetValue("WindowsInstaller",0))==1&&Guid.TryParse(key,out var guid)){exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"msiexec.exe");arguments="/x {"+guid+"}";}
  else{var m=Regex.Match(command,"^(?:\"(?<exe>[^\"]+\\.exe)\"|(?<exe>.+?\\.exe))(?:\\s+(?<args>.*))?$",RegexOptions.IgnoreCase);if(!m.Success)throw new Exception("此应用没有可直接运行的卸载程序");exe=m.Groups["exe"].Value;arguments=m.Groups["args"].Value;
   if(Path.GetFileName(exe).Equals("msiexec.exe",StringComparison.OrdinalIgnoreCase)){var match=Regex.Match(arguments,@"\{[0-9a-fA-F-]{36}\}");if(!match.Success||!Guid.TryParse(match.Value,out guid))throw new Exception("无效 MSI 标识");exe=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"msiexec.exe");arguments="/x {"+guid+"}";}}
  string[] blocked=["cmd.exe","powershell.exe","pwsh.exe","wscript.exe","cscript.exe","rundll32.exe","regsvr32.exe","mshta.exe","reg.exe"];
  if(!Path.IsPathRooted(exe)||!File.Exists(exe)||blocked.Contains(Path.GetFileName(exe),StringComparer.OrdinalIgnoreCase))throw new Exception("此卸载入口不受支持，请使用应用自身的卸载功能");
  using var process=Process.Start(new ProcessStartInfo{FileName=exe,Arguments=arguments,WorkingDirectory=Path.GetDirectoryName(exe),UseShellExecute=true})??throw new Exception("无法启动卸载程序");process.WaitForExit();
  Console.WriteLine(JsonSerializer.Serialize(new{ok=process.ExitCode==0||process.ExitCode==3010,exitCode=process.ExitCode,restartRequired=process.ExitCode==3010,name}));
 }catch(Exception e){Console.WriteLine(JsonSerializer.Serialize(new{error=e.Message}));Environment.ExitCode=1;}}
}
