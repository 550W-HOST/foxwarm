using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Google.Protobuf;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class OtlpTraceTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Main_exports_a_turn_with_retries_and_tools_to_its_configured_OTLP_receiver(
        bool capture
    )
    {
        var requests =
            new ConcurrentQueue<(string? Authorization, string? ContentType, byte[] Body)>();
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var collector = builder.Build();
        collector.MapPost(
            "/v1/traces",
            async (HttpContext context) =>
            {
                using var bytes = new MemoryStream();
                await context.Request.Body.CopyToAsync(bytes);
                requests.Enqueue(
                    (
                        context.Request.Headers.Authorization,
                        context.Request.ContentType,
                        bytes.ToArray()
                    )
                );
                return Results.Bytes([], "application/x-protobuf");
            }
        );
        await collector.StartAsync();
        await using var mcp = await StatelessSdkPeer.StartAsync();
        await using var provider = await StreamingModelPeer.StartAsync(
            false,
            (context, attempt) =>
                context.Send(
                    JsonNode
                        .Parse(
                            attempt switch
                            {
                                1 =>
                                    """{"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"provider failed"}}}""",
                                2 =>
                                    """{"type":"response.completed","response":{"output":[{"type":"function_call","id":"fc_read","call_id":"call_read","name":"read","arguments":"{\"filePath\":\"example.txt\"}"},{"type":"function_call","id":"fc_bad","call_id":"call_bad","name":"read","arguments":"{"},{"type":"function_call","id":"fc_mcp","call_id":"call_mcp","name":"ctl","arguments":"MCP_ARGS"}]}}""".Replace(
                                        "\"MCP_ARGS\"",
                                        JsonValue
                                            .Create(
                                                OutboundMcpFixture.Call(
                                                    "value",
                                                    new JsonObject { ["kind"] = "error" }
                                                )["args"]!.ToJsonString()
                                            )
                                            .ToJsonString()
                                    ),
                                _ =>
                                    """{"type":"response.completed","response":{"usage":{"input_tokens":17,"output_tokens":6,"input_tokens_details":{"cached_tokens":3}},"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"synthetic reasoning"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"synthetic answer"}]}]}}""",
                            }
                        )!
                        .AsObject()
                )
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var state = Path.Combine(data, "state");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(state);
        var otlp = new JsonObject
        {
            ["endpoint"] = collector.Urls.Single() + "/v1/traces",
            ["headers"] = new JsonObject { ["Authorization"] = "Bearer ${secret:fixture-key}" },
        };
        if (!capture)
        {
            otlp["captureContent"] = new JsonObject
            {
                ["systemPrompt"] = false,
                ["inputMessages"] = false,
                ["outputMessages"] = false,
                ["toolDefinitions"] = false,
                ["toolArguments"] = false,
                ["toolResults"] = false,
                ["reasoning"] = false,
            };
        }
        await File.WriteAllTextAsync(
            Path.Combine(state, "config.yaml"),
            new JsonObject { ["otlp"] = otlp }.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(state, "models.yaml"),
            new JsonObject
            {
                ["defaults"] = new JsonObject
                {
                    ["retryIntervalsMs"] = new JsonArray(JsonValue.Create(0)),
                },
                ["default"] = "test/wire",
                ["providers"] = new JsonObject
                {
                    ["test"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = provider.Uri.AbsoluteUri.TrimEnd('/'),
                        ["models"] = new JsonArray(JsonValue.Create("wire")),
                    },
                },
            }.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(state, "mcp.json"),
            new JsonObject
            {
                ["servers"] = new JsonObject
                {
                    ["peer"] = new JsonObject
                    {
                        ["url"] = mcp.Url,
                        ["transport"] = "streamable-http",
                    },
                },
            }.ToJsonString()
        );
        var config = new ModelConfiguration(data);
        config.Secrets.Store.Set("fixture-key", "test-collector-key-000001");
        var http = new HttpServerSettings(
            0,
            "",
            "127.0.0.1",
            new("http://127.0.0.1", "", "/", false),
            false,
            HttpEnabled: false
        );
        string sessionId;
        await using (var host = await MainHost.CreateAsync([], data, work, config, http, null))
        {
            await host.StartAsync();
            using var unrelated = new ActivitySource("Unrelated.Test");
            Assert.False(unrelated.HasListeners());
            var owner = await host.Sessions.CreateNamedAsync("main", "trace", null, null);
            sessionId = owner.Id;
            await File.WriteAllTextAsync(
                Path.Combine(host.Sessions.AgentDirectory(owner.Agent), "example.txt"),
                "synthetic tool output"
            );
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await new SessionRuntime(host.Sessions).SubmitAndRunAsync(
                owner.Id,
                QueueItem.UserText("synthetic input " + new string('♥', 9000))
            );
            await owner
                .Registry.Runner.ProcessQueueAsync(owner.Id)
                .WaitAsync(TimeSpan.FromSeconds(15));
        }

        Assert.NotEmpty(requests);
        Assert.All(
            requests,
            request =>
            {
                Assert.Equal("Bearer test-collector-key-000001", request.Authorization);
                Assert.Equal("application/x-protobuf", request.ContentType);
            }
        );
        var spans = requests
            .SelectMany(request => Fields(request.Body, 1, 2, 2).Select(ParseSpan))
            .ToArray();
        var run = Assert.Single(spans, span => span.Name == "foxwarm.run");
        Assert.Equal("completed", run.Attributes["foxwarm.outcome"]);
        Assert.Null(run.Parent);
        Assert.All(
            spans,
            span => Assert.Equal(sessionId, span.Attributes["gen_ai.conversation.id"])
        );
        Assert.All(
            spans.Where(span => span != run),
            span =>
            {
                Assert.Equal(run.Trace, span.Trace);
                Assert.Equal(run.Id, span.Parent);
            }
        );
        var models = spans.Where(span => span.Name == "chat wire").ToArray();
        Assert.Equal(3, models.Length);
        var failed = Assert.Single(models, span => span.Attributes["foxwarm.outcome"] == "failed");
        Assert.Contains("error.type", failed.Attributes);
        var final = Assert.Single(
            models,
            span => span.Attributes.ContainsKey("gen_ai.usage.input_tokens")
        );
        Assert.Equal("17", final.Attributes["gen_ai.usage.input_tokens"]);
        Assert.Equal("3", final.Attributes["gen_ai.usage.cache_read.input_tokens"]);
        var tools = spans.Where(span => span.Name == "execute_tool read").ToArray();
        Assert.Equal(2, tools.Length);
        var read = Assert.Single(
            tools,
            span => span.Attributes["gen_ai.tool.call.id"] == "call_read"
        );
        Assert.Equal("completed", read.Attributes["foxwarm.outcome"]);
        Assert.Equal("node", read.Attributes["foxwarm.tool.source"]);
        Assert.Equal("master", read.Attributes["foxwarm.tool.node"]);
        var skipped = Assert.Single(tools, span => span.Attributes["foxwarm.outcome"] == "skipped");
        Assert.Equal("False", skipped.Attributes["foxwarm.tool.started"]);
        var mcpFailure = Assert.Single(
            spans,
            span => span.Attributes.GetValueOrDefault("gen_ai.tool.call.id") == "call_mcp"
        );
        Assert.Equal("mcp", mcpFailure.Attributes.GetValueOrDefault("foxwarm.tool.source"));
        Assert.Equal("True", mcpFailure.Attributes["foxwarm.tool.started"]);
        Assert.Equal("failed", mcpFailure.Attributes["foxwarm.outcome"]);
        Assert.Equal("mcp_tool_error", mcpFailure.Attributes["error.type"]);
        if (capture)
        {
            Assert.Contains("gen_ai.system_instructions", final.Attributes);
            Assert.Contains("gen_ai.tool.definitions", final.Attributes);
            Assert.Contains("synthetic input", provider.Requests[0].ToJsonString());
            Assert.Contains("synthetic input", failed.Attributes["gen_ai.input.messages"]);
            Assert.Contains("synthetic reasoning", final.Attributes["gen_ai.output.messages"]);
            Assert.Contains("synthetic answer", final.Attributes["gen_ai.output.messages"]);
            Assert.Equal(
                "stop",
                JsonNode.Parse(final.Attributes["gen_ai.output.messages"])![0]![
                    "finish_reason"
                ]!.GetValue<string>()
            );
            var toolRequest = Assert.Single(
                models,
                span => span.Attributes["foxwarm.model.attempt"] == "2"
            );
            Assert.Equal(
                "tool_call",
                JsonNode.Parse(toolRequest.Attributes["gen_ai.output.messages"])![0]![
                    "finish_reason"
                ]!.GetValue<string>()
            );
            Assert.Contains("example.txt", read.Attributes["gen_ai.tool.call.arguments"]);
            Assert.Contains("synthetic tool output", read.Attributes["gen_ai.tool.call.result"]);
            foreach (
                var (key, value) in spans
                    .SelectMany(span => span.Attributes)
                    .Where(item => IsContent(item.Key))
            )
            {
                Assert.True(Encoding.UTF8.GetByteCount(value) <= 16 * 1024, key);
                Assert.NotNull(JsonNode.Parse(value));
            }
        }
        else
            Assert.DoesNotContain(spans.SelectMany(span => span.Attributes.Keys), IsContent);
    }

    [Fact]
    public void Bad_content_keeps_model_and_tool_metadata_and_outcomes()
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        File.WriteAllText(
            Path.Combine(state, "config.yaml"),
            "otlp: {endpoint: 'http://127.0.0.1:1/v1/traces'}"
        );
        var configuration = new ModelConfiguration(temp.Path);
        using var secrets = configuration.Secrets;
        using var traces = Assert.IsType<Foxwarm.Telemetry.FoxwarmTraces>(
            Foxwarm.Telemetry.FoxwarmTraces.Open(configuration)
        );
        var catalog = HostModels.ForTest(
            new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "test/wire",
                "",
                "",
                50
            )
        );
        var model = catalog.Resolve(catalog.DefaultKey);
        var invalid = new JsonObject { ["number"] = JsonValue.Create(double.NaN) };
        using var attempt = traces.StartModel(
            "s",
            model,
            model.ProviderType,
            model.Key,
            "canonical",
            1,
            new JsonObject
            {
                ["tools"] = new JsonArray(
                    new JsonObject { ["name"] = "fixture", ["parameters"] = invalid.DeepClone() }
                ),
            }
        );
        Assert.NotNull(attempt);
        Assert.Equal(true, attempt.GetTagItem("foxwarm.content.capture_failed"));
        Assert.Null(attempt.GetTagItem("gen_ai.tool.definitions"));
        Assert.Equal("wire", attempt.GetTagItem("gen_ai.request.model"));
        attempt.SetTag("foxwarm.content.capture_failed", null);
        traces.CompleteModel(
            attempt,
            new ChatResult(
                new JsonObject
                {
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["functionCall"] = new JsonObject
                            {
                                ["name"] = "fixture",
                                ["args"] = invalid.DeepClone(),
                            },
                        }
                    ),
                }
            )
        );
        Assert.Equal(true, attempt.GetTagItem("foxwarm.content.capture_failed"));
        Assert.Null(attempt.GetTagItem("gen_ai.output.messages"));

        using var tool = traces.StartTool(
            "s",
            new JsonObject { ["name"] = "fixture", ["args"] = invalid.DeepClone() }
        );
        Assert.NotNull(tool);
        Assert.Equal(true, tool.GetTagItem("foxwarm.content.capture_failed"));
        Assert.Null(tool.GetTagItem("gen_ai.tool.call.arguments"));
        tool.SetTag("foxwarm.content.capture_failed", null);
        traces.CompleteTool(tool, new Foxwarm.Tools.TurnToolExecution(invalid), started: true);
        Assert.Equal(true, tool.GetTagItem("foxwarm.content.capture_failed"));
        Assert.Equal("completed", tool.GetTagItem("foxwarm.outcome"));
        Assert.Null(tool.GetTagItem("gen_ai.tool.call.result"));
    }

    private static bool IsContent(string key) =>
        key
            is "gen_ai.system_instructions"
                or "gen_ai.input.messages"
                or "gen_ai.output.messages"
                or "gen_ai.tool.definitions"
                or "gen_ai.tool.call.arguments"
                or "gen_ai.tool.call.result";

    // Read the OTLP fields the test verifies using the existing Protobuf reader. The
    // collector sees serialized bytes from the real exporter, not Activity test callbacks.
    private static IEnumerable<byte[]> Fields(byte[] message, params int[] path)
    {
        using var input = new CodedInputStream(message);
        while (input.ReadTag() is uint tag && tag != 0)
        {
            if (WireFormat.GetTagFieldNumber(tag) != path[0])
                input.SkipLastField();
            else
            {
                var value = input.ReadBytes().ToByteArray();
                if (path.Length == 1)
                    yield return value;
                else
                    foreach (var child in Fields(value, path[1..]))
                        yield return child;
            }
        }
    }

    private static Span ParseSpan(byte[] message) =>
        new(
            Encoding.UTF8.GetString(Fields(message, 5).Single()),
            Convert.ToHexString(Fields(message, 1).Single()),
            Convert.ToHexString(Fields(message, 2).Single()),
            Fields(message, 4).Select(Convert.ToHexString).SingleOrDefault(),
            Fields(message, 9)
                .ToDictionary(
                    field => Encoding.UTF8.GetString(Fields(field, 1).Single()),
                    field => ReadValue(Fields(field, 2).Single())
                )
        );

    private static string ReadValue(byte[] message)
    {
        using var input = new CodedInputStream(message);
        return WireFormat.GetTagFieldNumber(input.ReadTag()) switch
        {
            1 => input.ReadString(),
            2 => input.ReadBool().ToString(),
            3 => input.ReadInt64().ToString(),
            _ => "",
        };
    }

    private sealed record Span(
        string Name,
        string Trace,
        string Id,
        string? Parent,
        Dictionary<string, string> Attributes
    );
}
