using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Foxwarm;

// Main owns the context and both public SDK lifetimes; individual HTTP scopes own their aborts.
internal sealed class McpInboundHttp : IAsyncDisposable, IHostedService
{
    internal const int MaxBodyBytes = 8 * 1024 * 1024;
    internal const int MaxResultBytes = 16 * 1024 * 1024;
    private readonly object gate = new();
    private readonly AccessConfiguration access;
    private readonly McpInboundCatalog catalog;
    private readonly Dictionary<string, Connection> live = new(StringComparer.Ordinal);
    private readonly HashSet<Task> retirements = [];

    private sealed class PostScope(CancellationToken token)
    {
        internal readonly CancellationToken Token = token;
        internal JsonObject? Result;
    }

    private readonly AsyncLocal<PostScope?> currentPost = new();
    private readonly Timer sweep;
    private readonly TimeSpan idle;
    private readonly TimeSpan postDeadline;
    private readonly int capacity;
    private bool stopped;
    private Task? disposal;

    private sealed class Connection(McpExternalContext context)
    {
        internal readonly McpExternalContext Context = context;
        internal readonly McpAttachedResponseStream Attachment = new();
        internal StreamableHttpServerTransport Transport = null!;
        internal McpServer Server = null!;
        internal Task Run = Task.CompletedTask;
        internal Task Get = Task.CompletedTask;
        internal bool Initialized;
        internal Task? Retirement;
        internal DateTimeOffset LastActivity = DateTimeOffset.UtcNow;
        internal int Active;
        internal int Posts;
        internal int Gets;
        internal TaskCompletionSource GetsDrained = Completed();

        private static TaskCompletionSource Completed()
        {
            var result = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            result.SetResult();
            return result;
        }
    }

    internal McpInboundHttp(
        AccessConfiguration access,
        McpInboundCatalog catalog,
        TimeSpan? idle = null,
        int capacity = 32,
        TimeSpan? postDeadline = null
    )
    {
        this.access = access;
        this.catalog = catalog;
        this.idle = idle ?? TimeSpan.FromMinutes(15);
        this.capacity = capacity;
        this.postDeadline = postDeadline ?? TimeSpan.FromMinutes(65);
        access.McpRuntimeAvailable = true;
        access.Changed += OnAccessChanged;
        sweep = new Timer(
            _ => Sweep(),
            null,
            TimeSpan.FromMilliseconds(Math.Min(this.idle.TotalMilliseconds, 60000)),
            TimeSpan.FromMilliseconds(Math.Min(this.idle.TotalMilliseconds, 60000))
        );
    }

    internal void Register(WebApplication app) =>
        app.MapMethods("/mcp", ["POST", "GET", "DELETE"], HandleAsync);

    private Task OnAccessChanged(AccessChange change)
    {
        lock (gate)
            return Task.WhenAll(
                live.Values.Where(connection => !connection.Context.Available)
                    .ToArray()
                    .Select(Retire)
            );
    }

    private void Sweep()
    {
        lock (gate)
            foreach (var connection in live.Values.ToArray())
                if (
                    !connection.Context.Available
                    || connection.Run.IsCompleted
                    || connection.Get.IsCompleted
                    || connection.Posts == 0
                        && DateTimeOffset.UtcNow - connection.LastActivity >= idle
                )
                    _ = Retire(connection);
    }

