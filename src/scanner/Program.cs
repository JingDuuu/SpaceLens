using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;

namespace SpaceLens.Scanner;

internal static class Program
{
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };
    private static readonly object OutputLock = new();

    public static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        if (args.Length == 0 || args[0] is "--help" or "-h" or "help")
        {
            Console.WriteLine("SpaceLens.Scanner scan --path DIRECTORY --output SNAPSHOT.json [--workers 1..32]\n" +
                "Read-only native Windows metadata enumeration; bytes are logical file sizes.\n" +
                "Progress and completion: JSON Lines on stdout. Errors: JSON Lines on stderr.\n" +
                "Cancel: Ctrl+C or one line 'cancel' on stdin. A cancelled scan saves a partial snapshot.\n" +
                "Exit codes: 0 snapshot saved (inspect status), 2 invalid input, 3 scan/save failure.");
            return 0;
        }
        if (!OperatingSystem.IsWindows())
            return Error("unsupported_platform", "This scanner requires Windows.", 2);

        Options options;
        try { options = Options.Parse(args); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        { return Error("invalid_arguments", ex.Message, 2); }

        Native.FileAttributeData rootData;
        if (!Native.GetFileAttributesExW(Native.ExtendedPath(options.RootPath), 0, out rootData))
        {
            int code = Marshal.GetLastWin32Error();
            return Error("invalid_root", new Win32Exception(code).Message, 2, options.RootPath, code);
        }
        if ((rootData.Attributes & Native.Directory) == 0)
            return Error("invalid_root", "The selected path must be a directory or drive.", 2, options.RootPath);

        // Resolve and validate the output parent before doing potentially lengthy disk work.
        try { Directory.CreateDirectory(Path.GetDirectoryName(options.OutputPath)!); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { return Error("invalid_output", ex.Message, 2, options.OutputPath); }

        using var cancellation = new CancellationTokenSource();
        ConsoleCancelEventHandler cancelHandler = (_, e) => { e.Cancel = true; cancellation.Cancel(); };
        Console.CancelKeyPress += cancelHandler;
        if (Console.IsInputRedirected)
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    while (!cancellation.IsCancellationRequested)
                    {
                        string? line = await Console.In.ReadLineAsync();
                        if (line is null) break;
                        if (line.Trim().Equals("cancel", StringComparison.OrdinalIgnoreCase))
                        { cancellation.Cancel(); break; }
                    }
                }
                catch (IOException) { /* A closed control pipe is not a scan failure. */ }
            });
        }
        try
        {
            var scanner = new DiskScanner(options, rootData, cancellation.Token);
            Snapshot snapshot = await scanner.ScanAsync();
            string temporary = options.OutputPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    1024 * 1024, FileOptions.SequentialScan | FileOptions.Asynchronous))
                {
                    using var writer = new Utf8JsonWriter(output);
                    var saveWatch = Stopwatch.StartNew();
                    long lastReport = -350;
                    writer.WriteStartObject();
                    writer.WriteNumber("schemaVersion", snapshot.SchemaVersion);
                    writer.WriteString("id", snapshot.Id);
                    writer.WriteString("rootPath", snapshot.RootPath);
                    writer.WriteString("startedAt", snapshot.StartedAt);
                    writer.WriteString("finishedAt", snapshot.FinishedAt);
                    writer.WriteString("status", snapshot.Status);
                    writer.WritePropertyName("summary"); JsonSerializer.Serialize(writer, snapshot.Summary, JsonOptions);
                    writer.WritePropertyName("nodes"); writer.WriteStartArray();
                    for (int index = 0; index < snapshot.Nodes.Length; index++)
                    {
                        WriteNode(writer, snapshot.Nodes[index]);
                        if (writer.BytesPending >= 1024 * 1024) await writer.FlushAsync();
                        if (saveWatch.ElapsedMilliseconds - lastReport >= 350)
                        {
                            lastReport = saveWatch.ElapsedMilliseconds;
                            Emit(new { type = "progress", stage = "saving", files = snapshot.Summary.Files,
                                dirs = snapshot.Summary.Dirs, bytes = snapshot.Summary.Bytes,
                                elapsedMs = snapshot.Summary.ElapsedMs + saveWatch.ElapsedMilliseconds,
                                currentPath = snapshot.RootPath, processedNodes = index + 1, totalNodes = snapshot.Nodes.Length,
                                phaseProgress = (double)(index + 1) / snapshot.Nodes.Length });
                        }
                    }
                    writer.WriteEndArray();
                    writer.WritePropertyName("errors"); JsonSerializer.Serialize(writer, snapshot.Errors, JsonOptions);
                    writer.WriteEndObject(); await writer.FlushAsync();
                    Emit(new { type = "progress", stage = "saving", files = snapshot.Summary.Files,
                        dirs = snapshot.Summary.Dirs, bytes = snapshot.Summary.Bytes,
                        elapsedMs = snapshot.Summary.ElapsedMs + saveWatch.ElapsedMilliseconds,
                        currentPath = snapshot.RootPath, phaseProgress = 1.0 });
                }
                File.Move(temporary, options.OutputPath, overwrite: true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            Emit(new { type = "complete", output = options.OutputPath, status = snapshot.Status, summary = snapshot.Summary });
            return 0;
        }
        catch (Exception ex)
        { return Error("scan_failed", ex.Message, 3, options.RootPath); }
        finally { Console.CancelKeyPress -= cancelHandler; }
    }

    internal static void Emit(object value)
    {
        lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
    }

    // Keep many records in the writer buffer. Serializing each node separately
    // flushes the writer once per file, creating millions of tiny stream writes.
    private static void WriteNode(Utf8JsonWriter writer, ScanNode node)
    {
        writer.WriteStartObject();
        writer.WriteNumber("id", node.Id);
        if (node.Parent is int parent) writer.WriteNumber("parent", parent); else writer.WriteNull("parent");
        writer.WriteString("name", node.Name); writer.WriteString("kind", node.Kind);
        writer.WriteNumber("bytes", node.Bytes);
        if (node.Modified is DateTime modified) writer.WriteString("modified", modified); else writer.WriteNull("modified");
        if (node.Accessed is DateTime accessed) writer.WriteString("accessed", accessed); else writer.WriteNull("accessed");
        writer.WriteNumber("files", node.Files); writer.WriteNumber("dirs", node.Dirs);
        writer.WriteString("category", node.Category);
        if (node.Warning is not null) writer.WriteString("warning", node.Warning);
        writer.WriteEndObject();
    }

    private static int Error(string type, string message, int exitCode, string? path = null, int? code = null)
    {
        Console.Error.WriteLine(JsonSerializer.Serialize(new { type = "error", error = type, message, path, code }, JsonOptions));
        return exitCode;
    }
}

