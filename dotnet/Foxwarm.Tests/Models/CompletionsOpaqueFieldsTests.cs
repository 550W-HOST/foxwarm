using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CompletionsOpaqueFieldsTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static JsonObject Event(JsonObject delta) =>
        new() { ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["delta"] = delta }) };

    [Theory]
    [InlineData("provider_specific_fields", "providerSpecificFields")]
    [InlineData("extra_fields", "extraFields")]
    public void Stream_opaque_objects_merge_without_becoming_visible_progress(
        string wire,
        string stored
    )
    {
        var progress = 0;
        var meaningful = 0;
        var accumulator = new CompletionsEventAccumulator(
            new ResponsesStreamCallbacks
            {
                OnProgress = _ => progress++,
                OnMeaningfulProgress = () => meaningful++,
            }
        );
        foreach (
            var value in new[]
            {
                "null",
                "[]",
                "{\"nested\":{\"signature\":\"first\",\"retainedNull\":null},\"skip\":null,\"list\":[1],\"scalar\":\"first\"}",
                "null",
                "{\"nested\":{\"toolSignature\":\"second\",\"signature\":null,\"skip\":null},\"list\":[null,2],\"scalar\":\"last\"}",
                "{\"newObject\":{\"retainedNull\":null}}",
            }
        )
            accumulator.Consume(Event(new JsonObject { [wire] = JsonNode.Parse(value) }));
        var response = accumulator.CompleteAtEof();
        var expected = Obj(
            """{"nested":{"signature":"first","retainedNull":null,"toolSignature":"second"},"list":[null,2],"scalar":"last","newObject":{"retainedNull":null}}"""
        );
        Assert.True(JsonNode.DeepEquals(expected, response["choices"]![0]!["message"]![wire]));
        var canonical = CompletionsCanonicalConverter.ConvertAssistant(response, "a/wire", 1000, 1);
        Assert.True(JsonNode.DeepEquals(expected, canonical["providerMeta"]![stored]));
        Assert.Equal(0, progress);
        Assert.Equal(0, meaningful);
    }

    [Fact]
    public void Json_conversion_persistence_and_replay_preserve_independent_objects_and_nulls()
    {
        using var temp = new TempDirectory();
        var database = Path.Combine(temp.Path, "archive.sqlite");
        var store = new SqliteArchiveMessageStore(database, "opaque");
        var seq = 0;
        foreach (
            var fields in new[]
            {
                "{\"extra_fields\":{\"signature\":\"extra\",\"nullValue\":null}}",
                "{\"provider_specific_fields\":{\"signature\":\"provider\"}}",
                "{\"extra_fields\":{},\"provider_specific_fields\":{\"nested\":[null,1]}}",
                "{\"extra_fields\":[],\"provider_specific_fields\":null}",
                "{\"extra_fields\":\"invalid\",\"provider_specific_fields\":1}",
            }
        )
        {
            var message = Obj(fields);
            message["tool_calls"] = JsonNode.Parse(
                """[{"id":"fixture-call","type":"function","function":{"name":"task","arguments":"{\"action\":\"list\"}"}}]"""
            );
            var canonical = CompletionsCanonicalConverter.ConvertAssistant(
                new JsonObject
                {
                    ["choices"] = new JsonArray(new JsonObject { ["message"] = message }),
                },
                "a/wire",
                1000,
                1
            );
            Assert.Single(canonical["parts"]!.AsArray()); // Tool-call-only output retains opaque metadata.
            canonical["__meta"]!["seq"] = ++seq;
            canonical["__meta"]!["timestamp"] = 1000;
            store.WriteMessages([
                ArchiveMessageRecord.Create("opaque", "main", seq, 1000, canonical),
            ]);
            var persisted = new SqliteArchiveMessageStore(database, "opaque")
                .ReadMessageBySeq(seq)!
                .Message;
            Assert.True(JsonNode.DeepEquals(canonical, persisted));
            canonical = persisted;
            var before = canonical.ToJsonString();
            var same = CompletionsRequestSerializer.ConvertHistory(
                [canonical],
                "a/wire",
                "reasoning"
            )[0]!;
            var other = CompletionsRequestSerializer.ConvertHistory(
                [canonical],
                "b/wire",
                "reasoning"
            )[0]!;
            foreach (
                var (wire, stored) in new[]
                {
                    ("extra_fields", "extraFields"),
                    ("provider_specific_fields", "providerSpecificFields"),
                }
            )
            {
                Assert.Equal(message[wire] is JsonObject, same.AsObject().ContainsKey(wire));
                if (message[wire] is JsonObject)
                {
                    Assert.True(
                        JsonNode.DeepEquals(message[wire], canonical["providerMeta"]![stored])
                    );
                    Assert.True(JsonNode.DeepEquals(message[wire], same[wire]));
                    same[wire]!["mutated"] = true;
                }
                Assert.False(other.AsObject().ContainsKey(wire));
            }
            Assert.Equal(before, canonical.ToJsonString());
            if (canonical["providerMeta"] is JsonObject meta)
            {
                Assert.Equal("a/wire", meta["sourceModelId"]!.GetValue<string>());
                meta.Remove("sourceModelId");
                var unknown = CompletionsRequestSerializer.ConvertHistory(
                    [canonical],
                    "a/wire",
                    "reasoning"
                )[0]!.AsObject();
                Assert.False(unknown.ContainsKey("extra_fields"));
                Assert.False(unknown.ContainsKey("provider_specific_fields"));
            }
            else
                Assert.False(canonical.ContainsKey("providerMeta"));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Declared_compatible_history_replays_both_objects_without_changing_attribution(
        bool providerMapping
    )
    {
        var configuration = Obj(
            """{"default":"b/alias","providers":{"a":{"providerType":"openai-completions","models":["wire"]},"b":{"providerType":"openai-completions","models":[{"id":"alias","sameModelAs":"a/wire"}]}}}"""
        );
        if (providerMapping)
        {
            configuration["providers"]!["b"]!["sameProviderAs"] = "a";
            configuration["providers"]!["b"]!["models"] = new JsonArray("wire");
            configuration["default"] = "b/wire";
        }
        var model = HostModels.Parse(configuration, new JsonObject()).Resolve(null);
        var canonical = CompletionsCanonicalConverter.ConvertAssistant(
            Obj(
                """{"choices":[{"message":{"role":"assistant","content":"Synthetic answer","extra_fields":{"signature":"extra"},"provider_specific_fields":{"signature":"provider"}}}]}"""
            ),
            "a/wire",
            1000,
            1
        );
        var before = canonical.ToJsonString();
        var prepared = ConcreteRequestHistory.Prepare(
            [canonical],
            model.Key,
            model.HistoryCompatibility
        );
        var replay = CompletionsRequestSerializer.ConvertHistory(
            prepared,
            model.Key,
            "reasoning",
            model.HistoryCompatibility
        )[0]!;
        Assert.Equal("extra", SessionWait.Text(replay["extra_fields"]?["signature"]));
        Assert.Equal(
            "provider",
            SessionWait.Text(replay["provider_specific_fields"]?["signature"])
        );
        Assert.Equal("a/wire", SessionWait.Text(prepared[0]["providerMeta"]?["sourceModelId"]));
        Assert.Equal(before, canonical.ToJsonString());
    }

    [Fact]
    public async Task Normal_sse_turn_persists_tool_metadata_then_reopens_and_replays_only_to_same_concrete_model()
    {
        var extra = Obj("""{"detail":{"signature":"one","toolSignature":"two"},"list":[null,2]}""");
        var provider = Obj("""{"first":true,"second":true}""");
        await using var peer = new ScriptedResponsesSequenceServer(
            4,
            async (index, stream, request) =>
            {
                Assert.StartsWith("POST /v1/chat/completions ", request.RequestLine);
                var body = Obj(request.Body);
                Assert.True(body["stream"]!.GetValue<bool>());
                Assert.Equal("top-level", body["fixtureOption"]!.GetValue<string>());
                var message =
                    index == 0
                        ? Obj(
                            """{"role":"assistant","tool_calls":[{"id":"opaque-call","type":"function","function":{"name":"task","arguments":"{\"action\":\"list\"}"}}]}"""
                        )
                        : Obj("""{"role":"assistant","content":"Synthetic answer"}""");
                if (index == 0)
                    message["tool_calls"]![0]!["index"] = 0;
                message["extra_fields"] = Obj("""{"detail":{"signature":"one"},"list":[1]}""");
                if (index == 1)
                    message["provider_specific_fields"] = Obj("""{"first":true}""");
                var next = Obj(
                    """{"extra_fields":{"detail":{"toolSignature":"two"},"list":[null,2]}}"""
                );
                if (index == 1)
                    next["provider_specific_fields"] = Obj("""{"second":true}""");
                var payload =
                    "data: "
                    + Event(message).ToJsonString()
                    + "\n\n"
                    + "data: "
                    + Event(Obj("""{"extra_fields":null,"provider_specific_fields":null}"""))
                        .ToJsonString()
                    + "\n\n"
                    + "data: "
                    + Event(next).ToJsonString()
                    + "\n\ndata: [DONE]\n\n";
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(payload)
                );
            }
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        JsonObject Provider() =>
            new()
            {
                ["providerType"] = "openai-completions",
                ["baseUrl"] = peer.BaseUri.ToString(),
                ["models"] = new JsonArray("wire"),
                ["extraFields"] = new JsonObject
                {
                    ["stream"] = true,
                    ["fixtureOption"] = "top-level",
                },
            };
        var models = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a/wire",
                ["providers"] = new JsonObject { ["a"] = Provider(), ["b"] = Provider() },
            },
            new JsonObject()
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 1024);
        async Task Run(SessionOwner owner)
        {
            await owner.Registry.Ingress.EnqueueAsync(
                owner.Id,
                QueueItem.UserText("Synthetic input")
            );
            await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            Assert.False(owner.Metadata().LlmFailed);
        }
        void AssertStored(IReadOnlyList<JsonObject> history)
        {
            var assistants = history
                .Where(row => SessionWait.Text(row["role"]) == "model")
                .ToArray();
            Assert.True(JsonNode.DeepEquals(extra, assistants[0]["providerMeta"]?["extraFields"]));
            Assert.False(
                assistants[0]["providerMeta"]!.AsObject().ContainsKey("providerSpecificFields")
            );
            Assert.True(
                JsonNode.DeepEquals(
                    provider,
                    assistants[1]["providerMeta"]?["providerSpecificFields"]
                )
            );
            Assert.True(JsonNode.DeepEquals(extra, assistants[1]["providerMeta"]?["extraFields"]));
            Assert.All(
                assistants.Take(2),
                row =>
                    Assert.Equal("a/wire", SessionWait.Text(row["providerMeta"]?["sourceModelId"]))
            );
        }
        string id;
        await using (var first = new SessionManager(data, work, options, models))
        {
            await first.LoadMainHostAsync();
            var owner = await first.CreateNamedAsync("main", "opaque", null, null);
            id = owner.Id;
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await Run(owner);
            Assert.Equal(2, peer.RequestCount);
            AssertStored(owner.History());
            AssertStored(owner.Archive.ReadMessages().Select(row => row.Message).ToArray());
            var tool = owner.History().Single(row => SessionWait.Text(row["role"]) == "tool");
            Assert.Null(tool["parts"]![0]!["functionResponse"]!["response"]?["error"]);
            var saved = (await new PersistentSessionAuthorityStore(data, id).LoadAsync(id))!;
            AssertStored(saved.History.Materialize());
            await first.ShutdownAsync();
        }
        await using (var reopened = new SessionManager(data, work, options, models))
        {
            await reopened.LoadMainHostAsync();
            var owner = await reopened.RequiredAsync(id);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            AssertStored(owner.History());
            AssertStored(owner.Archive.ReadMessages().Select(row => row.Message).ToArray());
            await Run(owner);
            await owner.UpdateModelAsync(new JsonObject { ["model"] = "b/wire" });
            await Run(owner);
            AssertStored(owner.History()); // Cross-model request preparation did not erase stored evidence.
            await reopened.ShutdownAsync();
        }
        var continuation = Obj((await peer.RequestAt(1)).Body)["messages"]!.AsArray();
        Assert.True(
            JsonNode.DeepEquals(
                extra,
                continuation.Single(row => SessionWait.Text(row?["role"]) == "assistant")![
                    "extra_fields"
                ]
            )
        );
        var replay = Obj((await peer.RequestAt(2)).Body)["messages"]!
            .AsArray()
            .Where(row => SessionWait.Text(row?["role"]) == "assistant")
            .ToArray();
        Assert.Equal(2, replay.Length);
        Assert.True(JsonNode.DeepEquals(extra, replay[0]!["extra_fields"]));
        Assert.True(JsonNode.DeepEquals(provider, replay[1]!["provider_specific_fields"]));
        var other = Obj((await peer.RequestAt(3)).Body)["messages"]!.AsArray();
        Assert.All(
            other.OfType<JsonObject>(),
            row =>
            {
                Assert.False(row.ContainsKey("extra_fields"));
                Assert.False(row.ContainsKey("provider_specific_fields"));
            }
        );
        Assert.Equal(4, peer.RequestCount);
    }
}
