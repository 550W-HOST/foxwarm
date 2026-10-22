using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

public sealed class DefaultToolWireTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData("openai-responses")]
    [InlineData("openai-ws")]
    public async Task Ordinary_owner_catalog_passes_validating_transport_and_dispatches_channel_send(
        string providerType
    )
    {
        await using var peer = await ToolWirePeer.StartAsync();
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(peer.Uri, "wire", "local/wire", "", "", 1024);
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            Catalog(peer.Uri, providerType)
        );
        await manager.LoadMainHostAsync();
        manager.InitializeChannels(new(new SessionRuntime(manager)), new ModelConfiguration(Path.Combine(temp.Path, "data")));
        var owner = await manager.CreateNamedAsync("main", "wire", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var sent = new List<(string Target, string Text)>();
        manager.ChannelRegistry.Register("fixture", (target, text, _) =>
        {
            sent.Add((target, text));
            return Task.CompletedTask;
        });
        try
        {
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("send the fixture message"));
            try
            {
                await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(15));
            }
            finally
            {
                if (peer.Requests.Count > 0)
                    output.WriteLine(providerType + " wire tools: " + Shapes(peer.Requests[0]["tools"]!.AsArray()).ToJsonString());
            }
            Assert.Empty(peer.Errors);
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            Assert.Equal(2, peer.Requests.Count);
            Assert.Equal(new[] { ("destination", "fixture message") }, sent);
            Assert.Contains(owner.History(), row => row["parts"]!.AsArray().Any(part =>
                SessionWait.Text(part?["functionResponse"]?["name"]) == "send_to_channel"));
            foreach (var request in peer.Requests)
            {
                var tools = request["tools"]!.AsArray();
                var selected = manager.ModelDefinitions(owner);
                var functions = tools.OfType<JsonObject>().Where(tool => SessionWait.Text(tool["type"]) == "function").ToArray();
                Assert.Equal(selected.Count, functions.Length);
                for (var index = 0; index < selected.Count; index++)
                    Assert.True(JsonNode.DeepEquals(selected[index], functions[index]));
                Assert.Contains(tools, tool => SessionWait.Text(tool?["name"]) == "send_to_channel");
                Assert.Contains(tools, tool => SessionWait.Text(tool?["name"]) == "read");
                Assert.Contains(tools, tool => SessionWait.Text(tool?["type"]) == "web_search");
                Assert.Contains(tools, tool => SessionWait.Text(tool?["type"]) == "image_generation");
                Assert.DoesNotContain(tools.OfType<JsonObject>(), tool => tool.ContainsKey("defaultInject"));
            }
            Assert.Equal(providerType == "openai-ws", peer.Requests[1].ContainsKey("previous_response_id"));
            Assert.Contains(peer.Requests[1]["input"]!.AsArray(), item => SessionWait.Text(item?["type"]) == "function_call_output");
            Assert.Null(manager.ChannelBinding("fixture:destination"));
        }
        finally
        {
            manager.BeginShutdown();
            await manager.ManagedChannels!.DisposeAsync();
            await manager.ShutdownAsync();
        }
    }

    [Fact]
    public void Local_declarations_include_function_type_for_discovery_only_and_default_tools()
    {
        var definitions = UnifiedToolDefinitions.All()
            .Concat(MainBrowserDefinitions.All())
            .Append(ArtifactToolDefinition.Definition());
        foreach (var definition in definitions.OfType<JsonObject>())
        {
            output.WriteLine(definition["name"] + " type=" + (SessionWait.Text(definition["type"]) ?? "<missing>"));
            Assert.Null(ToolWirePeer.FunctionError(definition));
        }
    }

    [Fact]
    public async Task Non_responses_conversions_preserve_the_selected_catalog_function_schemas()
    {
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "local/wire", "", "", 1024);
        await using var manager = new SessionManager(Path.Combine(temp.Path, "data"), Path.Combine(temp.Path, "work"), options, HostModels.ForTest(options));
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "conversions", null, null);
        var definitions = manager.ModelDefinitions(owner);
        options = options with { Tools = definitions };
        var completions = CompletionsRequestSerializer.BuildRequest([], options, "reasoning_content", "cache");
        var anthropic = AnthropicRequestSerializer.BuildRequest([], options);
        var completionTools = completions["tools"]!.AsArray();
        var anthropicTools = anthropic["tools"]!.AsArray();
        Assert.Equal(definitions.Count, completionTools.Count);
        Assert.Equal(definitions.Count, anthropicTools.Count);
        for (var index = 0; index < definitions.Count; index++)
        {
            var original = definitions[index]!;
            Assert.Equal("function", SessionWait.Text(completionTools[index]?["type"]));
            var function = completionTools[index]!["function"]!;
            Assert.Equal(SessionWait.Text(original["name"]), SessionWait.Text(function["name"]));
            Assert.True(JsonNode.DeepEquals(original["parameters"], function["parameters"]));
            Assert.Equal(SessionWait.Text(original["name"]), SessionWait.Text(anthropicTools[index]?["name"]));
            Assert.True(JsonNode.DeepEquals(original["parameters"], anthropicTools[index]?["input_schema"]));
        }
        Assert.Contains(definitions, tool => SessionWait.Text(tool?["name"]) == "send_to_channel");
        await manager.ShutdownAsync();
    }

    private static HostModels Catalog(Uri uri, string providerType) => HostModels.Parse(
        new JsonObject
        {
            ["default"] = "local/wire",
            ["providers"] = new JsonObject
            {
                ["local"] = new JsonObject
                {
                    ["providerType"] = providerType,
                    ["baseUrl"] = uri.ToString(),
                    ["models"] = new JsonArray("wire"),
                    ["webSearch"] = new JsonObject { ["enabled"] = true },
                    ["imageGeneration"] = new JsonObject { ["enabled"] = true },
                },
            },
        }, new JsonObject());

    private static JsonArray Shapes(JsonArray tools) => new(tools.OfType<JsonObject>().Select(tool => (JsonNode)new JsonObject
    {
        ["name"] = tool["name"]?.DeepClone(),
        ["type"] = tool["type"]?.DeepClone(),
        ["keys"] = new JsonArray(tool.Select(pair => (JsonNode?)JsonValue.Create(pair.Key)).ToArray()),
    }).ToArray());
}