internal sealed record Options(string RootPath, string OutputPath, int Workers)
{
    internal static Options Parse(string[] args)
    {
        if (args[0] != "scan") throw new ArgumentException("Unknown command. Use 'scan' or '--help'.");
        string? root = null, output = null;
        int workers = Math.Clamp(Environment.ProcessorCount, 1, 4);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 1; i < args.Length; i++)
        {
            string option = args[i];
            if (option is not ("--path" or "--output" or "--workers"))
                throw new ArgumentException($"Unknown option: {option}");
            if (!seen.Add(option)) throw new ArgumentException($"Duplicate option: {option}");
            if (++i == args.Length) throw new ArgumentException($"Missing value for {option}.");
            switch (option)
            {
                case "--path": root = args[i]; break;
                case "--output": output = args[i]; break;
                case "--workers":
                    if (!int.TryParse(args[i], NumberStyles.None, CultureInfo.InvariantCulture, out workers) || workers is < 1 or > 32)
                        throw new ArgumentException("--workers must be an integer between 1 and 32.");
                    break;
            }
        }
        if (string.IsNullOrWhiteSpace(root)) throw new ArgumentException("--path is required.");
        if (string.IsNullOrWhiteSpace(output)) throw new ArgumentException("--output is required.");
        // Display paths remain ordinary paths; native calls use extended paths for long/UNC support.
        return new Options(Native.DisplayPath(Path.GetFullPath(root)), Path.GetFullPath(output), workers);
    }
}

