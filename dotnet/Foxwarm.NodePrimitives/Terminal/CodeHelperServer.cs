using System.IO.Pipes;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Terminal;

internal sealed class CodeHelperServer : IAsyncDisposable
{
    private readonly string stateRoot;
    private readonly Func<string, string> transportPath;
    private readonly SemaphoreSlim start = new(1, 1);
    private readonly Func<string, string, CodeHelperRequest, Task<CodeHelperResult>> request;
    private readonly Dictionary<string, string> capabilities = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private Socket? listener;
    private CancellationTokenSource? pipeStop;
    private Task pipeAccept = Task.CompletedTask;
    private string? socketPath;
    private string? helperDirectory;
    private int closed;

    internal CodeHelperServer(
        string stateRoot,
        Func<string, string, CodeHelperRequest, Task<CodeHelperResult>> request,
        Func<string, string>? transportPath = null
    )
    {
        this.stateRoot = stateRoot;
        this.request = request;
        this.transportPath = transportPath ?? (path => path);
    }

    internal async Task<(string Capability, Dictionary<string, string> Environment)> RegisterAsync(
        string terminalId
    )
    {
        await StartAsync();
        var capability = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        lock (gate)
            capabilities[capability] = terminalId;
        var directory = helperDirectory!;
        return (
            capability,
            new Dictionary<string, string>
            {
                ["FOXWARM_CODE_IPC"] = socketPath!,
                ["FOXWARM_CODE_CAPABILITY"] = capability,
                ["PATH"] =
                    Path.Combine(directory, "bin")
                    + Path.PathSeparator
                    + (Environment.GetEnvironmentVariable("PATH") ?? ""),
            }
        );
    }

    internal void Unregister(string? capability)
    {
        if (capability is not null)
            lock (gate)
                capabilities.Remove(capability);
    }

    private async Task StartAsync()
    {
        await start.WaitAsync();
        try
        {
        if (Volatile.Read(ref closed) != 0)
            throw new ObjectDisposedException(nameof(CodeHelperServer));
        if (listener is not null || pipeStop is not null)
            return;
        helperDirectory = Path.Combine(stateRoot, ".temp", $"code-helper-{Environment.ProcessId}");
        Directory.CreateDirectory(helperDirectory);
        var bin = Path.Combine(helperDirectory, "bin");
        Directory.CreateDirectory(bin);
        await WriteWrapperAsync(Path.Combine(bin, OperatingSystem.IsWindows() ? "code.ps1" : "code"));
        if (OperatingSystem.IsWindows())
        {
            socketPath = $"foxwarm-code-{Environment.ProcessId}-{Guid.NewGuid():N}";
            pipeStop = new CancellationTokenSource();
            pipeAccept = AcceptPipeLoopAsync(pipeStop.Token);
            return;
        }
        socketPath = Path.Combine(Path.GetTempPath(), $"foxwarm-code-{Environment.ProcessId}.sock");
        try
        {
            File.Delete(socketPath);
        }
        catch { }
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        socket.Bind(new UnixDomainSocketEndPoint(socketPath));
        socket.Listen(16);
        listener = socket;
        if (OperatingSystem.IsLinux())
            File.SetUnixFileMode(socketPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        _ = AcceptLoopAsync(socket);
        await Task.CompletedTask;
        }
        finally { start.Release(); }
    }

    private async Task WriteWrapperAsync(string path)
    {
        var process =
            Environment.ProcessPath
            ?? throw new InvalidOperationException("Process path is unavailable.");
        var assembly = Environment.GetCommandLineArgs()[0];
        if (OperatingSystem.IsWindows())
        {
            var prefix = Path.GetFileNameWithoutExtension(process)
                .Equals("dotnet", StringComparison.OrdinalIgnoreCase)
                ? $"{PsQuote(process)} {PsQuote(assembly)}"
                : PsQuote(process);
            // The pipeline waits for a GUI-subsystem Desktop helper as well as a console host.
            await File.WriteAllTextAsync(
                path,
                $"& {prefix} --code-helper @args | Out-Host\nif ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}\n",
                new UTF8Encoding(true)
            );
            var cmd = Path.ChangeExtension(path, ".cmd");
            await File.WriteAllTextAsync(
                cmd,
                $"@echo off\r\n\"{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe")}\" -NoProfile -ExecutionPolicy Bypass -File \"%~dp0code.ps1\" %*\r\n"
            );
            return;
        }
        var launcher = Path.GetFileNameWithoutExtension(process)
            .Equals("dotnet", StringComparison.OrdinalIgnoreCase)
            ? $"exec {ShQuote(process)} {ShQuote(assembly)} --code-helper"
            : $"exec {ShQuote(process)} --code-helper";
        await File.WriteAllTextAsync(path, "#!/bin/sh\n" + launcher + " \"$@\"\n");
        if (OperatingSystem.IsLinux())
            File.SetUnixFileMode(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
    }

