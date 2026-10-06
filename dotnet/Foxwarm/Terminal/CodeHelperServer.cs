using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Foxwarm.Terminal;

internal sealed class CodeHelperServer : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string stateRoot;
    private readonly Func<string, string, CodeHelperRequest, Task<CodeHelperResult>> request;
    private readonly Dictionary<string, string> capabilities = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private Socket? listener;
    private string? socketPath;
    private string? helperDirectory;
    private int closed;

    internal CodeHelperServer(
        string stateRoot,
        Func<string, string, CodeHelperRequest, Task<CodeHelperResult>> request
    )
    {
        this.stateRoot = stateRoot;
        this.request = request;
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
        Directory.CreateDirectory(Path.Combine(directory, "bin"));
        var path = Path.Combine(directory, "bin", "code");
        if (!File.Exists(path))
            await WriteWrapperAsync(path);
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
        if (listener is not null)
            return;
        lock (gate)
            if (listener is not null)
                return;
        helperDirectory = Path.Combine(stateRoot, ".temp", $"code-helper-{Environment.ProcessId}");
        Directory.CreateDirectory(helperDirectory);
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

    private async Task WriteWrapperAsync(string path)
    {
        var process =
            Environment.ProcessPath
            ?? throw new InvalidOperationException("Main process path is unavailable.");
        var assembly = typeof(CodeHelperServer).Assembly.Location;
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

    private async Task HandleAsync(Socket client)
    {
        await using var stream = new NetworkStream(client, ownsSocket: true);
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
        CodeHelperWire? wire;
        try
        {
            wire = line is null
                ? null
                : JsonSerializer.Deserialize<CodeHelperWire>(line, JsonOptions);
        }
        catch
        {
            wire = null;
        }
        CodeHelperResult result;
        try
        {
            if (wire is null || wire.Version != 1 || string.IsNullOrWhiteSpace(wire.RequestId))
                throw new InvalidOperationException("Invalid Foxwarm Code helper request.");
            string? terminalId;
            lock (gate)
                capabilities.TryGetValue(wire.Capability ?? "", out terminalId);
            if (terminalId is null)
                throw new InvalidOperationException(
                    "Foxwarm Code helper capability is invalid or expired."
                );
            var parsed = Resolve(wire.Cwd ?? "", wire.Args ?? []);
            result = await request(terminalId, wire.RequestId, parsed);
        }
        catch (Exception error)
        {
            result = new(false, null, error.Message);
        }
        try
        {
            var response = Encoding.UTF8.GetBytes(
                JsonSerializer.Serialize(
                    result with
                    {
                        RequestId = wire?.RequestId ?? "",
                    },
                    JsonOptions
                ) + "\n"
            );
            await SendAllAsync(stream, response, timeout.Token);
        }
        catch { }
    }

    private static async Task<string?> ReadLineBoundedAsync(
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

    private static CodeHelperRequest Resolve(string cwd, string[] args)
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
                target = args.ElementAtOrDefault(++i);
                continue;
            }
            if (!endOptions && arg is "--goto" or "-g")
            {
                go = true;
                target = args.ElementAtOrDefault(++i);
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
        if (string.IsNullOrWhiteSpace(target))
            throw new InvalidOperationException(
                "Usage: code [--add <folder> | --goto <file>:<line>[:column] | <path>]"
            );
        int? line = null,
            column = null;
        if (go)
        {
            var match = System.Text.RegularExpressions.Regex.Match(
                target,
                "^(.*?):(\\d+)(?::(\\d+))?$"
            );
            if (!match.Success)
                throw new InvalidOperationException("Use --goto <file>:<line>[:column].");
            target = match.Groups[1].Value;
            line = int.Parse(match.Groups[2].Value);
            column = match.Groups[3].Success ? int.Parse(match.Groups[3].Value) : null;
            if (line < 1 || (column is not null && column < 1))
                throw new InvalidOperationException("--goto line and column must be positive.");
        }
        var path = Path.GetFullPath(target, cwd);
        var info = new FileInfo(path);
        if (!info.Exists && !Directory.Exists(path))
            throw new InvalidOperationException($"Path does not exist: {path}");
        if (add && !Directory.Exists(path))
            throw new InvalidOperationException("--add requires a directory.");
        if (go && Directory.Exists(path))
            throw new InvalidOperationException("--goto requires a file.");
        return new(add || Directory.Exists(path) ? "addFolder" : "openFile", path, line, column);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref closed, 1) != 0)
            return;
        listener?.Dispose();
        listener = null;
        lock (gate)
            capabilities.Clear();
        if (socketPath is not null)
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
        int? StartLine,
        int? StartColumn
    );

    internal sealed record CodeHelperResult(
        bool Ok,
        string? Message,
        string? Error,
        string RequestId = ""
    )
    {
        public CodeHelperResult()
            : this(false, null, null) { }
    }

    private sealed record CodeHelperWire(
        int Version,
        string? RequestId,
        string? Capability,
        string? Cwd,
        string[]? Args
    );
}

