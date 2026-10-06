using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Terminal;

internal sealed partial class TerminalRegistry : IAsyncDisposable
{
    internal const int BacklogLimit = 200_000;
    internal const int ClientBudget = 2 * 1024 * 1024;
    private readonly string terminalDirectory;
    private readonly SemaphoreSlim creation = new(1, 1);
    private readonly ConcurrentDictionary<string, TerminalRecord> records = new(
        StringComparer.Ordinal
    );
    private readonly CancellationTokenSource stopping;
    private readonly CodeHelperServer helper;

    internal TerminalRegistry(string dataRoot, CancellationToken applicationStopping)
    {
        terminalDirectory = Path.Combine(dataRoot, ".temp", "terminals");
        stopping = CancellationTokenSource.CreateLinkedTokenSource(applicationStopping);
        helper = new CodeHelperServer(dataRoot, HandleCodeRequestAsync);
    }

    internal static bool IsSupported => TerminalNative.IsSupported;

    internal async Task<TerminalRecord> CreateAsync(
        string cwd,
        int cols,
        int rows,
        CancellationToken token
    )
    {
        if (!IsSupported)
            throw new PlatformNotSupportedException(
                "Main terminal PTY is unavailable on this Linux host."
            );
        if (string.IsNullOrWhiteSpace(cwd))
            throw new ArgumentException("cwd is required.");
        var full = Path.GetFullPath(cwd.Trim());
        if (!Directory.Exists(full))
            throw new DirectoryNotFoundException(full);
        cols = Math.Max(20, cols);
        rows = Math.Max(5, rows);
        if (cols > ushort.MaxValue || rows > ushort.MaxValue)
            throw new ArgumentOutOfRangeException(nameof(cols));

        var environment = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry item in Environment.GetEnvironmentVariables())
            if (item.Key is string key && item.Value is string value)
                environment[key] = value;
        environment["TERM"] = "xterm-256color";
        environment["COLORTERM"] = "truecolor";
        var configuredShell = environment.TryGetValue("SHELL", out var configured)
            ? configured.Trim()
            : "";
        var shell =
            configuredShell.Length > 0 && File.Exists(configuredShell)
                ? configuredShell
                : "/bin/bash";
        if (!File.Exists(shell))
            throw new FileNotFoundException("A usable POSIX shell is unavailable.", shell);

