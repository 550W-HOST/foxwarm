using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class RetryPreparationTests
{
    private static JsonObject User(string value) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = value }) };

    private static ResponsesClientOptions Defaults(Uri uri) =>
        new(uri, "wire", "a/wire", "", "", 713);

    private static HostModels Catalog(Uri uri, bool replaced = false) =>
        HostModels.Parse(
            new JsonObject
            {
                ["default"] = "route",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = uri + "/a",
                        ["models"] = new JsonArray("wire"),
                        ["effort"] = new JsonObject
                        {
                            ["allowed"] = new JsonArray("low"),
                            ["default"] = "low",
                        },
                        ["extraHeaders"] = new JsonObject
                        {
                            ["x-generation"] = replaced ? "new" : "old",
                        },
                        ["extraFields"] = new JsonObject
                        {
                            ["test_cache"] = "${SESSION_CACHE_KEY}",
                            ["test_turn"] = "${TURN_ID}",
                        },
                    },
                    ["b"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = uri + "/b",
                        ["models"] = new JsonArray("wire"),
                        ["effort"] = new JsonObject
                        {
                            ["allowed"] = new JsonArray("max"),
                            ["default"] = "max",
                        },
                        ["extraHeaders"] = new JsonObject
                        {
                            ["x-generation"] = replaced ? "new" : "old",
                        },
                        ["extraFields"] = new JsonObject
                        {
                            ["stream"] = false,
                            ["test_cache"] = "${SESSION_CACHE_KEY}",
                            ["test_turn"] = "${TURN_ID}",
                        },
                    },
                    ["route"] = new JsonObject
                    {
                        ["providerType"] = "failover",
                        ["targets"] = replaced ? new JsonArray("b", "a") : new JsonArray("a", "b"),
                        ["failureThreshold"] = 2,
                        ["cooldownMs"] = 600000,
                    },
                },
            },
            new JsonObject()
        );

    private static Task Reply(
        System.Net.Sockets.NetworkStream stream,
        int status,
        string body,
        bool events = false
    ) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            status,
            events ? "text/event-stream" : "application/json",
            Encoding.UTF8.GetBytes(body)
        );

    private const string Done =
        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n";

    [Fact]
    public async Task Awaited_preparation_rebuilds_context_but_keeps_real_backoff_captured_routing_effort_and_lineage()
    {
        var times = new List<long>();
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, _) =>
            {
                times.Add(Stopwatch.GetTimestamp());
                await Reply(
                    stream,
                    index < 2 ? 503 : 200,
                    index < 2
                        ? "unavailable"
                        : "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"
                );
            }
        );
        using var http = new HttpClient();
        var routing = new ModelRouting();
        var catalog = Catalog(peer.BaseUri);
        var requests = new ModelRequestOwner(http, Defaults(peer.BaseUri), routing);
        var preparation = 0;
        var prompts = new List<string>();
        var notices = new List<ModelRetryEvent>();
        var result = await requests.RequestAsync(
            "owner",
            catalog,
            "route",
            "max",
            "original-cache",
            "original-turn",
            [User("seed")],
            (leaf, _) =>
            {
                prompts.Add(leaf.Key);
                return Task.FromResult("current system " + leaf.Key);
            },
            value =>
            {
                notices.Add(value);
                return Task.FromResult(false);
            },
            null,
            null,
            null,
            default,
            ModelRequestScope.Canonical,
            prepareRetry: async token =>
            {
                token.ThrowIfCancellationRequested();
                preparation++;
                if (preparation == 1)
                    routing.Begin("route", Catalog(peer.BaseUri, true).Resolve("route"));
                await Task.Yield();
                return new[] { User("seed"), User("prepared-" + preparation) };
            }
        );
        Assert.Equal(2, preparation);
        Assert.Equal(new[] { "a/wire", "a/wire", "b/wire" }, prompts);
        Assert.Equal("b/wire", result.AssistantMessage!["__meta"]!["modelId"]!.GetValue<string>());
        Assert.True(Stopwatch.GetElapsedTime(times[0], times[1]).TotalMilliseconds >= 1900);
        Assert.True(Stopwatch.GetElapsedTime(times[1], times[2]).TotalMilliseconds >= 4900);
        for (var index = 0; index < 3; index++)
        {
            var wire = await peer.RequestAt(index);
            var body = JsonNode.Parse(wire.Body)!.AsObject();
            Assert.Equal("old", wire.Headers["x-generation"]);
            Assert.Equal("original-cache", body["test_cache"]!.GetValue<string>());
            Assert.Equal("original-turn", body["test_turn"]!.GetValue<string>());
            if (index > 0)
                Assert.Contains("prepared-" + index, wire.Body);
            Assert.Equal(
                index == 2 ? "max" : "low",
                index == 2
                    ? body["output_config"]!["effort"]!.GetValue<string>()
                    : body["reasoning"]!["effort"]!.GetValue<string>()
            );
        }
        Assert.Equal(new[] { 1, 2 }, notices.Select(row => row.Attempt));
        Assert.All(notices, row => Assert.Equal(6, row.MaxRetries));
    }

    [Theory]
    [InlineData("LowLevel")]
    [InlineData("CompactPlan")]
    [InlineData("BackgroundCompactPlan")]
    public async Task Nonordinary_scope_retries_never_call_owner_preparation(string rawScope)
    {
        var scope = Enum.Parse<ModelRequestScope>(rawScope);
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
                await Reply(
                    stream,
                    index == 0 ? 503 : 200,
                    index == 0 ? "unavailable" : Done,
                    index == 1
                )
        );
        var options = Defaults(peer.BaseUri);
        using var http = new HttpClient();
        var requests = new ModelRequestOwner(http, options, new ModelRouting());
        var preparations = 0;
        await requests.RequestAsync(
            "owner",
            requests.Capture(HostModels.ForTest(options), "a", null),
            "cache",
            "turn",
            RequestHistory.FromMutable([User("seed")]),
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            default,
            scope,
            prepareRetry: _ =>
            {
                preparations++;
                throw new InvalidOperationException("Nonordinary request cannot consume input.");
            },
            recaptureSelection: () =>
                throw new InvalidOperationException(
                    "Nonordinary request cannot recapture owner selection."
                ),
            adoptSelection: (_, _, _, _) =>
                throw new InvalidOperationException(
                    "Nonordinary request cannot adopt owner selection."
                )
        );
        Assert.Equal(0, preparations);
        Assert.Equal(2, peer.RequestCount);
    }

    [Fact]
    public async Task Normal_model_request_entry_repairs_unpaired_tool_batch_before_provider_projection()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, _) => await Reply(stream, 200, Done, events: true)
        );
        var call = new JsonObject
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "lost",
                        ["name"] = "read",
                        ["args"] = new JsonObject(),
                    },
                }
            ),
        };
        var interruption = User("<foxwarm-system kind=\"event\" />");
        using var http = new HttpClient();
        var requests = new ModelRequestOwner(http, Defaults(peer.BaseUri), new ModelRouting());
        await requests.RequestAsync(
            "owner",
            HostModels.ForTest(Defaults(peer.BaseUri)),
            "a",
            null,
            "cache",
            "turn",
            [call, interruption],
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            default,
            ModelRequestScope.Canonical
        );
        Assert.Contains(
            "Tool output is lost due to agent restart or error",
            (await peer.RequestAt(0)).Body
        );
    }

    [Fact]
    public async Task Nonretryable_failure_and_preparation_failure_never_start_another_provider_attempt()
    {
        foreach (var status in new[] { 400, 503 })
        {
            await using var peer = new ScriptedResponsesSequenceServer(
                1,
                async (_, stream, _) => await Reply(stream, status, "invalid")
            );
            var options = Defaults(peer.BaseUri);
            using var http = new HttpClient();
            var routing = new ModelRouting();
            var preparations = 0;
            var requests = new ModelRequestOwner(http, options, routing);
            var captured = requests.Capture(HostModels.ForTest(options), "a", null);
            var task = requests.RequestAsync(
                "owner",
                captured,
                "cache",
                "turn",
                [User("seed")],
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                default,
                ModelRequestScope.Canonical,
                prepareRetry: _ =>
                {
                    preparations++;
                    throw new IOException("Actual local preparation failed.");
                }
            );
            if (status == 400)
                Assert.IsType<ModelRequestException>(await Record.ExceptionAsync(() => task));
            else
                Assert.IsType<IOException>(await Record.ExceptionAsync(() => task));
            Assert.Equal(status == 400 ? 0 : 1, preparations);
            Assert.Equal(1, peer.RequestCount);
        }
    }
}
