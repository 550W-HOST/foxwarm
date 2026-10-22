using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

public sealed class FunctionArgumentErrorTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData("7", "7")]
    [InlineData("false", "false")]
    [InlineData("[]", "")]
    [InlineData("[1,null,[true,\"x\"],{}]", "1,,true,x,[object Object]")]
    [InlineData("1e-7", "1e-7")]
    public void Raw_nonobjects_are_per_call_errors_with_source_raw_projection(
        string json,
        string raw
    )
    {
        var parsed = FunctionCallArguments.Parse(JsonNode.Parse(json));
        Assert.Empty(parsed.Args);
        Assert.Equal(raw, parsed.RawArgsText);
        Assert.NotEmpty(parsed.ArgsParseError!);
        var replay = JsonNode.Parse(
            FunctionCallArguments.Stringify(parsed.Args, parsed.RawArgsText, parsed.ArgsParseError)
        )!;
        Assert.Equal(parsed.ArgsParseError, replay["error"]!.GetValue<string>());
        Assert.Equal(raw.Length == 0 ? null : raw, SessionWait.Text(replay["rawArgsText"]));
    }

    [Theory]
    [InlineData("null", null)]
    [InlineData("{}", null)]
    [InlineData("\"\"", null)]
    [InlineData("\"{}\"", "{}")]
    [InlineData("{\"nested\":[null,1]}", null)]
    public void Supported_object_null_and_empty_inputs_remain_valid(string json, string? raw)
    {
        var parsed = FunctionCallArguments.Parse(JsonNode.Parse(json));
        Assert.Null(parsed.ArgsParseError);
        Assert.Equal(raw, parsed.RawArgsText);
        if (json.StartsWith("{\"nested"))
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(json), parsed.Args));
        else
            Assert.Empty(parsed.Args);
    }

    [Theory]
    [InlineData("7", true)]
    [InlineData("false", true)]
    [InlineData("[1,null]", true)]
    [InlineData("\"{broken\"", true)]
    [InlineData("\"[]\"", true)]
    [InlineData("null", false)]
    [InlineData("{}", false)]
    [InlineData("\"\"", false)]
    public void Completions_converter_and_serializer_share_the_argument_error_boundary(
        string json,
        bool invalid
    )
    {
        var response = JsonNode
            .Parse(
                "{\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call\",\"type\":\"function\",\"function\":{\"name\":\"read\"}}]}}]}"
            )!
            .AsObject();
        response["choices"]![0]!["message"]!["tool_calls"]![0]!["function"]!["arguments"] =
            JsonNode.Parse(json);
        var canonical = CompletionsCanonicalConverter.ConvertAssistant(
            response,
            "local/wire",
            0,
            0
        );
        var call = canonical["parts"]![0]!["functionCall"]!;
        var parsed = FunctionCallArguments.Parse(JsonNode.Parse(json));
        Assert.Equal(invalid, call["argsParseError"] is not null);
        Assert.Equal(parsed.RawArgsText, SessionWait.Text(call["rawArgsText"]));
        Assert.True(JsonNode.DeepEquals(parsed.Args, call["args"]));
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local/wire",
            "",
            "",
            1024
        );
        var wire = CompletionsRequestSerializer.BuildRequest(
            [canonical],
            options,
            "reasoning_content",
            "cache"
        );
        var replay = wire["messages"]![0]!["tool_calls"]![0]!["function"]![
            "arguments"
        ]!.GetValue<string>();
        Assert.Equal(
            FunctionCallArguments.Stringify(parsed.Args, parsed.RawArgsText, parsed.ArgsParseError),
            replay
        );
    }

    [Theory]
    [InlineData("openai-responses", "7", "7")]
    [InlineData("openai-responses", "false", "false")]
    [InlineData("openai-responses", "[1,null]", "1,")]
    [InlineData("openai-responses", "\"{broken\"", "{broken")]
    [InlineData("openai-responses", "\"[]\"", "[]")]
    [InlineData("openai-ws", "[]", "")]
    [InlineData("anthropic", "[1,null]", "1,")]
    public async Task Normal_owner_pairs_bad_call_and_executes_valid_sibling_once(
        string provider,
        string json,
        string raw
    )
    {
        await using var peer = await ArgumentPeer.StartAsync(provider, JsonNode.Parse(json));
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(peer.Uri, "wire", "local/wire", "", "", 1024);
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "local/wire",
                ["providers"] = new JsonObject
                {
                    ["local"] = new JsonObject
                    {
                        ["providerType"] = provider,
                        ["baseUrl"] = peer.Uri.ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["extraFields"] = new JsonObject
                        {
                            ["stream"] = provider is "openai-responses" or "openai-ws",
                        },
                    },
                },
            },
            new JsonObject()
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            catalog
        );
        await manager.LoadMainHostAsync();
        manager.InitializeChannels(
            new(new SessionRuntime(manager)),
            new ModelConfiguration(Path.Combine(temp.Path, "data"))
        );
        var owner = await manager.CreateNamedAsync("main", "arguments", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var sent = new List<(string Target, string Text)>();
        manager.ChannelRegistry.Register(
            "fixture",
            (target, text, _) =>
            {
                sent.Add((target, text));
                return Task.CompletedTask;
            }
        );
        try
        {
            await owner.Registry.Ingress.EnqueueAsync(
                owner.Id,
                QueueItem.UserText("send the fixture message")
            );
            await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            Assert.Equal(2, peer.Requests.Count);
            Assert.Equal(new[] { ("destination", "one effect") }, sent);
            var history = owner.History();
            Assert.Equal(
                new[] { "user", "model", "tool", "model" },
                history.Select(row => SessionWait.Text(row["role"]))
            );
            var calls = history[1]["parts"]!
                .AsArray()
                .Select(part => part!["functionCall"]!)
                .ToArray();
            Assert.Equal(
                new[] { "bad", "good" },
                calls.Select(call => SessionWait.Text(call["id"]))
            );
            Assert.Empty(calls[0]["args"]!.AsObject());
            Assert.Equal(raw, SessionWait.Text(calls[0]["rawArgsText"]));
            Assert.NotEmpty(SessionWait.Text(calls[0]["argsParseError"])!);
            Assert.Null(calls[1]["argsParseError"]);
            var results = history[2]["parts"]!
                .AsArray()
                .Select(part => part!["functionResponse"]!)
                .ToArray();
            Assert.Equal(
                new[] { "bad", "good" },
                results.Select(result => SessionWait.Text(result["tool_use_id"]))
            );
            Assert.Equal(
                "invalid_tool_arguments",
                SessionWait.Text(results[0]["response"]?["error"]?["type"])
            );
            Assert.DoesNotContain("rawArgsText", results[0]["response"]!.ToJsonString());
            Assert.Null(results[1]["response"]?["error"]);
            Assert.Equal(
                history.Select(EcmaJson.Stringify),
                owner.Archive.ReadMessages().Select(record => record.MessageJson)
            );
            // A continuation, not a response retry: both call IDs and their results are in the next physical request.
            var next = peer.Requests[1];
            if (provider == "anthropic")
            {
                var blocks = next["messages"]!
                    .AsArray()
                    .SelectMany(row => row!["content"]!.AsArray())
                    .OfType<JsonObject>()
                    .ToArray();
                var replay = blocks.Single(block => SessionWait.Text(block["id"]) == "bad")[
                    "input"
                ]!;
                Assert.Equal(
                    SessionWait.Text(calls[0]["argsParseError"]),
                    SessionWait.Text(replay["error"])
                );
                Assert.Equal(raw.Length == 0 ? null : raw, SessionWait.Text(replay["rawArgsText"]));
                Assert.Equal(
                    new[] { "bad", "good" },
                    blocks
                        .Where(block => SessionWait.Text(block["type"]) == "tool_result")
                        .Select(block => SessionWait.Text(block["tool_use_id"]))
                );
            }
            else
            {
                var input = next["input"]!.AsArray();
                var replay = input.Single(row =>
                    SessionWait.Text(row?["type"]) == "function_call"
                    && SessionWait.Text(row?["call_id"]) == "bad"
                )!;
                var safe = JsonNode.Parse(replay["arguments"]!.GetValue<string>())!;
                Assert.Equal(
                    SessionWait.Text(calls[0]["argsParseError"]),
                    SessionWait.Text(safe["error"])
                );
                Assert.Equal(raw.Length == 0 ? null : raw, SessionWait.Text(safe["rawArgsText"]));
                Assert.Equal(
                    new[] { "bad", "good" },
                    input
                        .Where(row => SessionWait.Text(row?["type"]) == "function_call_output")
                        .Select(row => SessionWait.Text(row?["call_id"]))
                );
            }
            output.WriteLine(
                new JsonObject
                {
                    ["provider"] = provider,
                    ["rawInput"] = JsonNode.Parse(json),
                    ["requests"] = peer.Requests.Count,
                    ["effects"] = sent.Count,
                    ["calls"] = history[1]["parts"]!.DeepClone(),
                    ["results"] = history[2]["parts"]!.DeepClone(),
                    ["archiveRows"] = owner.Archive.ReadMessages().Count,
                    ["nextInput"] = (next["input"] ?? next["messages"])!.DeepClone(),
                }.ToJsonString()
            );
        }
        finally
        {
            manager.BeginShutdown();
            await manager.ManagedChannels!.DisposeAsync();
            await manager.ShutdownAsync();
        }
    }

    private sealed class ArgumentPeer(WebApplication app, string provider, JsonNode? bad)
        : IAsyncDisposable
    {
        internal Uri Uri { get; private set; } = null!;
        internal List<JsonObject> Requests { get; } = [];

        internal static async Task<ArgumentPeer> StartAsync(string provider, JsonNode? bad)
        {
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            var app = builder.Build();
            var peer = new ArgumentPeer(app, provider, bad);
            app.UseWebSockets();
            app.Map("/{**path}", peer.HandleAsync);
            await app.StartAsync();
            peer.Uri = new Uri(app.Urls.Single());
            return peer;
        }

        private JsonObject Respond(JsonObject request)
        {
            Requests.Add(request);
            var first = Requests.Count == 1;
            var args = new JsonObject
            {
                ["channelTargetId"] = "fixture:destination",
                ["message"] = "one effect",
            };
            JsonObject Call(string id, JsonNode? input) =>
                provider switch
                {
                    "anthropic" => new()
                    {
                        ["type"] = "tool_use",
                        ["id"] = id,
                        ["name"] = "send_to_channel",
                        ["input"] = input,
                    },
                    _ => new()
                    {
                        ["type"] = "function_call",
                        ["call_id"] = id,
                        ["name"] = "send_to_channel",
                        ["arguments"] = input,
                    },
                };
            var calls = new JsonArray(
                Call("bad", bad?.DeepClone()),
                Call("good", provider == "anthropic" ? args : JsonValue.Create(args.ToJsonString()))
            );
            return provider switch
            {
                "anthropic" => new()
                {
                    ["id"] = "reply",
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["stop_reason"] = first ? "tool_use" : "end_turn",
                    ["content"] = first
                        ? calls
                        : new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "done" }),
                },
                _ => new()
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "reply-" + Requests.Count,
                        ["output"] = first
                            ? calls
                            : new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "message",
                                    ["role"] = "assistant",
                                    ["content"] = new JsonArray(
                                        new JsonObject
                                        {
                                            ["type"] = "output_text",
                                            ["text"] = "done",
                                        }
                                    ),
                                }
                            ),
                    },
                },
            };
        }

        private async Task HandleAsync(HttpContext context)
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                var result = Respond((await JsonNode.ParseAsync(context.Request.Body))!.AsObject());
                if (provider == "openai-responses")
                {
                    context.Response.ContentType = "text/event-stream";
                    await context.Response.WriteAsync("data: " + result.ToJsonString() + "\n\n");
                }
                else
                    await context.Response.WriteAsJsonAsync(result);
                return;
            }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            var buffer = new byte[65536];
            using var bytes = new MemoryStream();
            while (socket.State == WebSocketState.Open)
            {
                var read = await socket.ReceiveAsync(buffer.AsMemory(), context.RequestAborted);
                if (read.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseOutputAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "OK",
                        default
                    );
                    return;
                }
                bytes.Write(buffer, 0, read.Count);
                if (!read.EndOfMessage)
                    continue;
                var result = Respond(JsonNode.Parse(bytes.ToArray())!.AsObject());
                bytes.SetLength(0);
                await socket.SendAsync(
                    Encoding.UTF8.GetBytes(result.ToJsonString()).AsMemory(),
                    WebSocketMessageType.Text,
                    true,
                    context.RequestAborted
                );
            }
        }

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }
}