    private static string PsQuote(string value) =>
        "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    private async Task AcceptPipeLoopAsync(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                var pipe = new NamedPipeServerStream(
                    socketPath!,
                    PipeDirection.InOut,
                    16,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly
                );
                try
                {
                    await pipe.WaitForConnectionAsync(token);
                }
                catch
                {
                    await pipe.DisposeAsync();
                    throw;
                }
                _ = HandleStreamAsync(pipe);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private static string ShQuote(string value) =>
        "'" + value.Replace("'", "'\\''", StringComparison.Ordinal) + "'";

    private async Task AcceptLoopAsync(Socket socket)
    {
        try
        {
            while (Volatile.Read(ref closed) == 0)
            {
                var client = await socket.AcceptAsync();
                _ = HandleAsync(client);
            }
        }
        catch (ObjectDisposedException) { }
        catch (SocketException) when (Volatile.Read(ref closed) != 0) { }
    }

    private Task HandleAsync(Socket client) =>
        HandleStreamAsync(new NetworkStream(client, ownsSocket: true));

    private async Task HandleStreamAsync(Stream connection)
    {
        await using var stream = connection;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        string? line;
        try
        {
            line = await ReadLineBoundedAsync(stream, 64 * 1024, timeout.Token);
        }
        catch
        {
            return;
        }
        JsonObject? wire;
        try { wire = JsonNode.Parse(line ?? "") as JsonObject; }
        catch { wire = null; }
        var requestId = Text(wire?["requestId"]) ?? "";
        CodeHelperResult result;
        try
        {
            if (wire is null || !(wire["version"] is JsonValue version && version.TryGetValue<double>(out var number) && number == 1) || requestId.Length == 0)
                throw new InvalidOperationException("Unsupported Foxwarm code helper protocol request.");
            string? terminalId;
            lock (gate)
                capabilities.TryGetValue(Text(wire["capability"]) ?? "", out terminalId);
            if (terminalId is null)
                throw new InvalidOperationException("Foxwarm Code helper capability is invalid or expired.");
            if (Text(wire["cwd"]) is not { } cwd || !Path.IsPathFullyQualified(cwd)
                || wire["args"] is not JsonArray arguments || arguments.Any(arg => Text(arg) is null))
                throw new InvalidOperationException("Foxwarm code helper cwd/args are invalid.");
            var parsed = Resolve(cwd, arguments.Select(arg => Text(arg)!).ToArray());
            result = await request(terminalId, requestId, parsed);
        }
        catch (Exception error)
        {
            result = new(false, null, error.Message);
        }
        try
        {
            var response = Encoding.UTF8.GetBytes(ResultJson(result, requestId).ToJsonString() + "\n");
            await SendAllAsync(stream, response, timeout.Token);
        }
        catch { }
    }

    internal static async Task<string?> ReadLineBoundedAsync(
        Stream stream,
        int limit,
        CancellationToken token
    )
    {
        var bytes = new List<byte>(Math.Min(limit, 4096));
        var one = new byte[1];
        while (true)
        {
            var count = await stream.ReadAsync(one, token);
            if (count == 0)
                return bytes.Count == 0 ? null : Encoding.UTF8.GetString(bytes.ToArray());
            if (one[0] == (byte)'\n')
                return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd('\r');
            if (bytes.Count == limit)
                throw new InvalidDataException("Foxwarm Code helper request exceeds 64 KiB.");
            bytes.Add(one[0]);
        }
    }

    private static async Task SendAllAsync(Stream stream, byte[] bytes, CancellationToken token)
    {
        var offset = 0;
        while (offset < bytes.Length)
        {
            var count = Math.Min(8192, bytes.Length - offset);
            await stream.WriteAsync(bytes.AsMemory(offset, count), token);
            offset += count;
        }
    }

    private CodeHelperRequest Resolve(string cwd, string[] args)
    {
        if (!Path.IsPathRooted(cwd))
            throw new InvalidOperationException("Code helper cwd must be absolute.");
        bool add = false,
            go = false;
        string? target = null;
        var endOptions = false;
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (!endOptions && arg == "--")
            {
                endOptions = true;
                continue;
            }
            if (!endOptions && arg is "--reuse-window" or "-r")
                continue;
            if (!endOptions && arg is "--add")
            {
                add = true;
                if (target is not null)
                    throw new InvalidOperationException("Foxwarm code helper accepts one path at a time.");
                target = args.ElementAtOrDefault(++i);
                if (string.IsNullOrEmpty(target)) throw new InvalidOperationException("--add requires a folder path.");
                continue;
            }
            if (!endOptions && arg is "--goto" or "-g")
            {
                go = true;
                if (target is not null)
                    throw new InvalidOperationException("Foxwarm code helper accepts one path at a time.");
                target = args.ElementAtOrDefault(++i);
                if (string.IsNullOrEmpty(target)) throw new InvalidOperationException($"{arg} requires <file>:<line>[:<column>].");
                continue;
            }
            if (!endOptions && arg.StartsWith("-", StringComparison.Ordinal))
                throw new InvalidOperationException("Unsupported Foxwarm Code option.");
            if (target is not null)
                throw new InvalidOperationException(
                    "Foxwarm Code helper accepts one path at a time."
                );
            target = arg;
        }
        if (string.IsNullOrEmpty(target))
            throw new InvalidOperationException(
                "Usage: code [--add <folder> | --goto <file>:<line>[:column] | <path>]"
            );
        long? line = null,
            column = null;
        if (go)
        {
            var match = System.Text.RegularExpressions.Regex.Match(
                target,
                "^(.*?):(\\d+)(?::(\\d+))?$"
            );
            if (!match.Success || match.Groups[1].Value.Length == 0)
                throw new InvalidOperationException("Use --goto <file>:<line>[:column].");
            target = match.Groups[1].Value;
            line = ParseLocation(match.Groups[2].Value);
            column = match.Groups[3].Success ? ParseLocation(match.Groups[3].Value) : null;
        }
        var path = Path.GetFullPath(target, cwd);
        var info = new FileInfo(path);
        if (!info.Exists && !Directory.Exists(path))
            throw new InvalidOperationException($"Path does not exist: {path}");
        if (add && !Directory.Exists(path))
            throw new InvalidOperationException("--add requires a directory.");
        if (go && !add && Directory.Exists(path))
            throw new InvalidOperationException("--goto requires a file.");
        return new(
            add || Directory.Exists(path) ? "addFolder" : "openFile",
            transportPath(path),
            add ? null : line,
            add ? null : column
        );
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref closed, 1) != 0)
            return;
        pipeStop?.Cancel();
        await pipeAccept;
        pipeStop?.Dispose();
        listener?.Dispose();
        listener = null;
        lock (gate)
            capabilities.Clear();
        if (socketPath is not null && !OperatingSystem.IsWindows())
            try
            {
                File.Delete(socketPath);
            }
            catch { }
        if (helperDirectory is not null)
            try
            {
                Directory.Delete(helperDirectory, true);
            }
            catch { }
        await Task.CompletedTask;
    }

    internal sealed record CodeHelperRequest(
        string Kind,
        string Path,
        long? StartLine,
        long? StartColumn
    );

    internal sealed record CodeHelperResult(
        bool Ok,
        string? Message,
        string? Error,
        string RequestId = ""
    );

    private static long ParseLocation(string value)
    {
        if (!long.TryParse(value, out var location) || location < 1 || location > 9_007_199_254_740_991)
            throw new InvalidOperationException("Line and column must be positive integers.");
        return location;
    }

    internal static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static JsonObject ResultJson(CodeHelperResult result, string requestId) => new()
    {
        ["requestId"] = requestId, ["ok"] = result.Ok, ["message"] = result.Message, ["error"] = result.Error,
    };

}

