using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm;

internal sealed partial class McpClient(string root) : IAsyncDisposable
{
    private readonly McpConfiguration configuration = new(root);
    private readonly object lifecycle = new();
    private readonly Dictionary<long, Task> operations = [];
    private readonly CancellationTokenSource shutdown = new();
    private long nextOperation;
    private bool closed;

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
                    await configuration.UpdateAsync(
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
        CancellationToken cancellationToken
    ) =>
        RunAsync(
            async token =>
            {
                var config = configuration.Get(server);
                try
                {
                    return await WithClientAsync(
                        server,
                        config,
                        token,
                        async client =>
                        {
                            var tools = new List<JsonObject>();
                            string? cursor = null;
                            do
                            {
                                var page = await client.ListToolsAsync(
                                    new ListToolsRequestParams { Cursor = cursor },
                                    token
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
                        }
                    );
                }
                catch (Exception error) when (!token.IsCancellationRequested)
                {
                    throw new InvalidOperationException(SafeError(error.Message, config));
                }
            },
            cancellationToken
        );

    internal Task<JsonObject> CallAsync(
        string server,
        string name,
        JsonObject args,
        CancellationToken cancellationToken
    ) =>
        RunAsync(
            async token =>
            {
                var config = configuration.Get(server);
                try
                {
                    return await WithClientAsync(
                        server,
                        config,
                        token,
                        async client =>
                        {
                            using var callBudget = CancellationTokenSource.CreateLinkedTokenSource(
                                token
                            );
                            callBudget.CancelAfter(
                                TimeSpan.FromSeconds(
                                    SessionWait.Number(config["timeoutSeconds"]) ?? 60
                                )
                            );
                            var request = new JsonRpcRequest
                            {
                                Method = RequestMethods.ToolsCall,
                                Params = new JsonObject
                                {
                                    ["name"] = name,
                                    ["arguments"] = args.DeepClone(),
                                },
                            };
                            var stdio = SessionWait.Text(config["transport"]) == "stdio";
                            if (stdio)
                                request.Id = new RequestId(
                                    "foxwarm-call-" + Guid.NewGuid().ToString("N")
                                );
                            callBudget.Token.ThrowIfCancellationRequested();
                            JsonRpcResponse result;
                            try
                            {
                                result = await client.SendRequestAsync(request, callBudget.Token);
                            }
                            catch (OperationCanceledException)
                            {
                                // Keep the original local cancellation outcome. A late notification
                                // only asks the stdio peer to cancel; it cannot reverse effects.
                                if (stdio)
                                {
                                    using var notificationBudget = new CancellationTokenSource(
                                        TimeSpan.FromSeconds(1)
                                    );
                                    try
                                    {
                                        await client.SendMessageAsync(
                                            new JsonRpcNotification
                                            {
                                                Method = NotificationMethods.CancelledNotification,
                                                Params = JsonSerializer.SerializeToNode(
                                                    new CancelledNotificationParams
                                                    {
                                                        RequestId = request.Id,
                                                    },
                                                    McpJsonUtilities.DefaultOptions
                                                ),
                                            },
                                            notificationBudget.Token
                                        );
                                    }
                                    catch
                                    { /* Best effort; never replace the timeout/Stop result. */
                                    }
                                }
                                if (!token.IsCancellationRequested)
                                    throw new TimeoutException("MCP tool call timed out.");
                                throw;
                            }
                            var owned = result.Result is JsonObject obj
                                ? (JsonObject)obj.DeepClone()
                                : throw new InvalidDataException(
                                    "MCP tools/call returned a non-object result."
                                );
                            if (
                                owned["content"] is JsonArray content
                                && content.Any(UnsupportedContent)
                            )
                                throw new NotSupportedException(
                                    "MCP result contains unsupported audio or binary content. The server call completed; its effects were not reversed."
                                );
                            return NormalizeResult(NormalizeImages(owned));
                        }
                    );
                }
                catch (Exception error) when (!token.IsCancellationRequested)
                {
                    throw new InvalidOperationException(SafeError(error.Message, config));
                }
            },
            cancellationToken
        );

    private static bool UnsupportedContent(JsonNode? value)
    {
        var kind = SessionWait.Text(value?["type"]);
        return kind is "audio"
            || kind == "resource"
                && value?["resource"] is JsonObject resource
                && resource["blob"] is not null;
    }

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

    private static JsonObject NormalizeResult(JsonObject result)
    {
        var metadata = result.Any(pair =>
            pair.Key != "content"
            && !(
                pair.Key == "isError"
                && pair.Value is JsonValue value
                && value.TryGetValue<bool>(out var error)
                && !error
            )
        );
        if (
            !metadata
            && result["content"] is JsonArray { Count: 1 } content
            && content[0] is JsonObject block
            && block.All(pair => pair.Key is "type" or "text")
            && SessionWait.Text(block["type"]) == "text"
            && SessionWait.Text(block["text"]) is string text
        )
        {
            try
            {
                var parsed = JsonNode.Parse(text);
                if (parsed is JsonObject obj)
                    return obj;
                if (parsed is JsonArray array)
                    return new JsonObject { ["output"] = array };
            }
            catch (JsonException) { }
            return new JsonObject { ["output"] = text };
        }
        return result;
    }

    internal void BeginShutdown()
    {
        lock (lifecycle)
            closed = true;
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
    }

    public async ValueTask DisposeAsync()
    {
        BeginShutdown();
        await DrainAsync();
        await CloseConnectionsAsync();
        shutdown.Dispose();
    }
}
