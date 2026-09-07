using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Buffers.Binary;

// Everything's documented QUERY2 IPC. A persistent message window avoids process
// startup per keystroke and lets the engine cancel superseded queries itself.
internal class Bridge : Form
{
    [StructLayout(LayoutKind.Sequential)] struct CopyData { public nuint Tag; public int Length; public nint Data; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern nint FindWindow(string cls,string? title);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] static extern nint Send(nint hwnd,uint msg,nuint w,nint l,uint flags,uint timeout,out nuint result);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] static extern nint Copy(nint hwnd,uint msg,nint w,ref CopyData l,uint flags,uint timeout,out nuint result);
    readonly string instance; int active; long started; nint engine; readonly System.Windows.Forms.Timer timer=new(){Interval=15000};
    static readonly JsonSerializerOptions Json=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase};
    public Bridge(string name){instance=name;_ = Handle;timer.Tick+=(_,_)=>{if(active!=0){Write(new{id=active,error="搜索引擎响应超时，请缩短关键词或重试"});active=0;}timer.Stop();};}
    protected override void SetVisibleCore(bool value)=>base.SetVisibleCore(false);
    static void Write(object value){Console.WriteLine(JsonSerializer.Serialize(value,Json));Console.Out.Flush();}
    static uint U(byte[] b,int offset){if(offset<0||offset+4>b.Length)throw new Exception("Invalid IPC bounds");return BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(offset,4));}
    nint Locate()=>FindWindow("EVERYTHING_TASKBAR_NOTIFICATION"+(instance.Length>0?"_("+instance+")":""),null);
    uint State(nint h,uint kind){return h!=0&&Send(h,0x400,kind,0,2,400,out var value)!=0?(uint)value:0;}
    public void Request(string line){int id=0;try{
        using var doc=JsonDocument.Parse(line);var q=doc.RootElement;id=q.GetProperty("id").GetInt32();engine=Locate();var loaded=State(engine,401)==1;
        if(q.GetProperty("method").GetString()=="status"){Write(new{id,ok=true,connected=engine!=0,loaded,busy=State(engine,402)==1,version=engine!=0?$"{State(engine,0)}.{State(engine,1)}.{State(engine,2)}.{State(engine,3)}":null});return;}
        if(!loaded)throw new Exception(engine==0?"搜索引擎尚未连接":"正在建立全盘索引，请稍候");
        if(active!=0)Write(new{id=active,error="superseded"});active=id;started=Stopwatch.GetTimestamp();timer.Stop();timer.Start();
        var search=q.GetProperty("query").GetString()??"";if(search.Length>4096)throw new Exception("搜索词过长");
        var text=Encoding.Unicode.GetBytes(search+'\0');var packet=new byte[28+text.Length];
        uint[] header=[unchecked((uint)Handle.ToInt64()),(uint)id,q.TryGetProperty("flags",out var fl)?fl.GetUInt32():0,q.GetProperty("offset").GetUInt32(),Math.Min(q.GetProperty("limit").GetUInt32(),200),0x4|0x10|0x40|0x100,q.GetProperty("sort").GetUInt32()];
        for(int i=0;i<header.Length;i++)BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(i*4,4),header[i]);text.CopyTo(packet,28);
        var ptr=Marshal.AllocHGlobal(packet.Length);try{Marshal.Copy(packet,0,ptr,packet.Length);var copy=new CopyData{Tag=18,Length=packet.Length,Data=ptr};if(Copy(engine,0x4a,Handle,ref copy,2,1000,out var accepted)==0||accepted==0)throw new Exception("搜索请求未被引擎接受");}finally{Marshal.FreeHGlobal(ptr);}
    }catch(Exception e){if(active==id){active=0;timer.Stop();}Write(new{id,error=e.Message});}}
    protected override void WndProc(ref Message m){
        if(m.Msg!=0x4a){base.WndProc(ref m);return;}
        var data=Marshal.PtrToStructure<CopyData>(m.LParam);if(data.Tag!=(nuint)active||active==0||m.WParam!=engine){m.Result=0;return;}
        int id=active;active=0;timer.Stop();try{
            if(data.Length<20||data.Length>16*1024*1024)throw new Exception("Invalid IPC response");var b=new byte[data.Length];Marshal.Copy(data.Data,b,0,b.Length);
            uint total=U(b,0),count=U(b,4),offset=U(b,8),flags=U(b,12);if(count>200||20+count*8>b.Length||(flags&4)==0)throw new Exception("Invalid IPC item list");
            var items=new List<object>();for(int i=0;i<count;i++){uint attributes=0;var folder=(U(b,20+i*8)&1)!=0;int p=checked((int)U(b,24+i*8));int chars=checked((int)U(b,p));p+=4;if(chars>32768||p+chars*2+2>b.Length)throw new Exception("Invalid IPC path");string full=Encoding.Unicode.GetString(b,p,chars*2);p+=chars*2+2;long? size=null;string? modified=null;
                if((flags&16)!=0){if(p+8>b.Length)throw new Exception("Invalid size");long n=BinaryPrimitives.ReadInt64LittleEndian(b.AsSpan(p,8));if(n>=0)size=n;p+=8;}
                if((flags&64)!=0){if(p+8>b.Length)throw new Exception("Invalid date");long n=BinaryPrimitives.ReadInt64LittleEndian(b.AsSpan(p,8));if(n>0&&n<DateTime.MaxValue.ToFileTimeUtc())modified=DateTime.FromFileTimeUtc(n).ToString("O");p+=8;}
                if((flags&256)!=0)attributes=U(b,p);
                items.Add(new{path=full,name=Path.GetFileName(full.TrimEnd('\\')),kind=folder?"directory":"file",bytes=folder?(long?)null:size,modified,attributes});
            }
            Write(new{id,ok=true,total,offset,items,engineMs=Stopwatch.GetElapsedTime(started).TotalMilliseconds});m.Result=1;
        }catch(Exception e){Write(new{id,error=e.Message});m.Result=0;}
    }
    [STAThread] static void Main(string[] args){Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);if(args.FirstOrDefault()=="--uninstall"){Uninstaller.Run();return;}using var bridge=new Bridge(args.FirstOrDefault()??"");Task.Run(()=>{string? line;while((line=Console.ReadLine())!=null){var captured=line;try{bridge.BeginInvoke(()=>bridge.Request(captured));}catch{return;}}try{bridge.BeginInvoke(Application.ExitThread);}catch{}});Application.Run();}
}