    private Connection Open(McpExternalPrincipal principal)
    {
        var connection = new Connection(new(principal));
        connection.Transport = new()
        {
            SessionId = connection.Context.Id,
            FlowExecutionContextFromRequests = true,
        };
        var options = new McpServerOptions
        {
            ServerInfo = new() { Name = "foxwarm", Version = "1.0.0" },
            ProtocolVersion = "2025-11-25",
            Capabilities = new()
            {
                Tools = new(),
                Experimental = McpClient.NotificationCapability(),
            },
            Handlers = new()
            {
                ListToolsHandler = (_, _) =>
                {
                    var tools = catalog.Tools(connection.Context);
                    if (
                        tools.Count > 64
                        || Encoding.UTF8.GetByteCount(tools.ToJsonString()) > 256 * 1024
                    )
                        throw new InvalidOperationException("Tool catalog exceeds size limit.");
                    return ValueTask.FromResult(
                        JsonSerializer.Deserialize<ListToolsResult>(
                            new JsonObject { ["tools"] = tools }.ToJsonString(),
                            McpJsonUtilities.DefaultOptions
                        )!
                    );
                },
                CallToolHandler = async (request, token) =>
                {
                    // Capture only the current token; never retain an HttpContext in an owner.
                    var scope =
                        currentPost.Value
                        ?? throw new InvalidOperationException(
                            "MCP request context is unavailable."
                        );
                    using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                        token,
                        scope.Token,
                        connection.Context.Lifetime.Token
                    );
                    var args = request.Params?.Arguments is { } supplied
                        ? JsonSerializer
                            .SerializeToNode(supplied, McpJsonUtilities.DefaultOptions)!
                            .AsObject()
                        : new JsonObject();
                    var operation = catalog.CallAsync(
                        connection.Context,
                        request.Params?.Name ?? "",
                        args,
                        linked.Token
                    );
                    JsonObject result;
                    try
                    {
                        result = await operation.WaitAsync(linked.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        _ = operation.ContinueWith(
                            task => _ = task.Exception,
                            TaskScheduler.Default
                        );
                        result = McpInboundCatalog.Error(
                            "Tool call was cancelled or timed out; a running tool may have an unknown outcome. Do not retry automatically."
                        );
                    }
                    if (Encoding.UTF8.GetByteCount(result.ToJsonString()) > MaxResultBytes)
                        result = McpInboundCatalog.Error(
                            "Tool may have completed; its result exceeded the size limit. Do not retry automatically."
                        );
                    scope.Result = result;
                    // The public outgoing filter forwards the complete raw result. A typed SDK
                    // round trip would discard extension fields and unknown content variants.
                    return new CallToolResult();
                },
            },
        };
        options.Filters.Message.OutgoingFilters.Add(next =>
            (message, token) =>
            {
                if (
                    message.JsonRpcMessage is JsonRpcResponse response
                    && currentPost.Value?.Result is { } raw
                )
                    response.Result = raw;
                return next(message, token);
            }
        );
        connection.Server = McpServer.Create(connection.Transport, options);
        connection.Context.ReplyChannel = new(catalog.TextChannels, connection.Context.Id, () =>
        {
            connection.Context.Require();
            if (!connection.Initialized || !connection.Attachment.Active
                || !McpClient.SupportsNotifications(connection.Server.ClientCapabilities?.Experimental))
                throw new McpInboundSafeException("An active Foxwarm notification receiver is required for replies.");
        }, async (message, token) =>
        {
            connection.Context.ReplyChannel!.Require();
            var sent = await connection.Attachment.SendAsync(() => connection.Server.SendNotificationAsync(
                McpClient.SessionMessageMethod,
                new JsonObject { ["message"] = message, ["endpoint"] = connection.Context.ReplyChannel.TargetId },
                cancellationToken: token));
            if (!sent)
                throw new InvalidOperationException("MCP reply destination is unavailable.");
        });
        connection.Run = connection.Server.RunAsync();
        connection.Get = connection.Transport.HandleGetRequestAsync(connection.Attachment);
        live.Add(connection.Context.Id, connection);
        return connection;
    }

    private Task Retire(Connection connection)
    {
        // Called under gate. All affected owners are fenced before awaiting any cleanup.
        if (connection.Retirement is not null)
            return connection.Retirement;
        var usedNodes = connection.Context.Fence();
        connection.Retirement = RetireCoreAsync(connection, usedNodes);
        retirements.Add(connection.Retirement);
        _ = connection.Retirement.ContinueWith(
            task =>
            {
                _ = task.Exception;
                lock (gate)
                {
                    live.Remove(connection.Context.Id);
                    retirements.Remove(task);
                }
            },
            CancellationToken.None,
            TaskContinuationOptions.None,
            TaskScheduler.Default
        );
        return connection.Retirement;
    }

