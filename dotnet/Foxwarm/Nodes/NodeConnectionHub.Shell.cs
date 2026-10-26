using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    private const string ShellProtocol = "foxwarm-shell-1";
    private const int ShellOutputBytes = 8192;
    private const int ShellMaxTasks = 32;
    private readonly Dictionary<string, ShellTask> shellTasks = new(StringComparer.Ordinal);
    private Timer? shellExpiry;

    internal static bool IsShellPath(PathString path) =>
        path == "/node/shell/register"
        || path == "/node/shell/poll"
        || path == "/node/shell/report";

    // This is the actual transport capability, not the Main/CLI exec definition.
    private static JsonObject ShellCapability(bool powershell) =>
        new()
        {
            ["name"] = "exec",
            ["description"] = powershell
                ? "Run a PowerShell command on this Windows Node. Returns bounded output with its total byte count; full output is not retained. If the command outlasts timeout, it continues in the background and returns an execId. Completion is reported to the originating Session."
                : "Run a POSIX shell command on this Node. Returns bounded output with its total byte count; full output is not retained. If the command outlasts timeout, it continues in the background and returns an execId. Completion is reported to the originating Session.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject
                {
                    ["command"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = powershell
                            ? "PowerShell command or pipeline to execute."
                            : "Shell command or pipeline to execute.",
                    },
                    ["cwd"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] =
                            "Working directory for this command. Relative paths use the Shell Node's startup directory. When omitted, use the session working directory or, if unset, the startup directory.",
                    },
                    ["timeout"] = new JsonObject
                    {
                        ["type"] = "number",
                        ["description"] =
                            "Seconds to wait before returning a still-running command as a background execution. Defaults to 15; values above 60 are reduced to 60.",
                        ["default"] = 15,
                        ["minimum"] = 1,
                    },
                },
                ["required"] = new JsonArray("command"),
            },
        };

    private sealed class ShellTask(
        string id,
        ShellRuntime runtime,
        string callId,
        Invocation call,
        string script,
        int timeout,
        string warning,
        bool programmatic
    )
    {
        internal readonly string Id = id;
        internal readonly ShellRuntime Runtime = runtime;
        internal readonly string CallId = callId;
        internal readonly Invocation Call = call;
        internal string Script = script;
        internal readonly int Timeout = timeout;
        internal readonly string Warning = warning;
        internal readonly bool Programmatic = programmatic;
        internal readonly DateTimeOffset Started = DateTimeOffset.UtcNow;
        internal readonly SemaphoreSlim Serial = new(1, 1);
        internal bool Delivered;
        internal string State = "foreground";
    }

    // Each runtime is published through the same authenticated identity boundary as WS.
    // All queue/poll/map operations hold the hub gate; report admission holds only task.Serial.
    private sealed class ShellRuntime(
        NodeConnectionHub hub,
        Connection connection,
        string cwd,
        bool powershell,
        string? publication = null
    )
    {
        internal readonly Connection Connection = connection;
        internal readonly string Cwd = cwd;
        internal readonly bool PowerShell = powershell;
        internal readonly string Id = publication ?? NewShellConnection();
        internal DateTimeOffset LastSeen = DateTimeOffset.UtcNow;
        internal bool Closed;
        private readonly Queue<ShellTask> queue = new();
        private TaskCompletionSource<ShellTask?>? pending;

        internal void Dispatch(
            string callId,
            Invocation call,
            JsonObject args,
            string? sessionCwd,
            bool programmatic
        )
        {
            if (Closed || call.Claim is null)
                throw new InvalidDataException("Shell Node exec transport is unavailable.");
            var command = SessionWait.Text(args["command"]);
            if (
                string.IsNullOrWhiteSpace(command)
                || Encoding.UTF8.GetByteCount(command) > 57344
                || command.Contains('\0')
            )
                throw new InvalidDataException(
                    "Shell Node command must be non-empty and at most 56 KiB."
                );
            if (
                hub.shellTasks.Values.Count(task =>
                    task.Runtime.Connection.Id == Connection.Id && task.State != "finished"
                ) >= ShellMaxTasks
            )
                throw new InvalidOperationException("Shell Node is busy; no command was started.");
            var explicitCwd = SessionWait.Text(args["cwd"]);
            if (args.ContainsKey("cwd") && string.IsNullOrWhiteSpace(explicitCwd))
                throw new InvalidDataException("cwd must be a non-empty directory.");
            var value = explicitCwd ?? sessionCwd ?? Cwd;
            var directory = PowerShell ? value : ResolveCwd(Cwd, value);
            if (directory.Contains('\0') || Encoding.UTF8.GetByteCount(directory) > 4096)
                throw new InvalidDataException("Shell Node cwd is invalid.");
            var seconds = args["timeout"] is null
                ? 15
                : SessionWait.Number(args["timeout"]) ?? double.NaN;
            if (!double.IsFinite(seconds) || seconds < 1)
                throw new InvalidDataException(
                    "timeout must be a finite number of at least 1 second."
                );
            var warning =
                seconds > 60
                    ? $"WARNING: Requested timeout {seconds.ToString(CultureInfo.InvariantCulture)}s exceeds the 60s maximum; using 60s.\n"
                    : "";
            var task = new ShellTask(
                Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)),
                this,
                callId,
                call,
                PowerShell
                    ? "try { Set-Location -LiteralPath '"
                        + Cwd.Replace("'", "''")
                        + "' -ErrorAction Stop; Set-Location -LiteralPath '"
                        + directory.Replace("'", "''")
                        + "' -ErrorAction Stop } catch { Write-Error $_; exit 125 }\n"
                        + command
                        + "\n"
                    : "cd '"
                        + directory.Replace("'", "'\"'\"'")
                        + "' || exit 125\n"
                        + command
                        + "\n",
                (int)Math.Ceiling(Math.Min(seconds, 60)),
                warning,
                programmatic
            );
            hub.shellTasks.Add(task.Id, task);
            queue.Enqueue(task);
            Flush();
        }

        private static string ResolveCwd(string startup, string value)
        {
            var absolute = value.StartsWith('/') ? value : startup + "/" + value;
            var parts = new List<string>();
            foreach (var part in absolute.Split('/'))
            {
                if (part is "" or ".")
                    continue;
                if (part == "..")
                {
                    if (parts.Count > 0)
                        parts.RemoveAt(parts.Count - 1);
                }
                else
                    parts.Add(part);
            }
            return "/" + string.Join('/', parts);
        }

        internal bool Cancel(string callId)
        {
            var removed = false;
            var count = queue.Count;
            while (count-- > 0)
            {
                var task = queue.Dequeue();
                if (task.CallId == callId)
                {
                    hub.shellTasks.Remove(task.Id);
                    removed = true;
                }
                else
                    queue.Enqueue(task);
            }
            return removed;
        }

        internal void Disconnect()
        {
            lock (hub.gate)
            {
                Closed = true;
                while (queue.TryDequeue(out var task))
                {
                    hub.shellTasks.Remove(task.Id);
                    hub.ExecClaims.Settle(task.Call.Claim!, true);
                }
                pending?.TrySetException(new IOException("Shell Node disconnected."));
                pending = null;
            }
        }

        internal TaskCompletionSource<ShellTask?> Poll()
        {
            if (pending is not null)
                throw new InvalidOperationException("Poll already pending.");
            LastSeen = DateTimeOffset.UtcNow;
            pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var result = pending;
            Flush();
            return result;
        }

        internal void EndPoll(TaskCompletionSource<ShellTask?> source)
        {
            if (ReferenceEquals(pending, source))
                pending = null;
        }

        private void Flush()
        {
            if (pending is null || !queue.TryDequeue(out var task))
                return;
            // Removal precedes handoff. Response loss can never put this command back.
            task.Delivered = true;
            pending.TrySetResult(task);
            pending = null;
        }
    }

    internal string? ShellDefaultCwd(string id)
    {
        lock (gate)
            return Require(id).Http?.Cwd;
    }

    private ShellRuntime PublishShell(
        string id,
        string auth,
        string cwd,
        bool powershell,
        string? publication,
        string? predecessor
    )
    {
        var connection = new Connection { Id = id, Type = "shell-node" };
        var runtime = connection.Http = new ShellRuntime(
            this,
            connection,
            cwd,
            powershell,
            publication
        );
        connection.Capabilities = new JsonObject
        {
            ["tools"] = new JsonArray(ShellCapability(powershell)),
            ["features"] = new JsonObject { ["remoteExecBackgroundRegistration"] = true },
        };
        connection.Protocol = Protocol(
            new JsonObject
            {
                ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
            }
        );
        Connection? old;
        lock (gate)
        {
            if (shutdown.IsCancellationRequested)
                throw new IOException("Host is shutting down.");
            // Compare the current live transport under the shared HTTP/WS publication gate.
            // With no live transport, an authorized client may recover after expiry or restart.
            nodes.TryGetValue(id, out old);
            var current =
                old is { Retired: false } && old.Open ? old.Generation.ToString("N") : null;
            if (
                current is not null
                && publication is not null
                && old!.Http is { } existing
                && existing.Id == publication
            )
            {
                if (!Registry.Authenticate(id, auth))
                    throw new InvalidDataException("Node credentials were removed or replaced.");
                return existing;
            }
            if (predecessor is not null && current is not null && current != predecessor)
                throw new InvalidOperationException("Connection was replaced.");
            // Recheck the credential and durably touch it inside revocation's publication lock.
            Registry.Touch(
                id,
                auth,
                new JsonObject
                {
                    ["nodeType"] = "shell-node",
                    ["capabilities"] = connection.Capabilities.DeepClone(),
                },
                connection.Protocol
            );
            if (old is not null)
                old.Retired = true;
            nodes[id] = connection;
        }
        if (old is not null)
        {
            FailCalls(old, "Node connection replaced");
            Close(old, "Node connection replaced", false);
        }
        Changed?.Invoke();
        return runtime;
    }

    private void CollectShell()
    {
        Connection[] expired;
        lock (gate)
        {
            expired = nodes.Values.Where(c => c.Http is not null && !c.Open).ToArray();
            foreach (var connection in expired)
            {
                // The exact-runtime check and removal stay under the lifecycle lock.
                if (
                    nodes.TryGetValue(connection.Id!, out var current)
                    && ReferenceEquals(current, connection)
                )
                {
                    nodes.Remove(connection.Id!);
                    connection.Retired = true;
                }
            }
            foreach (
                var task in shellTasks
                    .Values.Where(t => DateTimeOffset.UtcNow - t.Started > TimeSpan.FromHours(24))
                    .ToArray()
            )
                shellTasks.Remove(task.Id);
        }
        foreach (var connection in expired)
        {
            FailCalls(connection, "Shell Node stopped polling; execution outcome may be unknown");
            Close(connection, "Shell Node stopped polling", false);
        }
        if (expired.Length > 0)
            Changed?.Invoke();
    }

    private static async Task<byte[]> ShellBody(
        HttpRequest request,
        int limit,
        CancellationToken token
    )
    {
        if (
            request.ContentType?.StartsWith("application/octet-stream", StringComparison.Ordinal)
            != true
        )
            throw new InvalidDataException("Expected application/octet-stream.");
        if (request.ContentLength > limit)
            throw new InvalidDataException("Body exceeds limit.");
        using var body = new MemoryStream();
        var block = new byte[Math.Min(limit + 1, 4096)];
        while (true)
        {
            var count = await request.Body.ReadAsync(block, token);
            if (count == 0)
                break;
            if (body.Length + count > limit)
                throw new InvalidDataException("Body exceeds limit.");
            body.Write(block, 0, count);
        }
        return body.ToArray();
    }

    private static string ShellHeader(HttpRequest request, string key) =>
        request.Headers[key].ToString();

    private (string Id, string Auth)? AuthenticateShell(HttpContext context)
    {
        var id = ShellHeader(context.Request, "X-Foxwarm-Node");
        var auth = ShellHeader(context.Request, "Authorization");
        if (
            !System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-zA-Z0-9_-]+$")
            || !auth.StartsWith("Bearer ", StringComparison.Ordinal)
            || !Registry.Authenticate(id, auth[7..])
        )
        {
            ShellFailure(context, 401, "credentials-rejected");
            return null;
        }
        return (id, auth[7..]);
    }

    private static string NewShellConnection() =>
        Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));

    private static bool ShellConnectionId(string value) =>
        value.Length == 32 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void ShellFailure(HttpContext context, int status, string reason)
    {
        context.Response.Headers["X-Foxwarm-Shell"] = ShellProtocol;
        context.Response.Headers["X-Foxwarm-Shell-Reason"] = reason;
        context.Response.StatusCode = status;
    }

    internal void RegisterShellRoutes(WebApplication app)
    {
        shellExpiry = new Timer(
            _ => CollectShell(),
            null,
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(10)
        );
        foreach (var suffix in new[] { "register", "poll", "report" })
            app.MapMethods(
                "/node/shell/" + suffix,
                suffix == "poll" ? ["GET"]
                    : suffix == "register" ? ["POST", "HEAD"]
                    : ["POST"],
                async (HttpContext context) =>
                {
                    var credential = AuthenticateShell(context);
                    if (credential is null)
                        return;
                    try
                    {
                        if (suffix == "register" && HttpMethods.IsHead(context.Request.Method))
                        {
                            lock (gate)
                            {
                                context.Response.Headers["X-Foxwarm-Predecessor"] =
                                    nodes.TryGetValue(credential.Value.Id, out var current)
                                    && !current.Retired
                                    && current.Open
                                        ? current.Generation.ToString("N")
                                        : "none";
                                context.Response.Headers["X-Foxwarm-Connection"] =
                                    NewShellConnection();
                            }
                            ShellAck(context);
                        }
                        else if (suffix == "register")
                        {
                            var predecessor = ShellHeader(context.Request, "X-Foxwarm-Predecessor");
                            var publication = ShellHeader(context.Request, "X-Foxwarm-Connection");
                            if (
                                predecessor.Length > 0
                                && (
                                    !ShellConnectionId(publication)
                                    || (predecessor != "none" && !ShellConnectionId(predecessor))
                                )
                            )
                                throw new InvalidDataException("Invalid publication identity.");
                            var cwd = Encoding.UTF8.GetString(
                                await ShellBody(context.Request, 4096, context.RequestAborted)
                            );
                            var dialect = ShellHeader(context.Request, "X-Foxwarm-Shell-Dialect");
                            if (dialect is not ("" or "posix" or "powershell"))
                                throw new InvalidDataException("Unsupported shell dialect.");
                            var powershell = dialect == "powershell";
                            var absolute = powershell
                                ? System.Text.RegularExpressions.Regex.IsMatch(
                                    cwd,
                                    @"^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))"
                                )
                                : cwd.StartsWith('/');
                            if (!absolute || cwd.Any(c => c is '\0' or '\r' or '\n'))
                                throw new InvalidDataException("Invalid startup directory.");
                            var runtime = PublishShell(
                                credential.Value.Id,
                                credential.Value.Auth,
                                cwd,
                                powershell,
                                predecessor.Length == 0 ? null : publication,
                                predecessor.Length == 0 ? null : predecessor
                            );
                            context.Response.Headers["X-Foxwarm-Connection"] = runtime.Id;
                            ShellAck(context);
                        }
                        else if (suffix == "poll")
                            await PollShell(context, credential.Value.Id);
                        else
                            await ReportShell(context, credential.Value.Id);
                    }
                    catch (InvalidDataException)
                    {
                        if (!context.Response.HasStarted)
                            ShellFailure(context, 400, "invalid-request");
                    }
                    catch (InvalidOperationException)
                    {
                        if (!context.Response.HasStarted)
                            ShellFailure(
                                context,
                                409,
                                suffix == "register" ? "connection-replaced" : "request-conflict"
                            );
                    }
                    catch (IOException)
                    {
                        if (!context.Response.HasStarted)
                            ShellFailure(context, 503, "server-unavailable");
                    }
                    catch (OperationCanceledException)
                        when (context.RequestAborted.IsCancellationRequested) { }
                }
            );
    }

    private static void ShellAck(HttpContext context)
    {
        context.Response.Headers["X-Foxwarm-Shell"] = ShellProtocol;
        context.Response.StatusCode = 204;
    }

    private async Task PollShell(HttpContext context, string id)
    {
        ShellRuntime runtime;
        TaskCompletionSource<ShellTask?> poll;
        lock (gate)
        {
            var connectionId = ShellHeader(context.Request, "X-Foxwarm-Connection");
            if (!nodes.TryGetValue(id, out var active) || active.Retired || !active.Open)
            {
                ShellFailure(context, 409, "connection-unavailable");
                return;
            }
            if (active.Http is not { } http || http.Id != connectionId)
            {
                ShellFailure(context, 409, "connection-replaced");
                return;
            }
            runtime = http;
            try
            {
                poll = runtime.Poll();
            }
            catch (InvalidOperationException)
            {
                ShellFailure(context, 409, "poll-pending");
                return;
            }
        }
        ShellTask? task;
        try
        {
            task = await poll.Task.WaitAsync(TimeSpan.FromSeconds(25), context.RequestAborted);
        }
        catch (TimeoutException)
        {
            ShellAck(context);
            return;
        }
        finally
        {
            lock (gate)
                runtime.EndPoll(poll);
        }
        if (task is null)
        {
            ShellAck(context);
            return;
        }
        context.Response.Headers["X-Foxwarm-Shell"] = ShellProtocol;
        context.Response.Headers["X-Foxwarm-Task"] = task.Id;
        context.Response.Headers["X-Foxwarm-Exec"] = task.Call.Claim!.ExecId;
        context.Response.Headers["X-Foxwarm-Timeout"] = task.Timeout.ToString(
            CultureInfo.InvariantCulture
        );
        context.Response.ContentType = "application/x-foxwarm-shell; charset=utf-8";
        await context.Response.WriteAsync(task.Script, context.RequestAborted);
    }
}
