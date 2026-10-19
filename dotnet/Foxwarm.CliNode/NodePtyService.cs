using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Terminal;

namespace Foxwarm.CliNode;

// Process-local terminals survive transport replacement, not CLI shutdown.
internal sealed class NodePtyService : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, Record> terminals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Pending> pending = new(StringComparer.Ordinal);
    private readonly string directory;
    private readonly CodeHelperServer helper;
    private object? connection;
    private Func<JsonObject, Task>? send;

    private sealed record Pending(
        string TerminalId,
        object Connection,
        TaskCompletionSource<CodeHelperServer.CodeHelperResult> Completion
    );

    internal NodePtyService(string stateDirectory)
    {
        directory = Path.Combine(stateDirectory, ".temp", "vscode-pty");
        helper = new CodeHelperServer(stateDirectory, RequestCode);
    }

    internal static bool IsSupported => TerminalNative.IsSupported;

    internal void Connect(object owner, Func<JsonObject, Task> emit)
    {
        lock (gate)
        {
            connection = owner;
            send = emit;
        }
    }

    internal void Disconnect(object owner)
    {
        lock (gate)
        {
            if (!ReferenceEquals(connection, owner))
                return;
            connection = null;
            send = null;
            foreach (var record in terminals.Values)
                record.StreamingOwner = null;
            foreach (var item in pending.Values)
                item.Completion.TrySetResult(
                    new(false, null, "Node disconnected before Code handled the request.")
                );
            pending.Clear();
        }
    }

    internal async Task Dispatch(
        string operation,
        JsonObject args,
        object owner,
        Func<JsonObject, Task> reply
    )
    {
        JsonObject result;
        switch (operation)
        {
            case "create":
                result = new() { ["terminal"] = await Create(args) };
                break;
            case "list":
                lock (gate)
                    result = new()
                    {
                        ["terminals"] = new JsonArray(
                            terminals
                                .Values.OrderByDescending(item => item.CreatedAt)
                                .Select(item => (JsonNode?)item.Describe())
                                .ToArray()
                        ),
                    };
                break;
            case "get":
                var id = Required(args, "terminalId");
                lock (gate)
                    result = new() { ["terminal"] = terminals.GetValueOrDefault(id)?.Describe() };
                break;
            case "attach":
                Task ready;
                lock (gate)
                {
                    var record = Require(Required(args, "terminalId"));
                    record.StreamingOwner = owner;
                    // Queue ready/backlog under the output lock, before live output can queue.
                    var response = new JsonObject
                    {
                        ["terminal"] = record.Describe(),
                        ["backlog"] = record.Backlog.ToString(),
                    };
                    ready = reply(response);
                }
                await ready;
                return;
            case "detach":
                lock (gate)
                    Require(Required(args, "terminalId")).StreamingOwner = null;
                result = Success();
                break;
            case "input":
                Record input;
                lock (gate)
                    input = Require(Required(args, "terminalId"));
                await input.Write(NodeFileTools.Text(args["data"]) ?? "");
                result = Success();
                break;
            case "resize":
                lock (gate)
                {
                    var record = Require(Required(args, "terminalId"));
                    record.Cols = Size(args, "cols", 20, record.Cols);
                    record.Rows = Size(args, "rows", 5, record.Rows);
                    record.Native.Resize(NativeSize(record.Cols), NativeSize(record.Rows));
                }
                result = Success();
                break;
            case "close":
                Record? closing;
                lock (gate)
                    terminals.TryGetValue(Required(args, "terminalId"), out closing);
                if (closing is not null)
                    await closing.Close();
                result = Success();
                break;
            case "code-result":
                var requestId = Required(args, "requestId");
                lock (gate)
                {
                    if (
                        pending.TryGetValue(requestId, out var callback)
                        && ReferenceEquals(owner, callback.Connection)
                    )
                    {
                        pending.Remove(requestId);
                        callback.Completion.TrySetResult(
                            args["ok"]?.ToJsonString() == "true"
                                ? new(true, NodeFileTools.Text(args["message"]), null)
                                : new(
                                    false,
                                    null,
                                    NodeFileTools.Text(args["error"])
                                        ?? "Code rejected the request."
                                )
                        );
                    }
                }
                result = Success();
                break;
            default:
                throw new InvalidOperationException(
                    "Unsupported vscode-pty operation: " + operation
                );
        }
        await reply(result);
    }

    private static JsonObject Success() => new() { ["success"] = true };

    private static string Required(JsonObject args, string key)
    {
        var value = NodeFileTools.Text(args[key]);
        value = value is null ? "" : NodePaths.TrimSpace(value);
        if (value.Length == 0)
            throw new InvalidOperationException(key + " is required");
        return value;
    }

    private static double Size(JsonObject args, string key, int minimum, double fallback)
    {
        double number;
        if (!args.ContainsKey(key))
            return fallback;
        var value = args[key];
        if (value is null)
            number = 0;
        else if (value is JsonValue flag && flag.TryGetValue<bool>(out var boolean))
            number = boolean ? 1 : 0;
        else
        {
            var text =
                NodeFileTools.Text(value)
                ?? (value is JsonArray array ? ArrayString(array) : value.ToJsonString());
            text = NodePaths.TrimSpace(text);
            if (text.Length == 0)
                number = 0;
            else if (
                text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                && ulong.TryParse(
                    text[2..],
                    NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture,
                    out var hex
                )
            )
                number = hex;
            else if (
                text.StartsWith("0b", StringComparison.OrdinalIgnoreCase)
                || text.StartsWith("0o", StringComparison.OrdinalIgnoreCase)
            )
            {
                try
                {
                    number = Convert.ToUInt64(
                        text[2..],
                        char.ToLowerInvariant(text[1]) == 'b' ? 2 : 8
                    );
                }
                catch (Exception error)
                    when (error is FormatException or OverflowException or ArgumentException)
                {
                    return fallback;
                }
            }
            else if (
                !double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out number)
            )
                return fallback;
        }
        if (!double.IsFinite(number))
            return fallback;
        return Math.Max(minimum, Math.Floor(number));
    }

    private static string ArrayString(JsonArray array) =>
        string.Join(
            ",",
            array.Select(item =>
                item is JsonArray nested
                    ? ArrayString(nested)
                    : NodeFileTools.Text(item) ?? item?.ToJsonString() ?? ""
            )
        );

    private static int NativeSize(double value)
    {
        var modulo = value % 4_294_967_296;
        return unchecked((int)(uint)(modulo < 0 ? modulo + 4_294_967_296 : modulo));
    }

    private async Task<JsonObject> Create(JsonObject args)
    {
        var cwd = Path.GetFullPath(Required(args, "cwd"));
        if (!NodeFileTools.Exists(cwd))
            throw new InvalidOperationException("Directory does not exist: " + cwd);
        if (!Directory.Exists(cwd))
            throw new InvalidOperationException("Path is not a directory: " + cwd);
        var id =
            "term_"
            + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            + "_"
            + Guid.NewGuid().ToString("N")[..8];
        var cols = Size(args, "cols", 20, 100);
        var rows = Size(args, "rows", 5, 30);
        var shell = Environment.GetEnvironmentVariable("FOXWARM_NODE_PTY_SHELL");
        if (string.IsNullOrEmpty(shell))
            shell = OperatingSystem.IsWindows()
                ? "powershell.exe"
                : Environment.GetEnvironmentVariable("SHELL");
        if (string.IsNullOrEmpty(shell))
            shell = "/bin/bash";
        Directory.CreateDirectory(directory);
        var code = await helper.RegisterAsync(id);
        var cwdFile = OperatingSystem.IsWindows() ? null : Path.Combine(directory, id + ".cwd.txt");
        var rc =
            cwdFile is not null
            && Path.GetFileName(shell).Contains("bash", StringComparison.Ordinal)
                ? Path.Combine(directory, id + ".bashrc")
                : null;
        try
        {
            if (rc is not null)
            {
                await File.WriteAllTextAsync(rc, BashRc);
                if (OperatingSystem.IsLinux())
                    File.SetUnixFileMode(rc, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            var environment = new Dictionary<string, string>(
                OperatingSystem.IsWindows()
                    ? StringComparer.OrdinalIgnoreCase
                    : StringComparer.Ordinal
            );
            foreach (
                System.Collections.DictionaryEntry item in Environment.GetEnvironmentVariables()
            )
                if (item.Key is string key && item.Value is string value)
                    environment[key] = value;
            environment["TERM"] = "xterm-256color";
            environment["COLORTERM"] = "truecolor";
            foreach (var pair in code.Environment)
                environment[pair.Key] = pair.Value;
            if (cwdFile is not null)
                environment["FOXWARM_TERMINAL_CWD_PATH"] = cwdFile;
            var native = TerminalNative.Handle.Spawn(
                shell,
                rc is not null ? ["--rcfile", rc, "-i"]
                    : OperatingSystem.IsWindows() ? ["-NoLogo"]
                    : ["-i"],
                cwd,
                environment,
                NativeSize(cols),
                NativeSize(rows)
            );
            var record = new Record(
                this,
                id,
                shell,
                cwd,
                cols,
                rows,
                native,
                code.Capability,
                rc,
                cwdFile
            );
            lock (gate)
                terminals.Add(id, record);
            var description = record.Describe();
            record.Start();
            return description;
        }
        catch
        {
            helper.Unregister(code.Capability);
            Delete(rc);
            Delete(cwdFile);
            throw;
        }
    }

    private const string BashRc = """
        if [ -f /etc/bash.bashrc ]; then source /etc/bash.bashrc; fi
        if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc"; fi
        __foxwarm_terminal_sync_cwd() {
          local tmp_path="${FOXWARM_TERMINAL_CWD_PATH}.tmp.$$"
          pwd > "$tmp_path" 2>/dev/null || true
          mv "$tmp_path" "$FOXWARM_TERMINAL_CWD_PATH" 2>/dev/null || true
        }
        PROMPT_COMMAND="__foxwarm_terminal_sync_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
        trap __foxwarm_terminal_sync_cwd EXIT
        """;

    private Record Require(string id) =>
        terminals.GetValueOrDefault(id)
        ?? throw new InvalidOperationException("Terminal not found: " + id);

    private async Task<CodeHelperServer.CodeHelperResult> RequestCode(
        string terminalId,
        string requestId,
        CodeHelperServer.CodeHelperRequest request
    )
    {
        var completion = new TaskCompletionSource<CodeHelperServer.CodeHelperResult>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        lock (gate)
        {
            Require(terminalId);
            if (connection is null || send is null)
                return new(false, null, "No Code terminal is attached to handle this request.");
            if (pending.ContainsKey(requestId))
                return new(false, null, "Code helper request is already pending.");
            pending.Add(requestId, new(terminalId, connection, completion));
            var open = new JsonObject { ["kind"] = request.Kind, ["path"] = request.Path };
            if (request.StartLine is not null)
                open["startLine"] = request.StartLine;
            if (request.StartColumn is not null)
                open["startColumn"] = request.StartColumn;
            _ = send(
                new()
                {
                    ["type"] = "code-request",
                    ["terminalId"] = terminalId,
                    ["requestId"] = requestId,
                    ["request"] = open,
                }
            );
        }
        try
        {
            return await completion.Task.WaitAsync(TimeSpan.FromSeconds(20));
        }
        catch (TimeoutException)
        {
            return new(false, null, "Timed out waiting for an attached Code terminal.");
        }
        finally
        {
            lock (gate)
                pending.Remove(requestId);
        }
    }

    private void Cleanup(Record record)
    {
        lock (gate)
        {
            terminals.Remove(record.Id);
            helper.Unregister(record.Capability);
            foreach (
                var item in pending.Where(item => item.Value.TerminalId == record.Id).ToArray()
            )
            {
                pending.Remove(item.Key);
                item.Value.Completion.TrySetResult(
                    new(false, null, "Terminal closed before Code handled the request.")
                );
            }
        }
        Delete(record.RcFile);
        Delete(record.CwdFile);
    }

    private static void Delete(string? path)
    {
        if (path is null)
            return;
        try
        {
            File.Delete(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    public async ValueTask DisposeAsync()
    {
        Record[] snapshot;
        lock (gate)
            snapshot = terminals.Values.ToArray();
        await Task.WhenAll(snapshot.Select(item => item.Close()));
        await helper.DisposeAsync();
    }

    private sealed class Record(
        NodePtyService service,
        string id,
        string shell,
        string cwd,
        double cols,
        double rows,
        TerminalNative.Handle native,
        string capability,
        string? rcFile,
        string? cwdFile
    )
    {
        internal readonly string Id = id,
            Capability = capability;
        internal readonly string? RcFile = rcFile,
            CwdFile = cwdFile;
        internal readonly TerminalNative.Handle Native = native;
        internal readonly StringBuilder Backlog = new();
        internal readonly long CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        internal double Cols = cols,
            Rows = rows;
        internal object? StreamingOwner;
        private string cwd = cwd;
        private volatile bool closed;
        private bool exited;
        private Task writing = Task.CompletedTask;
        private Task reader = Task.CompletedTask,
            waiter = Task.CompletedTask;
        private Task? closing;

        internal JsonObject Describe()
        {
            if (CwdFile is not null)
                try
                {
                    var tracked = File.ReadAllText(CwdFile).Trim();
                    if (tracked.Length > 0)
                        cwd = tracked;
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            return new()
            {
                ["id"] = Id,
                ["nodeId"] = "",
                ["shell"] = shell,
                ["cwd"] = cwd,
                ["cols"] = Cols,
                ["rows"] = Rows,
                ["createdAt"] = CreatedAt,
                ["pid"] = Native.Pid,
            };
        }

        internal void Start()
        {
            reader = Task.Run(Read);
            waiter = Task.Run(Wait);
        }

        internal Task Write(string data)
        {
            lock (service.gate)
                if (!closed)
                    writing = WriteAfter(writing, data);
            // Like node-pty.write, input accepts the queue, not a synchronous shell read.
            return Task.CompletedTask;
        }

        private async Task WriteAfter(Task previous, string data)
        {
            await previous;
            if (closed)
                return;
            try
            {
                await Task.Run(() => Native.Write(Encoding.UTF8.GetBytes(data)));
            }
            catch (IOException error)
            {
                lock (service.gate)
                    if (!closed && service.send is not null)
                        _ = service.send(
                            new()
                            {
                                ["type"] = "error",
                                ["terminalId"] = Id,
                                ["operation"] = "input",
                                ["error"] = NodeCodeServices.Error(error),
                            }
                        );
            }
        }

        private async Task Read()
        {
            var bytes = new byte[32 * 1024];
            var decoder = Encoding.UTF8.GetDecoder();
            var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
            while (true)
            {
                var count = await Task.Run(() => Native.Read(bytes));
                if (count <= 0)
                    break;
                var used = decoder.GetChars(bytes, 0, (int)count, chars, 0);
                var text = new string(chars, 0, used);
                lock (service.gate)
                {
                    Backlog.Append(text);
                    if (Backlog.Length > 200_000)
                        Backlog.Remove(0, Backlog.Length - 200_000);
                    if (
                        ReferenceEquals(StreamingOwner, service.connection)
                        && StreamingOwner is not null
                        && !closed
                        && service.send is not null
                    )
                        _ = service.send(
                            new()
                            {
                                ["type"] = "output",
                                ["terminalId"] = Id,
                                ["data"] = text,
                            }
                        );
                }
            }
        }

        private async Task Wait()
        {
            var result = await Task.Run(Native.Wait);
            lock (service.gate)
                exited = true;
            try
            {
                await reader.WaitAsync(TimeSpan.FromSeconds(1));
            }
            catch (TimeoutException)
            {
                Native.CancelRead();
                await reader;
            }
            Native.CancelRead();
            Task writes;
            lock (service.gate)
            {
                if (!closed && result.Error == 0 && service.send is not null)
                {
                    var description = Describe();
                    var exited = new JsonObject
                    {
                        ["type"] = "exit",
                        ["terminalId"] = Id,
                        ["exitCode"] = result.Code,
                        ["signal"] = result.Signal,
                    };
                    if (CwdFile is not null)
                        exited["cwd"] = description["cwd"]?.DeepClone();
                    _ = service.send(exited);
                }
                closed = true;
                writes = writing;
            }
            await writes;
            service.Cleanup(this);
            if (result.Error == 0)
                Native.Dispose();
            else
                Console.Error.WriteLine(
                    "Terminal process status was unavailable (errno "
                        + result.Error
                        + "); native ownership was retained."
                );
        }

        internal Task Close()
        {
            lock (service.gate)
                return closed ? waiter : closing ??= CloseCore();
        }

        private async Task CloseCore()
        {
            closed = true;
            Native.CancelRead();
            Signal(1);
            for (var attempt = 0; attempt < 2 && !waiter.IsCompleted; attempt++)
                if (await Task.WhenAny(waiter, Task.Delay(1000)) != waiter)
                    Signal(attempt == 0 ? 15 : 9);
            await waiter;
        }

        private void Signal(int signal)
        {
            lock (service.gate)
            {
                if (exited)
                    return;
                try
                {
                    Native.SignalForeground(signal);
                }
                catch (IOException) { }
                try
                {
                    Native.SignalShell(signal);
                }
                catch (IOException) { }
            }
        }
    }
}