    private async Task RetireCoreAsync(Connection connection, string[] usedNodes)
    {
        try
        {
            await connection.Attachment.StopAsync();
            await connection.Transport.DisposeAsync();
        }
        finally
        {
            try
            {
                await catalog.ReleaseAsync(connection.Context, usedNodes);
            }
            finally
            {
                try
                {
                    await connection.Server.DisposeAsync();
                }
                finally
                {
                    try
                    {
                        await Task.WhenAll(
                            connection.Run,
                            connection.Get,
                            connection.GetsDrained.Task
                        );
                    }
                    catch (OperationCanceledException) { }
                    finally
                    {
                        connection.Context.Lifetime.Dispose();
                    }
                }
            }
        }
    }

    private static string? Header(HttpRequest request, string name) =>
        request.Headers.TryGetValue(name, out var values) && values.Count == 1 ? values[0] : null;

    private static bool SameOrigin(string origin, string host) =>
        Uri.TryCreate(origin, UriKind.Absolute, out var uri)
        && uri.Scheme is "http" or "https"
        && uri.Authority.Equals(host, StringComparison.OrdinalIgnoreCase)
        && uri.AbsolutePath == "/"
        && uri.Query.Length == 0
        && uri.Fragment.Length == 0
        && uri.UserInfo.Length == 0;

    private static async Task Error(HttpContext http, int status, string text)
    {
        if (http.Response.HasStarted)
        {
            http.Abort();
            return;
        }
        http.Response.StatusCode = status;
        http.Response.ContentType = "application/json";
        await http.Response.WriteAsJsonAsync(new { error = text });
    }