internal sealed class DiskScanner
{
    private const int QueueCapacity = 2048;
    private const int ErrorDetailLimit = 10000;
    private readonly Options _options;
    private readonly CancellationToken _cancellation;
    private readonly Native.FileAttributeData _rootData;
    private readonly Channel<DirectoryWork> _queue = Channel.CreateBounded<DirectoryWork>(new BoundedChannelOptions(QueueCapacity)
    { FullMode = BoundedChannelFullMode.Wait, SingleReader = false, SingleWriter = false, AllowSynchronousContinuations = false });
    private readonly List<ScanNode>[] _nodeLists;
    private readonly ConcurrentQueue<ScanError> _errors = new();
    private readonly Stopwatch _watch = new();
    private long _bytes, _files, _dirs, _errorCount, _skipped, _cloudFiles;
    private int _nextId, _outstanding;
    private string _currentPath;

    internal DiskScanner(Options options, Native.FileAttributeData rootData, CancellationToken cancellation)
    {
        _options = options; _rootData = rootData; _cancellation = cancellation; _currentPath = options.RootPath;
        _nodeLists = Enumerable.Range(0, options.Workers).Select(_ => new List<ScanNode>()).ToArray();
    }

    internal async Task<Snapshot> ScanAsync()
    {
        var started = DateTime.UtcNow;
        _watch.Start();
        string rootName = Path.GetFileName(Path.TrimEndingDirectorySeparator(_options.RootPath));
        if (string.IsNullOrEmpty(rootName)) rootName = _options.RootPath;
        var root = new ScanNode
        {
            Id = 0, Name = rootName, Kind = "directory", Category = "folder",
            Modified = Native.Timestamp(_rootData.LastWriteTime), Accessed = Native.Timestamp(_rootData.LastAccessTime)
        };
        _nodeLists[0].Add(root);

        using var progressStop = new CancellationTokenSource();
        EmitProgress();
        Task progress = ReportProgressAsync(progressStop.Token);
        try
        {
            if (ShouldSkipDirectory(_rootData.Attributes, out string? rootWarning))
            {
                root.Warning = rootWarning;
                root.State = 2;
                Interlocked.Increment(ref _skipped);
            }
            else
            {
                _outstanding = 1;
                _queue.Writer.TryWrite(new DirectoryWork(root, _options.RootPath));
                Task[] workers = Enumerable.Range(0, _options.Workers)
                    .Select(worker => Task.Run(() => WorkerAsync(worker))).ToArray();
                await Task.WhenAll(workers);
            }
        }
        finally
        {
            progressStop.Cancel();
            await progress;
        }

        var nodes = new ScanNode[_nextId + 1];
        foreach (List<ScanNode> list in _nodeLists)
            foreach (ScanNode node in list) nodes[node.Id] = node;
        // IDs are allocated after their parents, allowing a single O(n) reverse aggregation.
        for (int i = nodes.Length - 1; i >= 0; i--)
        {
            ScanNode node = nodes[i];
            if (_cancellation.IsCancellationRequested && node.Kind == "directory" && node.State != 2 && node.Warning is null)
                node.Warning = "scan_cancelled";
            if (node.Parent is not int parentId) continue;
            ScanNode parent = nodes[parentId];
            parent.Bytes += node.Bytes;
            parent.Files += node.Files;
            parent.Dirs += node.Dirs + (node.Kind == "directory" ? 1 : 0);
        }
        _watch.Stop();
        string status = _cancellation.IsCancellationRequested ? "cancelled" : _errorCount > 0 || _skipped > 0 ? "partial" : "complete";
        return new Snapshot
        {
            Id = Guid.NewGuid().ToString("N"), RootPath = _options.RootPath, StartedAt = started,
            FinishedAt = DateTime.UtcNow, Status = status, Nodes = nodes, Errors = _errors.ToArray(),
            Summary = new ScanSummary
            {
                Bytes = root.Bytes, Files = root.Files, Dirs = root.Dirs, ElapsedMs = _watch.ElapsedMilliseconds,
                Errors = _errorCount, Skipped = _skipped, CloudFiles = _cloudFiles,
                ErrorDetailsTruncated = Math.Max(0, _errorCount - _errors.Count),
                Engine = "win32-findfirstfileex-largefetch", Workers = _options.Workers, SizeMetric = "logical"
            }
        };
    }