internal static class CodeHelperClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    internal static async Task<bool> TryRunAsync(string[] args)
    {
        if (args.Length == 0 || args[0] != "--code-helper")
            return false;
        if (args.Length > 1 && args[1] is "--help" or "-h")
        {
            Console.WriteLine(
                "Foxwarm Code helper: code <file> | --add <folder> | --goto <file>:<line>[:column]"
            );
            return true;
        }
        if (args.Length > 1 && args[1] is "--version")
        {
            Console.WriteLine("Foxwarm Code helper 1");
            return true;
        }
        var socketPath = Environment.GetEnvironmentVariable("FOXWARM_CODE_IPC");
        var capability = Environment.GetEnvironmentVariable("FOXWARM_CODE_CAPABILITY");
        if (string.IsNullOrWhiteSpace(socketPath) || string.IsNullOrWhiteSpace(capability))
            throw new InvalidOperationException(
                "Foxwarm Code helper is only available inside a Foxwarm terminal."
            );
        var cwd = Environment.CurrentDirectory;
        var payload =
            JsonSerializer.Serialize(
                new
                {
                    version = 1,
                    requestId = Guid.NewGuid().ToString("N"),
                    capability,
                    cwd,
                    args = args.Skip(1).ToArray(),
                },
                JsonOptions
            ) + "\n";
        var client = new UnixDomainSocketEndPoint(socketPath);
        using var socket = new Socket(
            AddressFamily.Unix,
            SocketType.Stream,
            ProtocolType.Unspecified
        );
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        await socket.ConnectAsync(client, timeout.Token);
        var payloadBytes = Encoding.UTF8.GetBytes(payload);
        var sent = 0;
        while (sent < payloadBytes.Length)
            sent += await socket.SendAsync(
                payloadBytes.AsMemory(sent),
                SocketFlags.None,
                timeout.Token
            );
        var buffer = new byte[8192];
        var text = new StringBuilder();
        while (true)
        {
            var count = await socket.ReceiveAsync(buffer, SocketFlags.None, timeout.Token);
            if (count == 0)
                break;
            if (text.Length + count > 64 * 1024)
                throw new InvalidDataException("Foxwarm Code helper response exceeds 64 KiB.");
            text.Append(Encoding.UTF8.GetString(buffer, 0, count));
            if (text.ToString().Contains('\n'))
                break;
        }
        var result =
            JsonSerializer.Deserialize<CodeHelperServer.CodeHelperResult>(
                text.ToString().Trim(),
                JsonOptions
            ) ?? throw new InvalidOperationException("Invalid response from Foxwarm Code bridge.");
        if (!result.Ok)
            throw new InvalidOperationException(result.Error ?? "Foxwarm Code request failed.");
        if (!string.IsNullOrWhiteSpace(result.Message))
            Console.WriteLine(result.Message);
        return true;
    }
}