    internal async Task HandleAsync(HttpContext http)
    {
        var request = http.Request;
        var authorization = Header(request, "Authorization");
        var bearer = authorization is not null
            ? System.Text.RegularExpressions.Regex.Match(
                authorization,
                @"^Bearer ([A-Za-z0-9._~+/-]+={0,2})$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase
            )
            : null;
        var principal =
            bearer?.Success == true
                ? McpExternalPrincipal.Authenticate(access, bearer.Groups[1].Value)
                : null;
        if (principal is null)
        {
            await Error(http, 401, "Unauthorized.");
            return;
        }
        if (
            request.Headers.ContainsKey("Origin")
            && (
                Header(request, "Origin") is not string origin
                || !SameOrigin(origin, request.Host.Value ?? "")
            )
        )
        {
            await Error(http, 403, "Origin not allowed.");
            return;
        }
        var id = Header(request, "Mcp-Session-Id");
        if (request.Headers.ContainsKey("Mcp-Session-Id") && string.IsNullOrEmpty(id))
        {
            await Error(http, 400, "Invalid MCP session header.");
            return;
        }
        var protocol = Header(request, "MCP-Protocol-Version");
        if (
            request.Headers.ContainsKey("MCP-Protocol-Version")
            && protocol is not ("2024-11-05" or "2025-03-26" or "2025-06-18" or "2025-11-25")
        )
        {
            await Error(http, 400, "Unsupported MCP protocol version.");
            return;
        }
        if (
            request.Method == "GET"
            && request.Headers.TryGetValue("Last-Event-ID", out var resume)
            && (resume.Count != 1 || !string.IsNullOrEmpty(resume[0]))
        )
        {
            await Error(http, 400, "MCP stream resumption is not supported.");
            return;
        }
        var accept = request.Headers.Accept.ToString();
        if (
            request.Method is "POST" or "GET"
            && (
                !accept.Contains("text/event-stream", StringComparison.Ordinal)
                || request.Method == "POST"
                    && !accept.Contains("application/json", StringComparison.Ordinal)
            )
        )
        {
            await Error(http, 406, "Required MCP response types are not accepted.");
            return;
        }
        JsonRpcMessage? message = null;
        byte[]? messageBytes = null;
        if (request.Method == "POST")
        {
            if (request.ContentType?.Split(';')[0].Trim() != "application/json")
            {
                await Error(http, 415, "Content-Type must be application/json.");
                return;
            }
            if (
                http.Features.Get<IHttpMaxRequestBodySizeFeature>() is
                { IsReadOnly: false } bodyLimit
            )
                bodyLimit.MaxRequestBodySize = MaxBodyBytes;
            try
            {
                if (request.ContentLength > MaxBodyBytes)
                {
                    await Error(http, 413, "MCP request exceeds size limit.");
                    return;
                }
                using var body = new MemoryStream();
                var buffer = new byte[8192];
                int count;
                while ((count = await request.Body.ReadAsync(buffer, http.RequestAborted)) > 0)
                {
                    if (body.Length + count > MaxBodyBytes)
                    {
                        await Error(http, 413, "MCP request exceeds size limit.");
                        return;
                    }
                    body.Write(buffer, 0, count);
                }
                messageBytes = body.ToArray();
                _ = JsonNode.Parse(messageBytes); // Syntax only before exact context ownership lookup.
                if (id is null)
                {
                    message = JsonSerializer.Deserialize<JsonRpcMessage>(
                        messageBytes,
                        McpJsonUtilities.DefaultOptions
                    );
                    if (message is null)
                        throw new JsonException();
                }
            }
            catch (BadHttpRequestException error) when (error.StatusCode == 413)
            {
                await Error(http, 413, "MCP request exceeds size limit.");
                return;
            }
            catch (JsonException)
            {
                await Error(http, 400, "Invalid MCP request body.");
                return;
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (IOException)
            {
                return;
            }
        }
        Connection? connection = null;
        var status = 0;
        var errorText = "";
        lock (gate)
        {
            if (stopped)
            {
                status = 503;
                errorText = "MCP service unavailable.";
            }
            else if (id is not null)
            {
                if (
                    !live.TryGetValue(id, out connection)
                    || !connection.Initialized
                    || !connection.Context.Available
                    || connection.Context.ExternalId != principal.Id
                )
                {
                    connection = null;
                    status = 404;
                    errorText = "MCP session not found.";
                }
                else if (
                    connection.Posts == 0
                    && DateTimeOffset.UtcNow - connection.LastActivity >= idle
                )
                {
                    _ = Retire(connection);
                    connection = null;
                    status = 404;
                    errorText = "MCP session not found.";
                }
            }
            else if (
                request.Method != "POST"
                || message is not JsonRpcRequest { Method: "initialize" }
            )
            {
                status = 400;
                errorText = "Initialize a new MCP session first.";
            }
            else if (live.Count >= capacity)
            {
                status = 503;
                errorText = "MCP session capacity reached.";
            }
            else
                connection = Open(principal);
            if (connection is not null)
            {
                if (connection.Active >= 4)
                {
                    status = 429;
                    errorText = "Too many concurrent requests.";
                    connection = null;
                }
                else
                {
                    connection.Active++;
                    connection.LastActivity = DateTimeOffset.UtcNow;
                    if (request.Method == "POST")
                        connection.Posts++;
                    if (request.Method == "GET" && connection.Gets++ == 0)
                        connection.GetsDrained = new(
                            TaskCreationOptions.RunContinuationsAsynchronously
                        );
                }
            }
        }
        if (connection is null)
        {
            await Error(http, status, errorText);
            return;
        }
        http.Response.Headers["Mcp-Session-Id"] = connection.Context.Id;
        http.Response.Headers.CacheControl = "no-store";
        try
        {
            connection.Context.Require();
            if (request.Method == "DELETE")
            {
                Task retired;
                lock (gate)
                    retired = Retire(connection);
                await retired;
                http.Response.StatusCode = 200;
                return;
            }
            http.Response.ContentType = "text/event-stream";
            if (request.Method == "GET")
            {
                await GetAsync(http, connection);
                return;
            }
            if (message is null)
                message =
                    JsonSerializer.Deserialize<JsonRpcMessage>(
                        messageBytes!,
                        McpJsonUtilities.DefaultOptions
                    ) ?? throw new JsonException();
            if (id is not null && message is JsonRpcRequest { Method: "initialize" })
            {
                await Error(http, 400, "MCP session is already initialized.");
                return;
            }
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(
                http.RequestAborted,
                connection.Context.Lifetime.Token
            );
            deadline.CancelAfter(postDeadline);
            var previous = currentPost.Value;
            currentPost.Value = new(deadline.Token);
            try
            {
                var wrote = await connection.Transport.HandlePostRequestAsync(
                    message!,
                    http.Response.Body,
                    first =>
                    {
                        if (id is null && first is JsonRpcResponse { Result: not null })
                            lock (gate)
                                connection.Initialized = true;
                        return ValueTask.CompletedTask;
                    },
                    deadline.Token
                );
                if (!wrote)
                {
                    http.Response.ContentType = null;
                    http.Response.StatusCode = 202;
                }
                if (id is null && connection.Server.ClientInfo is not null)
                    lock (gate)
                        connection.Initialized = true;
            }
            finally
            {
                currentPost.Value = previous;
            }
        }
        catch (McpInboundSafeException)
        {
            await Error(http, 404, "MCP session not found.");
        }
        catch (OperationCanceledException)
        {
            await Error(
                http,
                504,
                "MCP request timed out or disconnected; outcome may be unknown. Do not retry automatically."
            );
        }
        catch (JsonException)
        {
            await Error(http, 400, "Invalid MCP request body.");
        }
        catch
        {
            await Error(
                http,
                500,
                "MCP request failed; outcome may be unknown. Do not retry automatically."
            );
        }
        finally
        {
            Task? retire = null;
            lock (gate)
            {
                connection.Active--;
                if (request.Method == "POST")
                {
                    connection.Posts--;
                    connection.LastActivity = DateTimeOffset.UtcNow;
                }
                if (request.Method == "GET" && --connection.Gets == 0)
                    connection.GetsDrained.TrySetResult();
                if (id is null && !connection.Initialized)
                    retire = Retire(connection);
            }
            if (retire is not null)
                await retire;
        }
    }

    private static async Task GetAsync(HttpContext http, Connection connection)
    {
        await connection.Attachment.Ready.Task;
        if (connection.Get.IsCompleted)
            throw new McpInboundSafeException("MCP receiver is unavailable.");
        var attachment = connection.Attachment.Attach(http.Response.Body);
        if (attachment is null)
        {
            await Error(http, 409, "MCP SSE stream already open.");
            return;
        }
        using var abort = http.RequestAborted.Register(() =>
            connection.Attachment.Detach(attachment)
        );
        using var cancellation = attachment.Cancel.Token.Register(http.Abort);
        try
        {
            await http.Response.Body.FlushAsync(http.RequestAborted);
            connection.Context.Require();
            connection.Attachment.Activate(attachment);
            await attachment.Ended.Task;
        }
        finally
        {
            connection.Attachment.Detach(attachment);
            await attachment.Drained.Task;
            attachment.Cancel.Dispose();
        }
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => DisposeAsync().AsTask();

    public ValueTask DisposeAsync()
    {
        lock (gate)
            return new(disposal ??= StopAsync());
    }

    private async Task StopAsync()
    {
        stopped = true;
        access.McpRuntimeAvailable = false;
        sweep.Dispose();
        access.Changed -= OnAccessChanged;
        Task[] pending;
        lock (gate)
        {
            foreach (var connection in live.Values.ToArray())
                _ = Retire(connection);
            pending = retirements.ToArray();
        }
        await Task.WhenAll(pending);
    }
}