    private async Task WorkerAsync(int worker)
    {
        try
        {
            while (await _queue.Reader.WaitToReadAsync(_cancellation))
            {
                while (_queue.Reader.TryRead(out DirectoryWork? work))
                {
                    try
                    {
                        // Overflow work is visited depth first by its owning worker. Producers never
                        // wait for queue space, so a full queue cannot deadlock all reader-workers.
                        var local = new Stack<DirectoryWork>();
                        local.Push(work);
                        while (local.Count > 0 && !_cancellation.IsCancellationRequested)
                            EnumerateDirectory(local.Pop(), _nodeLists[worker], local);
                    }
                    finally
                    {
                        if (Interlocked.Decrement(ref _outstanding) == 0) _queue.Writer.TryComplete();
                    }
                    if (_cancellation.IsCancellationRequested) return;
                }
            }
        }
        catch (OperationCanceledException) when (_cancellation.IsCancellationRequested) { }
    }

    private unsafe void EnumerateDirectory(DirectoryWork work, List<ScanNode> nodes, Stack<DirectoryWork> local)
    {
        if (_cancellation.IsCancellationRequested) return;
        work.Node.State = 1;
        Volatile.Write(ref _currentPath, work.Path);
        string pattern = Native.ExtendedPath(work.Path.TrimEnd('\\') + "\\*");
        using SafeFindHandle handle = Native.FindFirst(pattern, out Native.FindData data);
        if (handle.IsInvalid)
        {
            int code = Marshal.GetLastWin32Error();
            // FindFirst returns FILE_NOT_FOUND for some empty directory providers.
            if (code != Native.ErrorFileNotFound)
            { AddError(work.Path, code); work.Node.Warning = "directory_unreadable"; }
            work.Node.State = 2;
            return;
        }

        while (true)
        {
            if (_cancellation.IsCancellationRequested) return;
            string name = new(data.FileName);
            if (name is not ("." or ".."))
            {
                bool directory = (data.Attributes & Native.Directory) != 0;
                var node = new ScanNode
                {
                    Id = Interlocked.Increment(ref _nextId), Parent = work.Node.Id, Name = name,
                    Kind = directory ? "directory" : "file", Category = directory ? "folder" : Categories.FromName(name),
                    Modified = Native.Timestamp(data.LastWriteTime), Accessed = Native.Timestamp(data.LastAccessTime),
                    Bytes = directory ? 0 : ((long)data.FileSizeHigh << 32) | data.FileSizeLow,
                    Files = directory ? 0 : 1
                };
                nodes.Add(node);
                if (directory)
                {
                    Interlocked.Increment(ref _dirs);
                    if (ShouldSkipDirectory(data.Attributes, out string? warning))
                    {
                        node.Warning = warning;
                        node.State = 2;
                        Interlocked.Increment(ref _skipped);
                    }
                    else
                    {
                        var child = new DirectoryWork(node, Path.Join(work.Path, name));
                        Interlocked.Increment(ref _outstanding);
                        if (!_queue.Writer.TryWrite(child))
                        {
                            Interlocked.Decrement(ref _outstanding);
                            local.Push(child);
                        }
                    }
                }
                else
                {
                    // Metadata enumeration does not open or hydrate cloud files. Their apparent
                    // size is retained, and is never presented as locally allocated disk bytes.
                    if (Native.IsCloudPlaceholder(data.Attributes))
                    {
                        node.Warning = "cloud_placeholder_metadata_only";
                        Interlocked.Increment(ref _cloudFiles);
                    }
                    else if ((data.Attributes & Native.ReparsePoint) != 0)
                        node.Warning = "reparse_file_metadata_only";
                    Interlocked.Increment(ref _files);
                    Interlocked.Add(ref _bytes, node.Bytes);
                }
            }
            if (Native.FindNextFileW(handle, out data)) continue;
            int error = Marshal.GetLastWin32Error();
            if (error != Native.ErrorNoMoreFiles)
            { AddError(work.Path, error); work.Node.Warning = "directory_enumeration_incomplete"; }
            work.Node.State = 2;
            return;
        }
    }

