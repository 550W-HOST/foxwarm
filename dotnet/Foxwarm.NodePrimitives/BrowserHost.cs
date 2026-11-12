using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm;

// What the managed browser host can do on this machine. `Tools` is the shared browser_* contract
// printed by the host itself; it is empty when no usable node/bundle exists.
internal sealed record BrowserHostDescription(JsonArray Tools, bool Available, string? Reason);

// The managed headless browser is implemented once, in JavaScript. This class runs it as a child
// `node` process and speaks its line protocol. It never automates a browser itself, and the host
// exits with the process that started it when this side closes the pipe.
internal sealed class BrowserHost(string bundlePath, string? nodeExecutable = null)
    : IAsyncDisposable
{
    internal const string BundleName = "browser-host.bundle.cjs";
    internal static readonly TimeSpan CallDeadline = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan Grace = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan RetryUnavailableAfter = TimeSpan.FromSeconds(30);
    private static readonly ConcurrentDictionary<
        string,
        (BrowserHostDescription Description, DateTime At)
    > descriptions = new();

    private readonly object gate = new();
    private IHostConnection? connection;
    private long nextId;
    private bool disposed;

    // Tests substitute the child-process connection to control the order of frames and replies.
    internal Func<IHostConnection>? ConnectionFactory { get; init; }

    // The bundle sits beside the Main publish layout or beside a standalone CLI executable.
    internal static string DefaultBundlePath()
    {
        var root = AppContext.BaseDirectory;
        var candidates = new[]
        {
            Path.Combine(root, "packages", "browser-host", "dist", BundleName),
            Path.Combine(root, BundleName),
        };
        return candidates.FirstOrDefault(File.Exists) ?? candidates[0];
    }

    // Desktop and service processes often start without the user's shell PATH (macOS app
    // bundles, Windows services), so conventional install locations follow PATH.
    private static IEnumerable<string> ConventionalNodeDirectories()
    {
        if (OperatingSystem.IsWindows())
        {
            foreach (
                var folder in new[]
                {
                    Environment.SpecialFolder.ProgramFiles,
                    Environment.SpecialFolder.ProgramFilesX86,
                }
            )
            {
                var root = Environment.GetFolderPath(folder);
                if (root.Length > 0)
                    yield return Path.Combine(root, "nodejs");
            }
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (local.Length > 0)
                yield return Path.Combine(local, "Programs", "nodejs");
            yield break;
        }
        yield return "/opt/homebrew/bin";
        yield return "/usr/local/bin";
        yield return "/opt/local/bin";
        yield return "/usr/bin";
        yield return "/snap/bin";
    }

    internal static string? FindNode() =>
        FindExecutable("node", ConventionalNodeDirectories());

    internal static string? FindExecutable(
        string name,
        IEnumerable<string>? fallbackDirectories = null
    )
    {
        var names =
            OperatingSystem.IsWindows() && !name.Contains('.') ? new[] { name + ".exe" } : [name];
        var directories = (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Concat(fallbackDirectories ?? []);
        foreach (var directory in directories)
        foreach (var candidate in names)
        {
            try
            {
                var path = Path.Combine(directory.Trim('"'), candidate);
                if (!File.Exists(path))
                    continue;
                if (
                    OperatingSystem.IsWindows()
                    || (File.GetUnixFileMode(path) & UnixFileMode.UserExecute) != 0
                )
                    return path;
            }
            catch (Exception error) when (error is ArgumentException or IOException) { }
        }
        return null;
    }

    private string? ResolveNode() => nodeExecutable ?? FindNode();

    private string? MissingRuntime()
    {
        if (!File.Exists(bundlePath))
            return "The browser host is not installed with this build.";
        if (ResolveNode() is null)
            return "Browser tools need Node.js installed; none was found.";
        return null;
    }

    // Asks the host once (cached) which tools it has and whether a Chromium is installed. A
    // negative answer is retried after a short delay so installing a browser needs no restart.
    internal BrowserHostDescription Describe()
    {
        var key = bundlePath + "\n" + (nodeExecutable ?? "");
        if (
            descriptions.TryGetValue(key, out var known)
            && (known.Description.Available || DateTime.UtcNow - known.At < RetryUnavailableAfter)
        )
            return known.Description;
        var fresh = Probe();
        descriptions[key] = (fresh, DateTime.UtcNow);
        return fresh;
    }

    private BrowserHostDescription Probe()
    {
        var empty = new JsonArray();
        if (MissingRuntime() is { } missing)
            return new(empty, false, missing);
        try
        {
            using var process = Process.Start(Start("--describe"))!;
            process.StandardInput.Close();
            var output = process.StandardOutput.ReadToEndAsync();
            if (!process.WaitForExit(15000))
            {
                process.Kill(entireProcessTree: true);
                return new(empty, false, "The browser host did not answer.");
            }
            var parsed = JsonNode.Parse(output.GetAwaiter().GetResult()) as JsonObject;
            if (parsed?["tools"] is not JsonArray tools)
                return new(empty, false, "The browser host returned no tool contract.");
            var available = parsed["available"]?.GetValue<bool>() == true;
            return new(tools, available, parsed["reason"]?.GetValue<string>());
        }
        catch (Exception error)
            when (error
                    is System.ComponentModel.Win32Exception
                        or InvalidOperationException
                        or IOException
                        or System.Text.Json.JsonException
            )
        {
            return new(empty, false, "The browser host could not start: " + error.Message);
        }
    }

    private ProcessStartInfo Start(params string[] arguments)
    {
        var info = new ProcessStartInfo(ResolveNode()!)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = new UTF8Encoding(false),
            WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(bundlePath)) ?? "",
        };
        info.ArgumentList.Add(Path.GetFullPath(bundlePath));
        foreach (var argument in arguments)
            info.ArgumentList.Add(argument);
        return info;
    }

    // Runs one tool call. Cancelling `token` (Session Stop) cancels the host's call too.
    internal async Task<JsonNode?> CallAsync(string tool, JsonObject args, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var active = Connect();
        var id = Interlocked.Increment(ref nextId);
        var pending = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        active.Add(id, pending);
        try
        {
            await active.Send(
                new JsonObject
                {
                    ["id"] = id,
                    ["tool"] = tool,
                    ["args"] = args.DeepClone(),
                    ["deadlineMs"] = (long)CallDeadline.TotalMilliseconds,
                }
            );
            // The call is cancelled from the caller's side first. The host answers a cancel with an
            // error reply, and that reply must never get the chance to complete the call before
            // the cancellation does; the cancel line is still sent so the host aborts the page.
            using var stop = token.Register(() =>
            {
                pending.TrySetCanceled(token);
                _ = active.TrySend(new JsonObject { ["cancel"] = id });
            });
            // The host enforces the deadline itself; this only covers a host that stopped answering.
            using var wedged = new CancellationTokenSource(CallDeadline + Grace);
            using var watchdog = wedged.Token.Register(() =>
            {
                pending.TrySetException(
                    new InvalidOperationException("The browser host stopped answering.")
                );
                active.Kill();
            });
            JsonObject reply;
            try
            {
                reply = await pending.Task;
            }
            catch (InvalidOperationException) when (token.IsCancellationRequested)
            {
                // The host went away while the caller was cancelling: still a cancellation.
                throw new OperationCanceledException(token);
            }
            if (reply["ok"]?.GetValue<bool>() == true)
                return reply["result"]?.DeepClone();
            // A failed reply to a caller that has been cancelled is the cancellation's echo.
            token.ThrowIfCancellationRequested();
            throw new InvalidOperationException(
                reply["error"]?.GetValue<string>() ?? "Browser call failed."
            );
        }
        finally
        {
            active.Remove(id);
        }
    }

    private IHostConnection Connect()
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (connection is { Exited: false } live)
                return live;
            if (ConnectionFactory is null && MissingRuntime() is { } missing)
                throw new InvalidOperationException(missing);
            if (connection is not null)
                _ = connection.Close();
            connection = ConnectionFactory?.Invoke() ?? new Connection(Process.Start(Start())!);
            return connection;
        }
    }

    public async ValueTask DisposeAsync()
    {
        IHostConnection? last;
        lock (gate)
        {
            disposed = true;
            last = connection;
            connection = null;
        }
        if (last is not null)
            await last.Close();
    }

    // The line-protocol connection to one host process.
    internal interface IHostConnection
    {
        bool Exited { get; }
        void Add(long id, TaskCompletionSource<JsonObject> waiting);
        void Remove(long id);
        Task Send(JsonObject message);
        Task TrySend(JsonObject message);
        void Kill();
        Task Close();
    }

    private sealed class Connection : IHostConnection
    {
        private readonly Process process;
        private readonly object gate = new();
        private readonly SemaphoreSlim writer = new(1, 1);
        private readonly Dictionary<long, TaskCompletionSource<JsonObject>> pending = new();
        private readonly StringBuilder diagnostics = new();
        private readonly Task reading;

        internal Connection(Process process)
        {
            this.process = process;
            _ = Task.Run(async () =>
            {
                try
                {
                    while (await process.StandardError.ReadLineAsync() is { } line)
                        lock (diagnostics)
                        {
                            diagnostics.AppendLine(line);
                            if (diagnostics.Length > 4096)
                                diagnostics.Remove(0, diagnostics.Length - 4096);
                        }
                }
                catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            });
            reading = Task.Run(Read);
        }

        public bool Exited { get; private set; }

        private async Task Read()
        {
            try
            {
                while (await process.StandardOutput.ReadLineAsync() is { } line)
                {
                    JsonObject? message;
                    try
                    {
                        message = JsonNode.Parse(line) as JsonObject;
                    }
                    catch (System.Text.Json.JsonException)
                    {
                        continue;
                    }
                    if (message?["id"]?.GetValue<long>() is not long id)
                        continue;
                    TaskCompletionSource<JsonObject>? waiting;
                    lock (gate)
                        pending.TryGetValue(id, out waiting);
                    waiting?.TrySetResult(message);
                }
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            Exited = true;
            string tail;
            lock (diagnostics)
                tail = diagnostics.ToString().Trim();
            var failure = new InvalidOperationException(
                "The browser host stopped unexpectedly." + (tail.Length > 0 ? " " + tail : "")
            );
            TaskCompletionSource<JsonObject>[] orphaned;
            lock (gate)
                orphaned = pending.Values.ToArray();
            foreach (var waiting in orphaned)
                waiting.TrySetException(failure);
        }

        public void Add(long id, TaskCompletionSource<JsonObject> waiting)
        {
            lock (gate)
                pending[id] = waiting;
        }

        public void Remove(long id)
        {
            lock (gate)
                pending.Remove(id);
        }

        public async Task Send(JsonObject message)
        {
            await writer.WaitAsync();
            try
            {
                await process.StandardInput.WriteLineAsync(message.ToJsonString());
                await process.StandardInput.FlushAsync();
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException)
            {
                throw new InvalidOperationException(
                    "The browser host is not running.",
                    error
                );
            }
            finally
            {
                writer.Release();
            }
        }

        public async Task TrySend(JsonObject message)
        {
            try
            {
                await Send(message);
            }
            catch (InvalidOperationException) { }
        }

        public void Kill()
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (Exception error)
                when (error is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        }

        // Closing the pipe is the shutdown signal: the host closes its browser and exits.
        public async Task Close()
        {
            try
            {
                process.StandardInput.Close();
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try
            {
                await process.WaitForExitAsync(limit.Token);
            }
            catch (OperationCanceledException)
            {
                Kill();
            }
            await reading;
            process.Dispose();
        }
    }
}