// This peer checks the actual serialized request, rather than accepting arbitrary tool arrays.
internal sealed class ToolWirePeer : IAsyncDisposable
{
    private readonly WebApplication app;
    internal Uri Uri { get; private set; } = null!;
    internal List<JsonObject> Requests { get; } = [];
    internal List<string> Errors { get; } = [];

    private ToolWirePeer(WebApplication app) => this.app = app;

    internal static async Task<ToolWirePeer> StartAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        var peer = new ToolWirePeer(app);
        app.UseWebSockets();
        app.Map("/responses", peer.HandleAsync);
        await app.StartAsync();
        peer.Uri = new Uri(app.Urls.Single());
        return peer;
    }

    internal static string? FunctionError(JsonObject tool)
    {
        if (SessionWait.Text(tool["type"]) != "function")
            return "Unsupported tool type: " + (SessionWait.Text(tool["type"]) ?? "None");
        if (string.IsNullOrWhiteSpace(SessionWait.Text(tool["name"])))
            return "Function name is required";
        if (tool["parameters"] is not JsonObject schema || SessionWait.Text(schema["type"]) != "object")
            return "Function parameters must be an object schema";
        return null;
    }

    private JsonObject Process(JsonObject wire)
    {
        Requests.Add(wire);
        string? error = null;
        if (wire["tools"] is not JsonArray { Count: > 0 } tools)
            error = "Expected the ordinary tool catalog";
        else
            foreach (var value in tools)
            {
                if (value is not JsonObject tool)
                {
                    error = "Tool declarations must be objects";
                    break;
                }
                var type = SessionWait.Text(tool["type"]);
                error = type is "web_search" or "image_generation"
                    ? tool.ContainsKey("name") || tool.ContainsKey("parameters") ? "Native tool converted to a function" : null
                    : FunctionError(tool);
                if (error is not null)
                    break;
            }
        if (error is not null)
        {
            Errors.Add(error);
            return new JsonObject { ["type"] = "error", ["error"] = new JsonObject { ["message"] = error, ["type"] = "invalid_request_error", ["code"] = "invalid_request_error" } };
        }
        var response = ResponsesWsTests.Response(Requests.Count);
        if (Requests.Count == 1)
            response["output"] = new JsonArray(new JsonObject
            {
                ["type"] = "function_call",
                ["call_id"] = "fixture-send",
                ["name"] = "send_to_channel",
                ["arguments"] = "{\"channelTargetId\":\"fixture:destination\",\"message\":\"fixture message\"}",
            });
        return new JsonObject { ["type"] = "response.completed", ["response"] = response };
    }

    private async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            var wire = (await JsonNode.ParseAsync(context.Request.Body))!.AsObject();
            var result = Process(wire);
            if (SessionWait.Text(result["type"]) == "error")
            {
                context.Response.StatusCode = 400;
                await context.Response.WriteAsJsonAsync(result);
            }
            else
            {
                context.Response.ContentType = "text/event-stream";
                await context.Response.WriteAsync("data: " + result.ToJsonString() + "\n\n");
            }
            return;
        }
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        var buffer = new byte[16384];
        using var bytes = new MemoryStream();
        while (socket.State == WebSocketState.Open && !context.RequestAborted.IsCancellationRequested)
        {
            var read = await socket.ReceiveAsync(buffer.AsMemory(), context.RequestAborted);
            if (read.MessageType == WebSocketMessageType.Close)
            {
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "OK", default);
                return;
            }
            bytes.Write(buffer, 0, read.Count);
            if (!read.EndOfMessage)
                continue;
            var wire = JsonNode.Parse(bytes.ToArray())!.AsObject();
            bytes.SetLength(0);
            var result = Process(wire);
            await socket.SendAsync(Encoding.UTF8.GetBytes(result.ToJsonString()).AsMemory(), WebSocketMessageType.Text, true, context.RequestAborted);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }
}