    private static bool ShouldSkipDirectory(uint attributes, out string? warning)
    {
        warning = Native.IsCloudPlaceholder(attributes) ? "cloud_directory_skipped" :
            (attributes & Native.ReparsePoint) != 0 ? "reparse_directory_skipped" : null;
        return warning is not null;
    }

    private void AddError(string path, int code)
    {
        long count = Interlocked.Increment(ref _errorCount);
        if (count <= ErrorDetailLimit) _errors.Enqueue(new ScanError(path, new Win32Exception(code).Message, code));
    }

    private void EmitProgress() => Program.Emit(new
    {
        type = "progress", stage = "scanning", files = Interlocked.Read(ref _files), dirs = Interlocked.Read(ref _dirs),
        bytes = Interlocked.Read(ref _bytes), elapsedMs = _watch.ElapsedMilliseconds,
        errors = Interlocked.Read(ref _errorCount), skipped = Interlocked.Read(ref _skipped),
        currentPath = Volatile.Read(ref _currentPath)
    });

    private async Task ReportProgressAsync(CancellationToken stop)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(350));
            while (await timer.WaitForNextTickAsync(stop)) EmitProgress();
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    private sealed record DirectoryWork(ScanNode Node, string Path);
}

internal sealed class Snapshot
{
    public int SchemaVersion { get; init; } = 1;
    public required string Id { get; init; }
    public required string RootPath { get; init; }
    public DateTime StartedAt { get; init; }
    public DateTime FinishedAt { get; init; }
    public required string Status { get; init; }
    public required ScanSummary Summary { get; init; }
    public required ScanNode[] Nodes { get; init; }
    public required ScanError[] Errors { get; init; }
}

internal sealed class ScanSummary
{
    public long Bytes { get; init; }
    public long Files { get; init; }
    public long Dirs { get; init; }
    public long ElapsedMs { get; init; }
    public long Errors { get; init; }
    // Skipped counts directory subtrees deliberately not followed, not metadata-only files.
    public long Skipped { get; init; }
    public long CloudFiles { get; init; }
    public long ErrorDetailsTruncated { get; init; }
    public required string Engine { get; init; }
    public int Workers { get; init; }
    public required string SizeMetric { get; init; }
}

