using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm;

internal sealed partial class McpClient : IAsyncDisposable
{
    private readonly McpConfiguration configuration;
    internal McpOAuthService OAuth { get; }
    private readonly object lifecycle = new();
    private readonly Dictionary<long, Task> operations = [];
    private readonly CancellationTokenSource shutdown = new();
    private long nextOperation;
    private bool closed;

    internal McpClient(string root, string? publicBaseUrl = null)
    {
        configuration = new(root);
        OAuth = new(root, publicBaseUrl, configuration.Get, FenceServer, shutdown.Token);
    }

    private Task<T> RunAsync<T>(
        Func<CancellationToken, Task<T>> operation,
        CancellationToken caller
    )
    {
        var completion = new TaskCompletionSource<T>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        long id;
        lock (lifecycle)
        {
            if (closed)
                throw new InvalidOperationException("MCP client is shutting down.");
            id = ++nextOperation;
            operations.Add(id, completion.Task);
        }
        _ = Complete();
        return completion.Task;
        async Task Complete()
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                caller,
                shutdown.Token
            );
            try
            {
                completion.TrySetResult(await operation(linked.Token));
            }
            catch (OperationCanceledException) when (linked.IsCancellationRequested)
            {
                completion.TrySetCanceled(linked.Token);
            }
            catch (McpInboundSafeException error)
            {
                completion.TrySetException(error);
            }
            catch (Exception error)
            {
                completion.TrySetException(
                    new InvalidOperationException(SafeError(error.Message), error)
                );
            }
            finally
            {
                lock (lifecycle)
                    operations.Remove(id);
            }
        }
    }

    private string SafeError(string message, params JsonObject[] configs)
    {
        try
        {
            if (
                OAuth
                    .Credentials()
                    .Any(secret => message.Contains(secret, StringComparison.Ordinal))
            )
                return "The MCP operation failed with private credential data. Its outcome may be unknown; do not retry automatically.";
            return Foxwarm.Images.ImageTransport.DiagnosticBody(
                configuration.Redact(message, configs)
            );
        }
        catch
        {
            return "MCP operation failed; error detail is unavailable.";
        }
    }

    internal Task<JsonObject> ConfigureAsync(
        JsonObject args,
        CancellationToken cancellationToken
    ) =>
        RunAsync(
            async token =>
            {
                ToolRegistry.Keys(
                    args,
                    [
                        "name",
                        "url",
                        "command",
                        "args",
                        "cwd",
                        "stderr",
                        "token",
                        "description",
                        "enable",
                        "transport",
                        "type",
                        "timeoutSeconds",
                        "env",
                        "envJson",
                        "headers",
                        "headersJson",
                    ]
                );
                var name = ToolRegistry.Text(args, "name")?.Trim();
                if (string.IsNullOrEmpty(name))
                    throw new InvalidDataException("mcp_config requires name.");
                var patch = (JsonObject)args.DeepClone();
                patch.Remove("name");
                foreach (var key in new[] { "env", "headers" })
                {
                    var map = ToolRegistry.ObjectArg(args, key, key + "Json");
                    patch.Remove(key + "Json");
                    if (map is not null)
                        patch[key] = map;
                }
                token.ThrowIfCancellationRequested();
                try
                {
                    await UpdateConfigurationAsync(
                        name,
                        patch,
                        enabledOnly: patch.Count == 1 && patch.ContainsKey("enable")
                    );
                }
                catch (Exception error)
                {
                    throw new InvalidOperationException(SafeError(error.Message, patch));
                }
                var timeout = SessionWait.Number(args["timeoutSeconds"]);
                return new JsonObject
                {
                    ["output"] =
                        $"MCP server \"{name}\" saved."
                        + (
                            timeout == 0 ? " Tool-call timeout reset to 60 seconds."
                            : timeout is not null ? $" Tool-call timeout: {timeout} second(s)."
                            : ""
                        ),
                };
            },
            cancellationToken
        );

    internal Task<JsonObject> ListServersAsync(CancellationToken cancellationToken) =>
        RunAsync(
            token =>
            {
                token.ThrowIfCancellationRequested();
                var servers = Summaries();
                var result = new JsonObject { ["count"] = servers.Count, ["servers"] = servers };
                if (servers.Count == 0)
                    result["message"] = "No MCP servers configured.";
                return Task.FromResult(result);
            },
            cancellationToken
        );

    internal JsonArray Summaries() =>
        new(
            configuration
                .Snapshot()
                .Select(pair =>
                {
                    var config = pair.Value!.AsObject();
                    var summary = new JsonObject
                    {
                        ["name"] = pair.Key,
                        ["enabled"] = config["enable"]?.GetValue<bool>() != false,
                        ["transport"] = config["transport"]?.DeepClone(),
                        ["argsCount"] = (config["args"] as JsonArray)?.Count ?? 0,
                        ["envKeys"] = new JsonArray(
                            (config["env"] as JsonObject ?? new JsonObject())
                                .Select(p => p.Key)
                                .Order(StringComparer.Ordinal)
                                .Select(key => (JsonNode?)JsonValue.Create(key))
                                .ToArray()
                        ),
                        ["headerKeys"] = new JsonArray(
                            (config["headers"] as JsonObject ?? new JsonObject())
                                .Select(p => p.Key)
                                .Order(StringComparer.Ordinal)
                                .Select(key => (JsonNode?)JsonValue.Create(key))
                                .ToArray()
                        ),
                        ["hasToken"] = !string.IsNullOrEmpty(SessionWait.Text(config["token"])),
                        ["authentication"] = config["oauth"] is not null ? "oauth" : "static",
                        ["timeoutSeconds"] = config["timeoutSeconds"]?.DeepClone(),
                    };
                    foreach (var key in new[] { "description", "url", "command", "cwd", "stderr" })
                        if (config[key] is not null)
                            summary[key] = config[key]!.DeepClone();
                    return (JsonNode?)summary;
                })
                .ToArray()
        );

    internal Task<IReadOnlyList<JsonObject>> ListToolsAsync(
        string server,
        CancellationToken cancellationToken,
        SessionOwner? owner = null,
        long? ownerGeneration = null,
        McpExternalContext? external = null
    ) =>
        RunAsync(
            async token =>
            {
                var config = configuration.Get(server);
                try
                {
                    return await WithClientAsync(
                        server,
                        token,
                        owner,
                        ownerGeneration,
                        async (client, config, requestToken) =>
                        {
                            var tools = new List<JsonObject>();
                            string? cursor = null;
                            do
                            {
                                var page = await client.ListToolsAsync(
                                    new ListToolsRequestParams { Cursor = cursor },
                                    requestToken
                                );
                                tools.AddRange(
                                    page.Tools.Select(tool =>
                                        JsonSerializer
                                            .SerializeToNode(tool, McpJsonUtilities.DefaultOptions)!
                                            .AsObject()
                                    )
                                );
                                cursor = page.NextCursor;
                            } while (cursor is not null);
                            return (IReadOnlyList<JsonObject>)tools;
                        },
                        external
                    );
                }
                catch (McpInboundSafeException)
                {
                    throw;
                }
                catch (Exception error) when (!token.IsCancellationRequested)
                {
                    throw new InvalidOperationException(SafeError(error.Message, config));
                }
            },
            cancellationToken
        );

    internal Task<JsonNode?> CallAsync(
        string server,
        string name,
        JsonObject args,
        CancellationToken cancellationToken,
        SessionOwner? owner = null,
        long? ownerGeneration = null,
        McpExternalContext? external = null,
        bool raw = false,
        Action? beforeSend = null
    ) =>
        RunAsync<JsonNode?>(
            async token =>
            {
                var config = configuration.Get(server);
                try
                {
                    return await WithClientAsync(
                        server,
                        token,
                        owner,
                        ownerGeneration,
                        async (client, config, requestToken) =>
                        {
                            await PreflightReplyAsync(client, name, args, requestToken);
                            using var callBudget = CancellationTokenSource.CreateLinkedTokenSource(
                                requestToken
                            );
                            callBudget.CancelAfter(
                                TimeSpan.FromSeconds(
                                    SessionWait.Number(config["timeoutSeconds"]) ?? 60
                                )
                            );
                            var request = new JsonRpcRequest
                            {
                                Id = new RequestId("foxwarm-call-" + Guid.NewGuid().ToString("N")),
                                Method = RequestMethods.ToolsCall,
                                Params = new JsonObject
                                {
                                    ["name"] = name,
                                    ["arguments"] = args.DeepClone(),
                                },
                            };
                            callBudget.Token.ThrowIfCancellationRequested();
                            external?.Require();
                            beforeSend?.Invoke();
                            JsonRpcResponse result;
                            try
                            {
                                result = await client.SendRequestAsync(request, callBudget.Token);
                            }
                            catch (OperationCanceledException)
                            {
                                if (SessionWait.Text(config["transport"]) == "stdio")
                                {
                                    // The pinned SDK's local WaitAsync cancellation can finish
                                    // before its best-effort cancellation callback is sent. Keep
                                    // the accepted stdio peer signal using the SDK's typed API.
                                    using var notificationBudget = new CancellationTokenSource(
                                        TimeSpan.FromSeconds(1)
                                    );
                                    try
                                    {
                                        await client.SendNotificationAsync(
                                            NotificationMethods.CancelledNotification,
                                            new CancelledNotificationParams
                                            {
                                                RequestId = request.Id,
                                            },
                                            cancellationToken: notificationBudget.Token
                                        );
                                    }
                                    catch
                                    { /* Do not replace the original Stop/timeout outcome. */
                                    }
                                }
                                if (!requestToken.IsCancellationRequested)
                                    throw new TimeoutException("MCP tool call timed out.");
                                throw;
                            }
                            if (raw)
                                ValidateExternalResult(result.Result);
                            return raw
                                ? result.Result?.DeepClone()
                                : NormalizeResult(result.Result?.DeepClone());
                        },
                        external
                    );
                }
                catch (McpInboundSafeException)
                {
                    throw;
                }
                catch (Exception error) when (!token.IsCancellationRequested)
                {
                    throw new InvalidOperationException(SafeError(error.Message, config));
                }
            },
            cancellationToken
        );

    private static JsonObject NormalizeImages(JsonObject result)
    {
        if (result["content"] is not JsonArray content)
            return result;
        var kept = new JsonArray();
        var images = result["inlineDataItems"] as JsonArray ?? new JsonArray();
        foreach (var item in content)
            if (
                item is JsonObject image
                && SessionWait.Text(image["type"]) == "image"
                && SessionWait.Text(image["data"]) is string data
                && SessionWait.Text(image["mimeType"]) is { } mime
                && mime.StartsWith("image/", StringComparison.Ordinal)
            )
            {
                var copy = (JsonObject)image.DeepClone();
                copy.Remove("type");
                images.Add(copy);
            }
            else
                kept.Add(item?.DeepClone());
        if (images.Count == 0)
            return result;
        if (kept.Count == 0)
            result.Remove("content");
        else
            result["content"] = kept;
        if (images.Parent is null)
            result["inlineDataItems"] = images;
        return result;
    }

    private static bool PlainText(JsonNode? value, out string text)
    {
        text = "";
        if (
            value is not JsonObject block
            || block.Any(pair => pair.Key is not ("type" or "text"))
            || SessionWait.Text(block["type"]) != "text"
            || SessionWait.Text(block["text"]) is not string content
        )
            return false;
        text = content;
        return true;
    }

    private static JsonNode? NormalizeResult(JsonNode? value)
    {
        if (value is not JsonObject obj)
            return value;
        var result = NormalizeImages(obj);
        if (result.TryGetPropertyValue("structuredContent", out var structured))
        {
            if (result["content"] is JsonArray blocks)
            {
                var kept = new JsonArray();
                foreach (var block in blocks)
                {
                    var duplicate = false;
                    if (PlainText(block, out var text))
                        try
                        {
                            duplicate = JsonNode.DeepEquals(JsonNode.Parse(text), structured);
                        }
                        catch (JsonException) { }
                    if (!duplicate)
                        kept.Add(block?.DeepClone());
                }
                result["content"] = kept;
            }
            var metadata = result.Any(pair =>
                pair.Key is not ("content" or "structuredContent")
                && !(pair.Key == "isError" && SessionCatalog.Flag(pair.Value) != true)
            );
            if (!metadata && (result["content"] is not JsonArray { Count: > 0 }))
                return structured?.DeepClone();
            return result;
        }
        if (
            result.Any(pair =>
                pair.Key != "content"
                && !(pair.Key == "isError" && SessionCatalog.Flag(pair.Value) != true)
            )
        )
            return result;
        if (
            result["content"] is not JsonArray { Count: 1 } content
            || !PlainText(content[0], out var plain)
        )
            return result;
        try
        {
            var parsed = JsonNode.Parse(plain);
            if (parsed is JsonObject or JsonArray)
                return parsed;
        }
        catch (JsonException) { }
        return JsonValue.Create(plain);
    }

    internal void BeginShutdown()
    {
        lock (lifecycle)
            closed = true;
        StopNotificationProducer();
        configuration.Close();
        shutdown.Cancel();
    }

    internal async Task DrainAsync()
    {
        Task[] active;
        lock (lifecycle)
            active = operations.Values.ToArray();
        try
        {
            await Task.WhenAll(active);
        }
        catch { }
        await OAuth.DrainAsync();
    }

    public async ValueTask DisposeAsync()
    {
        BeginShutdown();
        await DrainAsync();
        await CloseConnectionsAsync();
        shutdown.Dispose();
    }
}