        await creation.WaitAsync(token);
        try
        {
            if (stopping.IsCancellationRequested)
                throw new InvalidOperationException("Terminal host is stopping.");
            var id = Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(terminalDirectory);
            var cwdFile = Path.Combine(terminalDirectory, id + ".cwd");
            var rcFile = shell.Contains("bash", StringComparison.Ordinal)
                ? Path.Combine(terminalDirectory, id + ".bashrc")
                : null;
            environment["FOXWARM_TERMINAL_ID"] = id;
            environment["FOXWARM_TERMINAL_CWD_PATH"] = cwdFile;
            var helperInfo = await helper.RegisterAsync(id);
            foreach (var pair in helperInfo.Environment)
                environment[pair.Key] = pair.Value;
            TerminalRecord record;
            try
            {
                if (rcFile is not null)
                    await File.WriteAllTextAsync(rcFile, BashRc);
                if (rcFile is not null && OperatingSystem.IsLinux())
                    File.SetUnixFileMode(rcFile, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                var native = TerminalNative.Handle.Spawn(
                    shell,
                    rcFile is null ? ["-i"] : ["--rcfile", rcFile, "-i"],
                    full,
                    environment,
                    cols,
                    rows
                );
                record = new TerminalRecord(
                    id,
                    full,
                    native,
                    helper,
                    helperInfo.Capability,
                    shell,
                    cols,
                    rows,
                    Remove,
                    cwdFile,
                    rcFile
                );
            }
            catch
            {
                helper.Unregister(helperInfo.Capability);
                if (rcFile is not null)
                    File.Delete(rcFile);
                File.Delete(cwdFile);
                throw;
            }
            records[id] = record;
            record.Start();
            return record;
        }
        finally
        {
            creation.Release();
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

    internal bool TryGet(string id, out TerminalRecord? record) =>
        records.TryGetValue(id, out record);

    internal IReadOnlyList<JsonObject> List() =>
        records
            .Values.OrderByDescending(item => item.CreatedAt)
            .Select(item => item.Describe())
            .ToArray();

    internal async Task CloseAsync(string id, string reason)
    {
        if (records.TryGetValue(id, out var record))
            await record.CloseAsync(reason);
    }

    internal async Task ShutdownAsync()
    {
        await creation.WaitAsync();
        TerminalRecord[] snapshot;
        try
        {
            stopping.Cancel();
            snapshot = records.Values.ToArray();
        }
        finally
        {
            creation.Release();
        }
        await Task.WhenAll(snapshot.Select(item => item.CloseAsync("host-shutdown")));
        await helper.DisposeAsync();
    }

    private void Remove(string id) => records.TryRemove(id, out _);

    private async Task<CodeHelperServer.CodeHelperResult> HandleCodeRequestAsync(
        string terminalId,
        string requestId,
        CodeHelperServer.CodeHelperRequest request
    )
    {
        if (!TryGet(terminalId, out var record) || record is null)
            return new(false, null, "Terminal is no longer available.", requestId);
        var result = await record.HandleCodeRequestAsync(request);
        return result with { RequestId = requestId };
    }

    public async ValueTask DisposeAsync()
    {
        await ShutdownAsync();
        stopping.Dispose();
    }

    internal sealed partial class TerminalRecord : IAsyncDisposable
    {
        private readonly object gate = new();
        private readonly TerminalNative.Handle native;
        private readonly CodeHelperServer helper;
        private readonly string helperCapability;
        private readonly Action<string> remove;
        private readonly List<TerminalClient> clients = [];

        private sealed record PendingControl(
            TerminalClient Owner,
            TaskCompletionSource<CodeHelperServer.CodeHelperResult> Completion
        );

        private readonly Dictionary<string, PendingControl> pendingControls = new();
        private readonly SemaphoreSlim input = new(1, 1);
        private readonly string cwdFile;
        private readonly string? rcFile;
        private readonly StringBuilder backlog = new();
        private readonly CancellationTokenSource lifetime = new();
        private readonly CancellationTokenSource escalationStop = new();
        private Task reader = Task.CompletedTask;
        private Task waiter = Task.CompletedTask;
        private readonly long createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        private Task? escalation;
        private int closed;
        private int waitCompleted;

        internal string Id { get; }
        internal string Cwd { get; private set; }
        internal long CreatedAt => createdAt;
        internal string Shell { get; }
        internal int Cols { get; private set; }
        internal int Rows { get; private set; }

        internal TerminalRecord(
            string id,
            string cwd,
            TerminalNative.Handle native,
            CodeHelperServer helper,
            string helperCapability,
            string shell,
            int cols,
            int rows,
            Action<string> remove,
            string cwdFile,
            string? rcFile
        )
        {
            Id = id;
            Cwd = cwd;
            this.native = native;
            this.helper = helper;
            this.helperCapability = helperCapability;
            this.remove = remove;
            Shell = shell;
            Cols = cols;
            Rows = rows;
            this.cwdFile = cwdFile;
            this.rcFile = rcFile;
        }

        internal void Start()
        {
            reader = Task.Run(ReadLoopAsync);
            waiter = Task.Run(WaitLoopAsync);
        }

        internal JsonObject Describe()
        {
            try
            {
                var cwd = File.ReadAllText(cwdFile).Trim();
                if (cwd.Length > 0)
                    Cwd = cwd;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return new()
            {
                ["id"] = Id,
                ["nodeId"] = "master",
                ["pid"] = native.Pid,
                ["cwd"] = Cwd,
                ["shell"] = Shell,
                ["cols"] = Cols,
                ["rows"] = Rows,
                ["createdAt"] = createdAt,
            };
        }

        internal async Task<TerminalClient> AttachAsync(
            WebSocket socket,
            CancellationToken token,
            bool controlOwner
        )
        {
            var client = new TerminalClient(socket, this, token, controlOwner);
            lock (gate)
            {
                if (closed != 0)
                    throw new InvalidOperationException("Terminal has exited.");
                client.Enqueue(
                    new
                    {
                        type = "ready",
                        terminal = Describe(),
                        backlog = backlog.ToString(),
                    }
                );
                clients.Add(client);
            }
            await client.StartAsync();
            return client;
        }

        internal void Detach(TerminalClient client)
        {
            lock (gate)
            {
                clients.Remove(client);
                foreach (
                    var pair in pendingControls.Where(pair => pair.Value.Owner == client).ToArray()
                )
                {
                    pendingControls.Remove(pair.Key);
                    pair.Value.Completion.TrySetResult(
                        new(false, null, "The Code terminal detached before handling the request.")
                    );
                }
            }
        }

        internal async Task InputAsync(string text)
        {
            if (text.Length == 0)
                return;
            if (Encoding.UTF8.GetByteCount(text) > 64 * 1024)
                throw new InvalidDataException("Terminal input is too large.");
            await input.WaitAsync();
            try
            {
                if (closed == 0)
                    await Task.Run(() => native.Write(Encoding.UTF8.GetBytes(text)));
            }
            finally
            {
                input.Release();
            }
        }

        internal void Resize(int cols, int rows)
        {
            cols = Math.Max(20, cols);
            rows = Math.Max(5, rows);
            if (cols > ushort.MaxValue || rows > ushort.MaxValue)
                throw new ArgumentOutOfRangeException(nameof(cols));
            lock (gate)
            {
                if (closed != 0)
                    return;
                native.Resize(cols, rows);
            }
            lock (gate)
            {
                Cols = cols;
                Rows = rows;
            }
        }

        internal async Task CloseAsync(string reason)
        {
            if (Interlocked.Exchange(ref closed, 1) == 0)
            {
                native.CancelRead();
                try
                {
                    native.SignalForeground(1);
                }
                catch { }
                try
                {
                    native.SignalShell(1);
                }
                catch { }
                escalation = Task.Run(async () =>
                {
                    try
                    {
                        await Task.Delay(TimeSpan.FromSeconds(1), escalationStop.Token);
                        if (Volatile.Read(ref waitCompleted) != 0)
                            return;
                        try
                        {
                            native.SignalForeground(15);
                        }
                        catch { }
                        try
                        {
                            native.SignalShell(15);
                        }
                        catch { }
                        await Task.Delay(TimeSpan.FromSeconds(1), escalationStop.Token);
                        if (Volatile.Read(ref waitCompleted) != 0)
                            return;
                        try
                        {
                            native.SignalForeground(9);
                        }
                        catch { }
                        try
                        {
                            native.SignalShell(9);
                        }
                        catch { }
                    }
                    catch (OperationCanceledException) { }
                });
            }
            await waiter;
        }

        internal async Task<CodeHelperServer.CodeHelperResult> HandleCodeRequestAsync(
            CodeHelperServer.CodeHelperRequest request
        )
        {
            var requestId = Guid.NewGuid().ToString("N");
            var completion = new TaskCompletionSource<CodeHelperServer.CodeHelperResult>(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            lock (gate)
            {
                var owner = clients.LastOrDefault(item => item.IsControlOwner);
                if (owner is null || closed != 0)
                    return new(false, null, "No Code terminal is attached to handle this request.");
                pendingControls[requestId] = new(owner, completion);
                owner.Enqueue(
                    new
                    {
                        type = "control",
                        requestId,
                        command = "open",
                        request = new
                        {
                            kind = request.Kind,
                            nodeId = "master",
                            path = request.Path,
                            startLine = request.StartLine,
                            startColumn = request.StartColumn,
                        },
                    }
                );
            }
            try
            {
                return await completion.Task.WaitAsync(TimeSpan.FromSeconds(20));
            }
            catch (TimeoutException)
            {
                return new(
                    false,
                    null,
                    "Timed out waiting for the attached Code terminal.",
                    requestId
                );
            }
            finally
            {
                lock (gate)
                    pendingControls.Remove(requestId);
            }
        }

        private void ResolveControl(
            TerminalClient client,
            string requestId,
            bool ok,
            string? message,
            string? error
        )
        {
            lock (gate)
            {
                if (
                    !pendingControls.TryGetValue(requestId, out var pending)
                    || pending.Owner != client
                )
                    throw new InvalidDataException(
                        "Unknown or unauthorized terminal control response."
                    );
                pendingControls.Remove(requestId);
                pending.Completion.TrySetResult(new(ok, message, error, requestId));
            }
        }

        private async Task ReadLoopAsync()
        {
            var bytes = new byte[32 * 1024];
            var decoder = Encoding.UTF8.GetDecoder();
            var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
            while (!lifetime.IsCancellationRequested)
            {
                long count;
                try
                {
                    count = await Task.Run(() => native.Read(bytes), lifetime.Token);
                }
                catch
                {
                    break;
                }
                if (count == 0 || count == -5 || count == -125)
                    break;
                if (count < 0)
                    throw new IOException($"Terminal output failed (errno {-count}).");
                decoder.Convert(
                    bytes,
                    0,
                    checked((int)count),
                    chars,
                    0,
                    chars.Length,
                    false,
                    out _,
                    out var charsUsed,
                    out _
                );
                var text = new string(chars, 0, charsUsed);
                TerminalClient[] snapshot;
                lock (gate)
                {
                    backlog.Append(text);
                    if (backlog.Length > BacklogLimit)
                        backlog.Remove(0, backlog.Length - BacklogLimit);
                    snapshot = clients.ToArray();
                    foreach (var client in snapshot)
                        client.Enqueue(new { type = "output", data = text });
                }
            }
        }

        private async Task WaitLoopAsync()
        {
            var result = await Task.Run(native.Wait);
            Volatile.Write(ref waitCompleted, 1);
            escalationStop.Cancel();
            if (escalation is not null)
                await escalation;
            // Drain bytes already emitted at natural exit, without waiting forever on
            // a descendant that retained the slave. Explicit close cancels IO first.
            try
            {
                await reader.WaitAsync(TimeSpan.FromSeconds(1));
            }
            catch (TimeoutException)
            {
                native.CancelRead();
                await reader;
            }
            catch (IOException error)
            {
                Console.Error.WriteLine(error.Message);
            }
            native.CancelRead();
            await input.WaitAsync();
            try
            {
                TerminalClient[] snapshot;
                lock (gate)
                {
                    closed = 1;
                    snapshot = clients.ToArray();
                    foreach (var pending in pendingControls.Values)
                        pending.Completion.TrySetResult(
                            new(false, null, "Terminal closed before Code handled the request.")
                        );
                    pendingControls.Clear();
                    foreach (var client in snapshot)
                    {
                        if (result.Error == 0)
                            client.Enqueue(
                                new
                                {
                                    type = "exit",
                                    exitCode = result.Signal == 0
                                        ? result.Code
                                        : 128 + result.Signal,
                                    signal = result.Signal,
                                }
                            );
                        else
                            client.Enqueue(
                                new
                                {
                                    type = "error",
                                    message = $"Terminal process status was unavailable (errno {result.Error}).",
                                }
                            );
                    }
                }
                await Task.WhenAll(snapshot.Select(client => client.FinishAsync()));
                helper.Unregister(helperCapability);
                remove(Id);
                if (rcFile is not null)
                    File.Delete(rcFile);
                File.Delete(cwdFile);
                if (result.Error == 0)
                {
                    native.Dispose();
                }
                else
                {
                    // Do not fabricate an exit status or hide a native ownership
                    // failure. Keep the closed record visible for diagnostics and
                    // intentionally retain the native handle for this unsupported
                    // recovery boundary.
                    Console.Error.WriteLine(
                        $"Terminal wait failed (errno {result.Error}); native ownership was retained."
                    );
                }
            }
            finally
            {
                input.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            await CloseAsync("dispose");
            lifetime.Dispose();
            escalationStop.Dispose();
        }
    }
}