internal sealed class ScanNode
{
    public int Id { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Parent { get; init; }
    public required string Name { get; init; }
    public required string Kind { get; init; }
    public long Bytes { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public DateTime? Modified { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public DateTime? Accessed { get; init; }
    public long Files { get; set; }
    public long Dirs { get; set; }
    public required string Category { get; init; }
    public string? Warning { get; set; }
    [JsonIgnore] public int State { get; set; }
}

internal sealed record ScanError(string Path, string Message, int Code);

internal static class Categories
{
    internal static string FromName(string name) => Path.GetExtension(name).ToLowerInvariant() switch
    {
        ".mp4" or ".mov" or ".mkv" or ".avi" or ".webm" or ".m4v" or ".wmv" or ".mpg" or ".mpeg" or ".mxf" or ".r3d" or ".braw" or ".mts" or ".m2ts" => "video",
        ".mp3" or ".wav" or ".flac" or ".aac" or ".m4a" or ".ogg" or ".opus" or ".aiff" or ".aif" or ".wma" => "audio",
        ".jpg" or ".jpeg" or ".png" or ".gif" or ".webp" or ".avif" or ".bmp" or ".tif" or ".tiff" or ".heic" or ".psd" or ".psb" or ".exr" or ".dpx" or ".raw" or ".cr2" or ".nef" or ".svg" or ".ico" => "image",
        ".zip" or ".7z" or ".rar" or ".tar" or ".gz" or ".bz2" or ".xz" or ".iso" or ".cab" or ".dmg" => "archive",
        ".js" or ".mjs" or ".cjs" or ".ts" or ".tsx" or ".jsx" or ".py" or ".cs" or ".cpp" or ".c" or ".h" or ".hpp" or ".rs" or ".go" or ".java" or ".kt" or ".swift" or ".php" or ".rb" or ".vue" or ".html" or ".css" or ".scss" or ".json" or ".yaml" or ".yml" or ".xml" or ".toml" or ".sql" or ".sh" or ".ps1" => "code",
        ".pdf" or ".doc" or ".docx" or ".xls" or ".xlsx" or ".ppt" or ".pptx" or ".txt" or ".md" or ".rtf" or ".odt" or ".csv" or ".epub" or ".pages" or ".numbers" or ".key" => "document",
        ".exe" or ".msi" or ".msix" or ".appx" or ".dll" or ".sys" or ".com" or ".bat" or ".cmd" => "application",
        _ => "other"
    };
}

internal static class Native
{
    internal const uint Directory = 0x10, ReparsePoint = 0x400, Offline = 0x1000,
        RecallOnOpen = 0x40000, RecallOnDataAccess = 0x400000;
    internal const int ErrorFileNotFound = 2, ErrorNoMoreFiles = 18;

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileTime { public uint Low, High; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FileAttributeData
    {
        public uint Attributes;
        public FileTime CreationTime, LastAccessTime, LastWriteTime;
        public uint FileSizeHigh, FileSizeLow;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal unsafe struct FindData
    {
        public uint Attributes;
        public FileTime CreationTime, LastAccessTime, LastWriteTime;
        public uint FileSizeHigh, FileSizeLow, Reserved0, Reserved1;
        public fixed char FileName[260];
        public fixed char AlternateFileName[14];
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetFileAttributesExW(string fileName, int infoLevel, out FileAttributeData data);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFindHandle FindFirstFileExW(string fileName, int infoLevel, out FindData data,
        int searchOp, IntPtr searchFilter, uint additionalFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool FindNextFileW(SafeFindHandle handle, out FindData data);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool FindClose(IntPtr handle);

    internal static SafeFindHandle FindFirst(string pattern, out FindData data)
    {
        SafeFindHandle handle = FindFirstFileExW(pattern, 1, out data, 0, IntPtr.Zero, 2);
        if (handle.IsInvalid && Marshal.GetLastWin32Error() == 87)
        {
            handle.Dispose();
            handle = FindFirstFileExW(pattern, 1, out data, 0, IntPtr.Zero, 0);
        }
        return handle;
    }

    internal static bool IsCloudPlaceholder(uint attributes) => (attributes & (Offline | RecallOnOpen | RecallOnDataAccess)) != 0;

    internal static string ExtendedPath(string path)
    {
        if (path.StartsWith("\\\\?\\", StringComparison.Ordinal)) return path;
        return path.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + path[2..] : "\\\\?\\" + path;
    }

    internal static string DisplayPath(string path)
    {
        if (path.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + path[8..];
        return path.StartsWith("\\\\?\\", StringComparison.Ordinal) ? path[4..] : path;
    }

    internal static DateTime? Timestamp(FileTime value)
    {
        long fileTime = ((long)value.High << 32) | value.Low;
        if (fileTime <= 0) return null;
        try { return DateTime.FromFileTimeUtc(fileTime); }
        catch (ArgumentOutOfRangeException) { return null; }
    }
}

internal sealed class SafeFindHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeFindHandle() : base(true) { }
    protected override bool ReleaseHandle() => Native.FindClose(handle);
}