internal static class CodeHelperClient
{

    internal static async Task<bool> TryRunAsync(string[] args)
    {
        if (args.Length == 0 || args[0] != "--code-helper")
            return false;
        if (args.Skip(1).Any(arg => arg is "--help" or "-h"))
        {
            Console.WriteLine(
                "Foxwarm Code helper: code <file> | --add <folder> | --goto <file>:<line>[:column]"
            );
            return true;
        }
        if (args.Skip(1).Any(arg => arg is "--version" or "-v"))
        {
            Console.WriteLine("foxwarm-code-helper 1");
            return true;
        }
        var socketPath = Environment.GetEnvironmentVariable("FOXWARM_CODE_IPC");
        var capability = Environment.GetEnvironmentVariable("FOXWARM_CODE_CAPABILITY");
        if (string.IsNullOrWhiteSpace(socketPath) || string.IsNullOrWhiteSpace(capability))
            throw new InvalidOperationException(
                "Foxwarm Code helper is only available inside a Foxwarm terminal."
            );
        var cwd = Environment.CurrentDirectory;
        var requestId = Guid.NewGuid().ToString("N");
        var payload = new JsonObject
        {
            ["version"] = 1, ["requestId"] = requestId, ["capability"] = capability,
            ["cwd"] = cwd, ["args"] = new JsonArray(args.Skip(1).Select(arg => (JsonNode?)JsonValue.Create(arg)).ToArray()),
        }.ToJsonString() + "\n";
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        Stream connection;
        if (OperatingSystem.IsWindows())
        {
            var pipe = new NamedPipeClientStream(
                ".",
                socketPath,
                PipeDirection.InOut,
                PipeOptions.Asynchronous
            );
            try
            {
                await pipe.ConnectAsync(timeout.Token);
            }
            catch
            {
                pipe.Dispose();
                throw;
            }
            connection = pipe;
        }
        else
        {
            var socket = new Socket(
                AddressFamily.Unix,
                SocketType.Stream,
                ProtocolType.Unspecified
            );
            try
            {
                await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), timeout.Token);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
            connection = new NetworkStream(socket, ownsSocket: true);
        }
        await using var stream = connection;
        await stream.WriteAsync(Encoding.UTF8.GetBytes(payload), timeout.Token);
        await stream.FlushAsync(timeout.Token);
        var line = await CodeHelperServer.ReadLineBoundedAsync(stream, 64 * 1024, timeout.Token);
        var result = JsonNode.Parse(line ?? "") as JsonObject
            ?? throw new InvalidOperationException("Invalid response from Foxwarm Code bridge.");
        if (CodeHelperServer.Text(result["requestId"]) != requestId)
            throw new InvalidOperationException("Invalid response from Foxwarm Code bridge.");
        if (result["ok"]?.ToJsonString() != "true")
            throw new InvalidOperationException(CodeHelperServer.Text(result["error"]) ?? "Foxwarm Code request failed.");
        if (CodeHelperServer.Text(result["message"]) is { Length: > 0 } message)
            Console.WriteLine(message);
        return true;
    }
}
