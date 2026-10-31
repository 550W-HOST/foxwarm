using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Http.Features;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Foxwarm.Sessions;

// Stateless SDK framing; the authenticated run owns all semantics, not the HTTP client.
internal sealed class RuntimeMcpService(SessionRuntimeCredentialStore credentials)
{
    internal void Register(WebApplication app) =>
        app.MapMethods("/runtime/mcp", ["POST", "GET", "DELETE"], HandleAsync);

    internal async Task HandleAsync(HttpContext http)
    {
        var values = http.Request.Headers.Authorization;
        var authorization = values.Count == 1 ? values[0] : null;
        var run =
            authorization?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true
                ? credentials.Authenticate(authorization[7..])
                : null;
        if (run is null)
        {
            http.Response.StatusCode = 401;
            return;
        }
        if (http.Request.Headers.ContainsKey("Origin"))
        {
            http.Response.StatusCode = 403;
            return;
        }
        if (http.Request.Method != "POST")
        {
            http.Response.StatusCode = 405;
            return;
        }
        if (http.Request.ContentType?.Split(';')[0].Trim() != "application/json")
        {
            http.Response.StatusCode = 415;
            return;
        }
        var accept = http.Request.Headers.Accept.ToString();
        if (
            !accept.Contains("application/json", StringComparison.Ordinal)
            || !accept.Contains("text/event-stream", StringComparison.Ordinal)
        )
        {
            http.Response.StatusCode = 406;
            return;
        }
        if (http.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = McpInboundHttp.MaxBodyBytes;
        using var body = new MemoryStream();
        try
        {
            var bytes = new byte[8192];
            int count;
            while ((count = await http.Request.Body.ReadAsync(bytes, http.RequestAborted)) > 0)
            {
                if (body.Length + count > McpInboundHttp.MaxBodyBytes)
                {
                    http.Response.StatusCode = 413;
                    return;
                }
                body.Write(bytes, 0, count);
            }
            var message =
                JsonSerializer.Deserialize<JsonRpcMessage>(
                    body.ToArray(),
                    McpJsonUtilities.DefaultOptions
                ) ?? throw new JsonException();
            run.Require();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                http.RequestAborted,
                run.Cancellation.Token
            );
            await using var transport = new StreamableHttpServerTransport { Stateless = true };
            JsonObject? rawResult = null;
            var options = new McpServerOptions
            {
                ServerInfo = new() { Name = "foxwarm-runtime", Version = ProductVersion.Value },
                ProtocolVersion = "2025-11-25",
                Capabilities = new() { Tools = new() },
                Handlers = new()
                {
                    ListToolsHandler = (_, _) =>
                    {
                        run.Require();
                        var declarations = new JsonArray(
                            (
                                run.Definitions
                                ?? throw new InvalidOperationException(
                                    "Runtime tool definitions are unavailable."
                                )
                            )()
                                .OfType<JsonObject>()
                                .Select(d =>
                                    (JsonNode)
                                        new JsonObject
                                        {
                                            ["name"] = d["name"]!.DeepClone(),
                                            ["description"] = d["description"]?.DeepClone() ?? "",
                                            ["inputSchema"] =
                                                d["parameters"]?.DeepClone()
                                                ?? new JsonObject { ["type"] = "object" },
                                        }
                                )
                                .ToArray()
                        );
                        return ValueTask.FromResult(
                            JsonSerializer.Deserialize<ListToolsResult>(
                                new JsonObject { ["tools"] = declarations }.ToJsonString(),
                                McpJsonUtilities.DefaultOptions
                            )!
                        );
                    },
                    CallToolHandler = async (request, token) =>
                    {
                        run.Require();
                        var name = request.Params?.Name ?? "";
                        if (string.IsNullOrWhiteSpace(name))
                            throw new InvalidOperationException("Unknown runtime MCP tool.");
                        var args = request.Params?.Arguments is { } supplied
                            ? JsonSerializer
                                .SerializeToNode(supplied, McpJsonUtilities.DefaultOptions)!
                                .AsObject()
                            : new JsonObject();
                        using var operation = CancellationTokenSource.CreateLinkedTokenSource(
                            token,
                            linked.Token
                        );
                        rawResult = await (
                            run.Call
                            ?? throw new InvalidOperationException(
                                "Runtime callback is unavailable."
                            )
                        )(name, args, operation.Token);
                        if (
                            System.Text.Encoding.UTF8.GetByteCount(rawResult.ToJsonString())
                            > McpInboundHttp.MaxResultBytes
                        )
                            rawResult = McpInboundCatalog.Error(
                                "Tool completed, but its MCP result exceeded the size limit. Do not retry automatically."
                            );
                        return new CallToolResult();
                    },
                },
            };
            options.Filters.Message.OutgoingFilters.Add(next =>
                (outgoing, token) =>
                {
                    if (
                        outgoing.JsonRpcMessage is JsonRpcResponse response
                        && rawResult is not null
                    )
                        response.Result = rawResult;
                    return next(outgoing, token);
                }
            );
            await using var server = McpServer.Create(transport, options);
            var processing = server.RunAsync(linked.Token);
            try
            {
                http.Response.ContentType = "text/event-stream";
                http.Response.Headers.CacheControl = "no-store";
                var wrote = await transport.HandlePostRequestAsync(
                    message,
                    http.Response.Body,
                    linked.Token
                );
                if (!wrote)
                {
                    http.Response.ContentType = null;
                    http.Response.StatusCode = 202;
                }
            }
            finally
            {
                await transport.DisposeAsync();
                try
                {
                    await processing;
                }
                catch (OperationCanceledException) { }
            }
        }
        catch (JsonException)
        {
            if (!http.Response.HasStarted)
                http.Response.StatusCode = 400;
            else
                http.Abort();
        }
        catch (OperationCanceledException)
        {
            if (!http.Response.HasStarted)
                http.Response.StatusCode = 409;
            else
                http.Abort();
        }
        catch (InvalidOperationException)
        {
            if (!http.Response.HasStarted)
                http.Response.StatusCode = 401;
            else
                http.Abort();
        }
    }

    internal static JsonObject ToolResult(JsonObject row)
    {
        var parts = (row["parts"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
        var response = parts
            .Select(p => p["functionResponse"]?["response"])
            .FirstOrDefault(p => p is not null);
        var result = McpInboundCatalog.Result(response?.DeepClone());
        if (response is JsonObject value && value["error"] is not null)
            result["isError"] = true;
        var content = result["content"]!.AsArray();
        foreach (var part in parts)
            if (
                part["inlineData"] is JsonObject inline
                && SessionWait.Text(inline["mimeType"]) is { } mime
                && SessionWait.Text(inline["data"]) is { } data
            )
                content.Add(
                    new JsonObject
                    {
                        ["type"] = "image",
                        ["mimeType"] = mime,
                        ["data"] = data,
                    }
                );
        return result;
    }
}
