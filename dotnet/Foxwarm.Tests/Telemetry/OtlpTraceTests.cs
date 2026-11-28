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
    [InlineData("default")]
    [InlineData("all")]
    [InlineData("systemPrompt")]
    [InlineData("inputMessages")]
    [InlineData("outputMessages")]
    [InlineData("toolDefinitions")]
    [InlineData("toolArguments")]
    [InlineData("toolResults")]
    [InlineData("reasoning")]
    [InlineData("outputMessages+reasoning")]
    [InlineData("redacted")]
    [InlineData("tools")]
    public async Task Main_exports_a_turn_with_retries_and_tools_to_its_configured_OTLP_receiver(
        string mode
    )
    {
        bool Enabled(string field) =>
            mode is "all" or "redacted" or "tools" || mode.Split('+').Contains(field);
        const string original = "Private Example Person";
        await using var detector = await TextDetectionPeer.StartAsync(original);
        string? wirePerson = null;
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
            {
                if (mode == "redacted" && attempt == 1)
                    wirePerson = System
                        .Text.RegularExpressions.Regex.Match(
                            context.Request.ToJsonString(),
                            @"\[\[PRIVATE_[0-9a-f]{16}\]\]"
                        )
                        .Value;
                var frame = JsonNode
                    .Parse(
                        (
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
                                    """{"type":"response.completed","response":{"usage":{"input_tokens":17,"output_tokens":6,"input_tokens_details":{"cached_tokens":3}},"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"synthetic reasoning"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"synthetic answer PERSON"}]}]}}""",
                            }
                        )
                            .Replace("PERSON", wirePerson ?? "fixture")
                            .Replace("example.txt", wirePerson ?? "example.txt")
                    )!
                    .AsObject();
                if (mode == "tools" && attempt == 2)
                {
                    var output = frame["response"]!["output"]!.AsArray();
                    void Call(string id, string name, JsonObject args) =>
                        output.Add(
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["id"] = "fc_" + id,
                                ["call_id"] = id,
                                ["name"] = name,
                                ["arguments"] = args.ToJsonString(),
                            }
                        );
                    Call(
                        "direct",
                        "add_secret",
                        new() { ["name"] = "first", ["value"] = "never-export-direct" }
                    );
                    Call(
                        "wrapped",
                        "ctl",
                        new()
                        {
                            ["command"] = "tool call builtin:add_secret --args @fields",
                            ["values"] = new JsonObject
                            {
                                ["fields"] = new JsonObject
                                {
                                    ["name"] = "second",
                                    ["value"] = "never-export-wrapped",
                                },
                            },
                        }
                    );
                    Call(
                        "denied",
                        "write",
                        new() { ["filePath"] = "denied.txt", ["content"] = "never-export-denied" }
                    );
                    Call(
                        "known",
                        "read",
                        new() { ["filePath"] = "file-test-collector-key-000001" }
                    );
                }
                return context.Send(frame);
            }
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var state = Path.Combine(data, "state");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(state);
        if (mode == "tools")
            await File.WriteAllTextAsync(
                Path.Combine(state, "tool-authorization.yaml"),
                "version: 1\ndefaultAction: allow\nrules:\n- action: deny\n  tool: {source: node, name: write}\n"
            );
        var otlp = new JsonObject
        {
            ["endpoint"] = collector.Urls.Single() + "/v1/traces",
            ["headers"] = new JsonObject { ["Authorization"] = "Bearer ${secret:fixture-key}" },
        };
        if (mode != "default")
        {
            var fields = new JsonObject();
            foreach (
                var field in new[]
                {
                    "systemPrompt",
                    "inputMessages",
                    "outputMessages",
                    "toolDefinitions",
                    "toolArguments",
                    "toolResults",
                    "reasoning",
                }
            )
                if (Enabled(field))
                    fields[field] = true;
            otlp["captureContent"] = fields;
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
                        ["textRedaction"] =
                            mode == "redacted"
                                ? TextRedactionTests.Settings(detector.Endpoint)
                                : JsonValue.Create(false),
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
                Path.Combine(
                    host.Sessions.AgentDirectory(owner.Agent),
                    mode == "redacted" ? original : "example.txt"
                ),
                "synthetic tool output"
            );
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await new SessionRuntime(host.Sessions).SubmitAndRunAsync(
                owner.Id,
                QueueItem.UserText("synthetic input " + original + " " + new string('♥', 9000))
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
        Assert.Equal(mode == "tools" ? 3 : 2, tools.Length);
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
        var toolRequest = Assert.Single(
            models,
            span => span.Attributes["foxwarm.model.attempt"] == "2"
        );
        Assert.Equal(
            Enabled("systemPrompt"),
            final.Attributes.ContainsKey("gen_ai.system_instructions")
        );
        Assert.Equal(
            Enabled("inputMessages"),
            failed.Attributes.ContainsKey("gen_ai.input.messages")
        );
        Assert.Equal(
            Enabled("outputMessages"),
            final.Attributes.ContainsKey("gen_ai.output.messages")
        );
        Assert.Equal(
            Enabled("toolDefinitions"),
            final.Attributes.ContainsKey("gen_ai.tool.definitions")
        );
        Assert.Equal(
            Enabled("toolArguments"),
            read.Attributes.ContainsKey("gen_ai.tool.call.arguments")
        );
        Assert.Equal(
            Enabled("toolResults") && mode != "redacted",
            read.Attributes.ContainsKey("gen_ai.tool.call.result")
        );
        Assert.DoesNotContain("gen_ai.tool.call.arguments", skipped.Attributes);
        Assert.Equal("stop", final.Attributes["gen_ai.response.finish_reasons"]);
        Assert.Equal("tool_call", toolRequest.Attributes["gen_ai.response.finish_reasons"]);
        Assert.Equal("1", final.Attributes["foxwarm.journal.attempt"]);
        Assert.Equal(
            failed.Attributes["foxwarm.journal.request.id"],
            toolRequest.Attributes["foxwarm.journal.request.id"]
        );
        Assert.Equal("2", toolRequest.Attributes["foxwarm.journal.attempt"]);
        Assert.Equal(
            toolRequest.Attributes["foxwarm.journal.request.id"],
            read.Attributes["foxwarm.journal.request.id"]
        );
        Assert.Equal("2", read.Attributes["foxwarm.journal.attempt"]);
        if (Enabled("outputMessages"))
        {
            var output = final.Attributes["gen_ai.output.messages"];
            Assert.Contains("synthetic answer", output);
            Assert.Equal(Enabled("reasoning"), output.Contains("synthetic reasoning"));
            Assert.Equal("stop", JsonNode.Parse(output)![0]!["finish_reason"]!.GetValue<string>());
            Assert.DoesNotContain("example.txt", toolRequest.Attributes["gen_ai.output.messages"]);
        }
        if (Enabled("inputMessages"))
            Assert.Contains("synthetic input", failed.Attributes["gen_ai.input.messages"]);
        if (mode == "tools")
        {
            var attrs = spans.SelectMany(span => span.Attributes.Values).ToArray();
            Assert.DoesNotContain(attrs, value => value.Contains("never-export-"));
            Assert.DoesNotContain(attrs, value => value.Contains("test-collector-key-000001"));
            foreach (var id in new[] { "direct", "wrapped" })
            {
                var saved = spans.Single(tool =>
                    tool.Attributes.GetValueOrDefault("gen_ai.tool.call.id") == id
                );
                Assert.Equal("add_secret", saved.Attributes["foxwarm.tool.resolved_name"]);
                var args = JsonNode
                    .Parse(saved.Attributes["gen_ai.tool.call.arguments"])!
                    .AsObject();
                Assert.True(args.ContainsKey("name"));
                Assert.False(args.ContainsKey("value"));
            }
            Assert.DoesNotContain(
                "gen_ai.tool.call.arguments",
                spans
                    .Single(tool =>
                        tool.Attributes.GetValueOrDefault("gen_ai.tool.call.id") == "denied"
                    )
                    .Attributes
            );
            Assert.Contains(
                "file-",
                tools.Single(tool => tool.Attributes["gen_ai.tool.call.id"] == "known").Attributes[
                    "gen_ai.tool.call.arguments"
                ]
            );
        }
        if (mode == "redacted")
        {
            Assert.False(string.IsNullOrEmpty(wirePerson));
            Assert.Contains(wirePerson, failed.Attributes["gen_ai.input.messages"]);
            Assert.Contains(wirePerson, final.Attributes["gen_ai.output.messages"]);
            Assert.Contains(wirePerson, read.Attributes["gen_ai.tool.call.arguments"]);
            Assert.DoesNotContain(
                spans.SelectMany(span => span.Attributes.Values),
                value => value.Contains(original)
            );
        }
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

    [Fact]
    public void Bad_content_keeps_model_and_tool_metadata_and_outcomes()
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        File.WriteAllText(
            Path.Combine(state, "config.yaml"),
            "otlp: {endpoint: 'http://127.0.0.1:1/v1/traces', captureContent: {toolDefinitions: true, toolResults: true, outputMessages: true}}"
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
        traces.CompleteModel(attempt, new ChatResult(null));
        Assert.Null(attempt.GetTagItem("gen_ai.response.finish_reasons"));
        Assert.Equal(true, attempt.GetTagItem("foxwarm.content.capture_failed"));
        Assert.Null(attempt.GetTagItem("gen_ai.tool.definitions"));
        Assert.Equal("wire", attempt.GetTagItem("gen_ai.request.model"));
        attempt.SetTag("foxwarm.content.capture_failed", null);
        using var tool = traces.StartTool(
            "s",
            new JsonObject { ["name"] = "fixture", ["args"] = invalid.DeepClone() }
        );
        Assert.NotNull(tool);
        Assert.Null(tool.GetTagItem("gen_ai.tool.call.arguments"));
        traces.CompleteTool(tool, new Foxwarm.Tools.TurnToolExecution(invalid), started: true);
        Assert.Equal(true, tool.GetTagItem("foxwarm.content.capture_failed"));
        Assert.Equal("completed", tool.GetTagItem("foxwarm.outcome"));
        Assert.Null(tool.GetTagItem("gen_ai.tool.call.result"));
    }

    [Fact]
    public async Task Sharing_model_configuration_does_not_attach_another_runtime_to_the_host_exporter()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "host");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        File.WriteAllText(
            Path.Combine(data, "state", "config.yaml"),
            "otlp: {endpoint: 'http://127.0.0.1:1/v1/traces'}"
        );
        var config = new ModelConfiguration(data);
        var http = new HttpServerSettings(
            0,
            "",
            "127.0.0.1",
            new("http://127.0.0.1", "", "/", false),
            false,
            HttpEnabled: false
        );
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            Path.Combine(temp.Path, "agents"),
            config,
            http,
            null
        );
        Assert.NotNull(
            (await host.Sessions.CreateNamedAsync("main", "trace", null, null)).Registry.Traces
        );
        await using var other = new SessionManager(
            Path.Combine(temp.Path, "other"),
            Path.Combine(temp.Path, "other-agents"),
            new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "offline",
                "fixture/offline",
                "",
                "",
                713
            ),
            config.Models
        );
        await other.LoadMainHostAsync();
        Assert.Null((await other.CreateNamedAsync("main", "isolated", null, null)).Registry.Traces);
    }

    [Fact]
    public void Large_result_projection_does_not_allocate_in_proportion_to_result_size()
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        File.WriteAllText(
            Path.Combine(temp.Path, "state", "config.yaml"),
            "otlp: {endpoint: 'http://127.0.0.1:1/v1/traces', captureContent: {toolResults: true}} "
        );
        var config = new ModelConfiguration(temp.Path);
        using var secrets = config.Secrets;
        using var traces = Foxwarm.Telemetry.FoxwarmTraces.Open(config)!;
        using var tool = traces.StartTool("s", new JsonObject { ["name"] = "read" });
        var result = new Foxwarm.Tools.TurnToolExecution(
            new JsonObject { ["output"] = new string('a', 4 * 1024 * 1024) }
        );
        var before = GC.GetAllocatedBytesForCurrentThread();
        traces.CompleteTool(tool, result, started: true);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        Assert.InRange(allocated, 0, 1024 * 1024);
        Assert.Contains("output", tool!.GetTagItem("gen_ai.tool.call.result")!.ToString());
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
            5 => ReadValue(Fields(input.ReadBytes().ToByteArray(), 1).Single()),
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
