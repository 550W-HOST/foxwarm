using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class AnthropicMessageEffortTests
{
    private const string Leaf = "a/wire";
    private const string DefaultBetas = "interleaved-thinking-2025-05-14";
    private const string Beta = "mid-conversation-output-config-2026-07-01";

    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static JsonObject User(string text) =>
        new()
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
        };

    private static JsonObject Model(string text) =>
        new()
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
        };

    private static JsonObject Call(string id) =>
        Obj(
            """{"role":"model","parts":[{"functionCall":{"id":"""
                + "\"" + id + "\""
                + ""","name":"exec","args":{"command":"true"}}}]}"""
        );

    private static JsonObject Result(string id) =>
        Obj(
            """{"role":"tool","parts":[{"functionResponse":{"tool_use_id":"""
                + "\"" + id + "\""
                + ""","name":"exec","response":{"output":"ok"}}}]}"""
        );

    private static JsonObject Change(string previous, string effort, string model = Leaf) =>
        new EffortChangeRecord(model, previous, effort).ToRow();

    private static ResponsesClientOptions Options(
        string effort = "low",
        bool enabled = true,
        JsonObject? extraFields = null,
        JsonObject? headers = null,
        Uri? baseUri = null
    ) =>
        new ResponsesClientOptions(
            baseUri ?? new Uri("http://localhost"),
            "wire",
            Leaf,
            "",
            "system",
            1000
        )
        {
            ConcreteModelId = Leaf,
            Effort = effort,
            PerMessageEffort = enabled,
            ExtraFields = extraFields,
            ExtraHeaders = headers,
        };

    private static JsonObject[] Wire(JsonObject body) =>
        body["messages"]!.AsArray().Select(message => message!.AsObject()).ToArray();

    private static bool IsEffortMessage(JsonObject message, string effort) =>
        SessionWait.Text(message["role"]) == "system"
        && message["content"] is JsonArray { Count: 0 }
        && SessionWait.Text(message["output_config"]?["effort"]) == effort
        && message.Count == 3;

    [Fact]
    public void Recorded_change_is_an_effort_only_system_message_and_top_level_stays_at_the_prior_effort()
    {
        var before = new[] { User("plan"), Model("steps") };
        var history = before.Append(Change("high", "low")).Append(User("summarize")).ToArray();
        var body = AnthropicRequestSerializer.BuildRequest(history, Options("low"));
        var messages = Wire(body);
        Assert.Equal(["user", "assistant", "system", "user"], messages.Select(m => m["role"]!.ToString()));
        Assert.True(IsEffortMessage(messages[2], "low"), messages[2].ToJsonString());
        Assert.Equal("high", body["output_config"]!["effort"]!.ToString());
        // The request before the change had the same top level and message bytes.
        var earlier = AnthropicRequestSerializer.BuildRequest(before, Options("high"));
        Assert.Equal(earlier["output_config"]!.ToJsonString(), body["output_config"]!.ToJsonString());
        Assert.Equal(
            Wire(earlier).Select(message => message.ToJsonString()),
            messages.Take(2).Select(message => message.ToJsonString())
        );
        Assert.True(AnthropicMessageEffort.Uses(body));
        Assert.False(AnthropicMessageEffort.Uses(earlier));
    }

    [Fact]
    public void Change_inside_a_tool_loop_follows_the_tool_results_without_merging_neighbouring_turns()
    {
        var history = new[]
        {
            User("run"),
            Call("c1"),
            Result("c1"),
            Change("high", "medium"),
            Call("c2"),
            Result("c2"),
            Change("medium", "low"),
            User("queued follow-up"),
        };
        var body = AnthropicRequestSerializer.BuildRequest(history, Options("low"));
        var messages = Wire(body);
        Assert.Equal(
            ["user", "assistant", "user", "system", "assistant", "user", "system", "user"],
            messages.Select(m => m["role"]!.ToString())
        );
        Assert.Equal("tool_result", messages[2]["content"]![0]!["type"]!.ToString());
        Assert.Single(messages[5]["content"]!.AsArray());
        Assert.True(IsEffortMessage(messages[3], "medium"));
        Assert.True(IsEffortMessage(messages[6], "low"));
        Assert.Equal("queued follow-up", messages[7]["content"]!.ToString());
        Assert.Equal("high", body["output_config"]!["effort"]!.ToString());
    }

    [Fact]
    public void Option_off_other_models_none_and_fixed_thinking_keep_the_top_level_behaviour()
    {
        var plain = new[] { User("plan"), Model("steps"), User("again") };
        var recorded = new[] { User("plan"), Model("steps"), Change("high", "low"), User("again") };
        string Today(string effort, JsonObject? extra = null) =>
            AnthropicRequestSerializer
                .BuildRequest(plain, Options(effort, enabled: false, extraFields: extra))
                .ToJsonString();
        Assert.Equal(
            Today("low"),
            AnthropicRequestSerializer.BuildRequest(recorded, Options("low", enabled: false)).ToJsonString()
        );
        var foreign = new[] { User("plan"), Model("steps"), Change("high", "low", "b/other"), User("again") };
        Assert.Equal(
            Today("low"),
            AnthropicRequestSerializer.BuildRequest(foreign, Options("low")).ToJsonString()
        );
        var disabled = AnthropicRequestSerializer.BuildRequest(recorded, Options("none"));
        Assert.Equal(Today("none"), disabled.ToJsonString());
        Assert.Equal("disabled", disabled["thinking"]!["type"]!.ToString());
        Assert.Null(disabled["output_config"]);
        foreach (var type in new[] { "between_tools", "disabled" })
        {
            var extra = new JsonObject { ["thinking"] = new JsonObject { ["type"] = type } };
            var fixedThinking = AnthropicRequestSerializer.BuildRequest(
                recorded,
                Options("low", extraFields: extra)
            );
            Assert.Equal(Today("low", extra), fixedThinking.ToJsonString());
            Assert.False(AnthropicMessageEffort.Uses(fixedThinking));
        }
    }

    [Fact]
    public void Beta_header_merges_with_the_default_or_a_configured_override_without_duplicates()
    {
        Dictionary<string, string> Defaults() => new() { ["anthropic-beta"] = DefaultBetas };
        var headers = Defaults();
        var unchanged = Options();
        Assert.Same(unchanged, AnthropicMessageEffort.MergeBetaHeader(headers, unchanged));
        Assert.Equal(DefaultBetas + "," + Beta, headers["anthropic-beta"]);

        headers = Defaults();
        var configured = Options(
            headers: new JsonObject
            {
                ["Anthropic-Beta"] =
                    "interleaved-thinking-2025-05-14, example-feature-2026-01-01",
                ["X-Other"] = "kept",
            }
        );
        var merged = AnthropicMessageEffort.MergeBetaHeader(headers, configured);
        Assert.Equal(
            "interleaved-thinking-2025-05-14,example-feature-2026-01-01," + Beta,
            headers["anthropic-beta"]
        );
        Assert.Equal("kept", merged.ExtraHeaders!["X-Other"]!.ToString());
        Assert.False(merged.ExtraHeaders.ContainsKey("Anthropic-Beta"));
        Assert.Equal(2, configured.ExtraHeaders!.Count);

        headers = Defaults();
        AnthropicMessageEffort.MergeBetaHeader(
            headers,
            Options(headers: new JsonObject { ["anthropic-beta"] = Beta + "," + Beta })
        );
        Assert.Equal(Beta, headers["anthropic-beta"]);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("interleaved-thinking-2025-05-14,example-feature-2026-01-01")]
    public async Task Wire_header_carries_the_beta_only_for_requests_with_a_recorded_change(
        string? configured
    )
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "application/json",
                    Encoding.UTF8.GetBytes(
                        """{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}"""
                    )
                )
        );
        using var http = ProviderHttpRequest.CreateClient();
        var options = Options(
            extraFields: new JsonObject { ["stream"] = false },
            headers: configured is null ? null : new JsonObject { ["anthropic-beta"] = configured },
            baseUri: new Uri(peer.BaseUri, "/")
        );
        var service = new AnthropicMessagesService(http, options);
        await service.ChatAsync("s", [User("plan"), Model("steps"), User("again")], default);
        await service.ChatAsync(
            "s",
            [User("plan"), Model("steps"), Change("high", "low"), User("again")],
            default
        );
        var expected = configured ?? DefaultBetas;
        Assert.Equal(expected, (await peer.RequestAt(0)).Headers["anthropic-beta"]);
        Assert.Equal(expected + "," + Beta, (await peer.RequestAt(1)).Headers["anthropic-beta"]);
    }

    [Fact]
    public void Option_is_an_Anthropic_model_override_of_the_provider_default()
    {
        HostModels Parse(JsonObject provider) =>
            HostModels.Parse(
                new JsonObject
                {
                    ["default"] = Leaf,
                    ["providers"] = new JsonObject
                    {
                        ["a"] = provider,
                        ["route"] = new JsonObject
                        {
                            ["providerType"] = "failover",
                            ["targets"] = new JsonArray("a/wire", "a/off"),
                        },
                    },
                },
                new JsonObject()
            );
        var catalog = Parse(
            Obj(
                """{"providerType":"anthropic","perMessageEffort":true,"models":["wire",{"id":"off","perMessageEffort":false},{"id":"tools","extraFields":{"thinking":{"type":"between_tools"}}}]}"""
            )
        );
        Assert.True(AnthropicMessageEffort.Records(catalog.Resolve("a/wire")));
        Assert.False(AnthropicMessageEffort.Configured(catalog.Resolve("a/off")));
        Assert.True(AnthropicMessageEffort.Configured(catalog.Resolve("a/tools")));
        Assert.False(AnthropicMessageEffort.Records(catalog.Resolve("a/tools")));
        // Compact planning keeps the normal prefix: the same records and top level.
        var history = new[] { User("plan"), Model("steps"), Change("high", "low"), User("again") };
        string Planned(string purpose) =>
            AnthropicRequestSerializer
                .BuildRequest(
                    history,
                    ConfiguredModelRequests.Plan(
                        catalog.Resolve(Leaf),
                        Options(enabled: false),
                        "low",
                        "system",
                        "cache",
                        "turn",
                        purpose
                    )
                )
                .ToJsonString();
        Assert.Equal(Planned("normal-turn"), Planned("compact-plan"));
        Assert.Contains("\"output_config\":{\"effort\":\"low\"}", Planned("compact-plan"));
        Assert.False(
            AnthropicMessageEffort.Configured(
                Parse(Obj("""{"providerType":"anthropic","models":["wire","off"]}""")).Resolve(Leaf)
            )
        );
        foreach (
            var invalid in new[]
            {
                """{"providerType":"anthropic","perMessageEffort":"yes","models":["wire","off"]}""",
                """{"providerType":"openai-responses","perMessageEffort":true,"models":["wire","off"]}""",
                """{"providerType":"anthropic","models":["wire",{"id":"off","perMessageEffort":1}]}""",
            }
        )
            Assert.Throws<InvalidDataException>(() => Parse(Obj(invalid)));
        Assert.Throws<InvalidDataException>(() =>
            HostModels.Parse(
                Obj(
                    """{"default":"a/wire","providers":{"a":{"providerType":"anthropic","models":["wire","off"]},"route":{"providerType":"failover","targets":["a/wire","a/off"],"perMessageEffort":true}}}"""
                ),
                new JsonObject()
            )
        );
    }

    [Fact]
    public void Request_preparation_keeps_only_the_destination_models_records()
    {
        var history = new[]
        {
            User("plan"),
            Change("high", "low"),
            Change("high", "max", "b/other"),
            User("again"),
        };
        var prepared = ConcreteRequestHistory.PrepareRequest(history, Leaf);
        var record = Assert.Single(prepared, EffortChangeRecord.Is);
        Assert.Equal(new EffortChangeRecord(Leaf, "high", "low"), EffortChangeRecord.Read(record));
        Assert.Null(record["__meta"]);
        Assert.Equal(3, prepared.Count);
        Assert.DoesNotContain(
            ConcreteRequestHistory.PrepareRequest(history, "b/third"),
            EffortChangeRecord.Is
        );
        // Every other adapter ignores the record as a non-context row.
        var completions = CompletionsRequestSerializer.ConvertHistory(prepared, Leaf, "reasoning_content");
        Assert.DoesNotContain("effort", completions.ToJsonString());
    }

    [Fact]
    public void Effort_in_force_comes_from_the_models_latest_record_then_its_previous_request()
    {
        var history = SessionHistory.FromJson([User("a"), Change("high", "low"), User("b")]);
        var low = new EffectiveRequestSelection(Leaf, "master", "low");
        Assert.Null(AnthropicMessageEffort.Change(history, low, null));
        Assert.Equal(
            new EffortChangeRecord(Leaf, "low", "max"),
            AnthropicMessageEffort.Change(history, low with { Effort = "max" }, null)
        );
        var plain = SessionHistory.FromJson([User("a")]);
        Assert.Equal(
            new EffortChangeRecord(Leaf, "high", "low"),
            AnthropicMessageEffort.Change(plain, low, low with { Effort = "high" })
        );
        // Unknown baselines and `none` on either side keep the top-level behaviour.
        Assert.Null(AnthropicMessageEffort.Change(plain, low, null));
        Assert.Null(
            AnthropicMessageEffort.Change(plain, low, low with { ModelId = "b/other", Effort = "high" })
        );
        Assert.Null(AnthropicMessageEffort.Change(plain, low, low with { Effort = "none" }));
        Assert.Null(
            AnthropicMessageEffort.Change(plain, low with { Effort = "none" }, low)
        );
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Session_effort_change_is_persisted_once_and_extends_the_previous_request_prefix(
        bool enabled
    )
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            5,
            (index, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "application/json",
                    Encoding.UTF8.GetBytes(
                        $$"""{"content":[{"type":"text","text":"reply {{index}}"}],"stop_reason":"end_turn"}"""
                    )
                )
        );
        using var temp = new TempDirectory();
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["default"] = Leaf,
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = new Uri(peer.BaseUri, "/").ToString(),
                        ["perMessageEffort"] = enabled,
                        ["models"] = new JsonArray("wire"),
                        ["extraFields"] = new JsonObject { ["stream"] = false },
                    },
                },
            },
            new JsonObject()
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.BaseUri, "wire", Leaf, "", "", 1000),
            catalog
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "effort", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        async Task<JsonObject> Turn(int index, string text, string? effort = null)
        {
            if (effort is not null)
                await owner.UpdateSettingsAsync(new JsonObject { ["effort"] = effort }, false);
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText(text));
            await owner.Registry.Runner.ProcessQueueAsync(owner.Id);
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            return Obj((await peer.RequestAt(index)).Body);
        }
        JsonObject[] Records() => owner.History().Where(EffortChangeRecord.Is).ToArray();
        static string Envelope(JsonObject body)
        {
            var copy = (JsonObject)body.DeepClone();
            copy.Remove("messages");
            return copy.ToJsonString();
        }
        static void ExtendsPrefix(JsonObject earlier, JsonObject later) =>
            Assert.Equal(
                Wire(earlier).Select(message => message.ToJsonString()),
                Wire(later).Take(Wire(earlier).Length).Select(message => message.ToJsonString())
            );

        var first = await Turn(0, "first", "high");
        var second = await Turn(1, "second", "low");
        var third = await Turn(2, "third");
        ExtendsPrefix(first, second);
        ExtendsPrefix(second, third);
        if (!enabled)
        {
            Assert.Empty(Records());
            Assert.Equal("low", second["output_config"]!["effort"]!.ToString());
            Assert.NotEqual(Envelope(first), Envelope(second));
            Assert.DoesNotContain(Wire(third), message => message["role"]!.ToString() == "system");
            Assert.Equal(DefaultBetas, (await peer.RequestAt(2)).Headers["anthropic-beta"]);
            await manager.ShutdownAsync();
            return;
        }
        // One record, at the position where the change took effect.
        var record = Assert.Single(Records());
        Assert.Equal(new EffortChangeRecord(Leaf, "high", "low"), EffortChangeRecord.Read(record));
        var rows = owner.History().ToArray();
        var at = Array.IndexOf(rows, rows.Single(EffortChangeRecord.Is));
        Assert.Contains("second", rows[at - 1].ToJsonString());
        Assert.Equal("model", rows[at + 1]["role"]!.ToString());
        Assert.Equal(Envelope(first), Envelope(second));
        Assert.Equal(Envelope(second), Envelope(third));
        Assert.Equal("high", third["output_config"]!["effort"]!.ToString());
        var marker = Wire(second).Single(message => message["role"]!.ToString() == "system");
        Assert.True(IsEffortMessage(marker, "low"));
        Assert.Same(marker, Wire(second)[^1]);
        Assert.Equal(DefaultBetas, (await peer.RequestAt(0)).Headers["anthropic-beta"]);
        Assert.Equal(DefaultBetas + "," + Beta, (await peer.RequestAt(1)).Headers["anthropic-beta"]);
        Assert.Equal(DefaultBetas + "," + Beta, (await peer.RequestAt(2)).Headers["anthropic-beta"]);

        // Thinking disabled is a top-level change: nothing is recorded and no record is sent.
        var disabled = await Turn(3, "fourth", "none");
        Assert.Single(Records());
        Assert.Equal("disabled", disabled["thinking"]!["type"]!.ToString());
        Assert.DoesNotContain(Wire(disabled), message => message["role"]!.ToString() == "system");
        // Leaving `none` records the change from the effort last in force for this model.
        var medium = await Turn(4, "fifth", "medium");
        Assert.Equal(
            [new EffortChangeRecord(Leaf, "high", "low"), new EffortChangeRecord(Leaf, "low", "medium")],
            Records().Select(row => EffortChangeRecord.Read(row)!)
        );
        Assert.Equal(Envelope(first), Envelope(medium));
        Assert.Equal(
            ["low", "medium"],
            Wire(medium)
                .Where(message => message["role"]!.ToString() == "system")
                .Select(message => message["output_config"]!["effort"]!.ToString())
        );
        var persisted = await File.ReadAllTextAsync(
            Path.Combine(temp.Path, "data/state/sessions/effort.json")
        );
        Assert.Equal(2, persisted.Split("\"effortChange\"").Length - 1);
        await manager.ShutdownAsync();
    }
}
