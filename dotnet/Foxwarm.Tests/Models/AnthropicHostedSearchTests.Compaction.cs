using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AnthropicHostedSearchTests
{
    [Fact]
    public async Task Deferred_search_is_an_atomic_tail_and_preserved_exchange_on_the_next_native_request()
    {
        long[] exchange = [];
        SessionOwner? activeOwner = null;
        var peerFailure = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        JsonObject Submit(JsonObject args, string id) =>
            Reply(
                "tool_use",
                new JsonObject
                {
                    ["type"] = "tool_use",
                    ["id"] = id,
                    ["name"] = "submit_compact_plan",
                    ["input"] = args,
                }
            );
        void Pair(JsonObject request, bool present)
        {
            var blocks = request["messages"]!
                .AsArray()
                .OfType<JsonObject>()
                .SelectMany(message => (message["content"] as JsonArray ?? []).OfType<JsonObject>())
                .ToArray();
            var calls = blocks
                .Where(block =>
                    SessionWait.Text(block["type"]) == "server_tool_use"
                    && SessionWait.Text(block["id"]) == "search"
                )
                .ToArray();
            var results = blocks
                .Where(block =>
                    SessionWait.Text(block["type"]) == "web_search_tool_result"
                    && SessionWait.Text(block["tool_use_id"]) == "search"
                )
                .ToArray();
            if (present)
            {
                Assert.True(JsonNode.DeepEquals(Search(), Assert.Single(calls)));
                Assert.True(JsonNode.DeepEquals(Sources(), Assert.Single(results)));
            }
            else
            {
                Assert.Empty(calls);
                Assert.Empty(results);
            }
        }
        await using var peer = new ScriptedResponsesSequenceServer(
            8,
            async (index, stream, request) =>
            {
                try
                {
                    var body = Obj(request.Body);
                    JsonObject reply;
                    switch (index)
                    {
                        case 0:
                            reply = Reply(
                                "tool_use",
                                Search(),
                                Obj(
                                    """{"type":"tool_use","id":"local","name":"task","input":{"action":"list"}}"""
                                )
                            );
                            break;
                        case 1:
                            var prior = activeOwner!
                                .History()
                                .Where(row => SessionWait.Text(row["role"]) is "model" or "tool")
                                .ToArray();
                            var attempt = Submit(
                                new JsonObject
                                {
                                    ["inContext"] = true,
                                    ["replaceAsBlocks"] = new JsonArray(
                                        new JsonObject
                                        {
                                            ["level"] = 1,
                                            ["sourceKind"] = "message",
                                            ["sourceStart"] = prior[0]["__meta"]![
                                                "seq"
                                            ]!.DeepClone(),
                                            ["sourceEnd"] = prior[^1]["__meta"]![
                                                "seq"
                                            ]!.DeepClone(),
                                            ["summary"] =
                                                "Premature removal of a pending native search.",
                                        }
                                    ),
                                },
                                "active-search-compact"
                            );
                            attempt["content"]!.AsArray().Insert(0, Sources());
                            reply = attempt;
                            break;
                        case 2:
                            Pair(body, true);
                            Assert.DoesNotContain(
                                activeOwner!.History(),
                                row => row["__meta"]?["contextBlock"] is not null
                            );
                            reply = Reply("end_turn", Cited());
                            break;
                        case 3:
                            Pair(body, true);
                            reply = Submit(
                                new JsonObject
                                {
                                    ["inContext"] = true,
                                    ["replaceAsBlocks"] = new JsonArray(
                                        new JsonObject
                                        {
                                            ["level"] = 1,
                                            ["sourceKind"] = "message",
                                            ["sourceStart"] = exchange[0],
                                            ["sourceEnd"] = exchange[^1],
                                            ["summary"] =
                                                "Completed native search and local task listing.",
                                        }
                                    ),
                                    ["preserveMessages"] = new JsonArray(
                                        JsonValue.Create(exchange[^1])
                                    ),
                                },
                                "preserve"
                            );
                            break;
                        case 4:
                            Pair(body, true);
                            reply = Reply(
                                "end_turn",
                                Text("Preserved the complete search exchange.")
                            );
                            break;
                        case 5:
                            reply = Submit(
                                new JsonObject
                                {
                                    ["inContext"] = true,
                                    ["replaceAsBlocks"] = new JsonArray(),
                                    ["removePreservedMessages"] = new JsonArray(
                                        JsonValue.Create(exchange[^1])
                                    ),
                                },
                                "partial-remove"
                            );
                            break;
                        case 6:
                            Pair(body, true);
                            Assert.Contains("list every member", body["messages"]!.ToJsonString());
                            reply = Submit(
                                new JsonObject
                                {
                                    ["inContext"] = true,
                                    ["replaceAsBlocks"] = new JsonArray(),
                                    ["removePreservedMessages"] = new JsonArray(
                                        exchange
                                            .Select(id => (JsonNode)JsonValue.Create(id)!)
                                            .ToArray()
                                    ),
                                },
                                "remove"
                            );
                            break;
                        default:
                            Pair(body, false);
                            reply = Reply(
                                "end_turn",
                                Text("Removed the complete preserved exchange.")
                            );
                            break;
                    }
                    await Respond(stream, reply, true);
                }
                catch (Exception error)
                {
                    Console.WriteLine(error);
                    peerFailure.TrySetException(error);
                    throw;
                }
            }
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), "vector: false\n");
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a/wire",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = new Uri(peer.BaseUri, "/").ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["webSearch"] = true,
                        ["asyncCompact"] = false,
                    },
                },
            },
            new JsonObject()
        );
        await using var manager = new SessionManager(
            data,
            Path.Combine(temp.Path, "work"),
            new(peer.BaseUri, "wire", "a/wire", "", "", 1000),
            catalog
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "search-compact", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        activeOwner = owner;
        async Task Turn(string prompt)
        {
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText(prompt));
            await await Task.WhenAny(owner.StartProcessing(), peerFailure.Task)
                .WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            Assert.False(owner.Metadata().LlmFailed);
        }
        await Turn("Search synthetic information.");
        var history = owner.History();
        var start = Array.FindIndex(
            history.ToArray(),
            row =>
                row["parts"]!
                    .AsArray()
                    .Any(part =>
                        SessionWait.Text(
                            part?["providerMeta"]?["anthropic"]?["contentBlocks"]?[0]?["type"]
                        ) == "server_tool_use"
                    )
        );
        var candidates = CompactCandidateBuilder.Build(history, inContext: true);
        var grouped = Assert.Single(candidates.Items, item => item.HistoryStart == start);
        exchange = history
            .Skip(start)
            .Take(grouped.HistoryEnd - start + 1)
            .Select(row => (long)CompactCandidateBuilder.Number(row["__meta"]?["seq"])!)
            .ToArray();
        Assert.Equal(4, exchange.Length);
        Assert.Equal(
            start,
            CompactCandidateBuilder.Split(
                history,
                history.Skip(grouped.HistoryEnd).Sum(CompactCandidateBuilder.RowTokens) + 1
            )
        );
        Assert.Equal(exchange[^1], grouped.End);
        await Turn("Preserve the search exchange while compacting it.");
        var preserved = CompactCandidateBuilder.Build(owner.History(), inContext: true).Preserved;
        Assert.Equal(exchange, preserved.Select(row => row.Seq));
        Assert.All(preserved, row => Assert.Equal(exchange, row.Exchange));
        await Turn("Remove the preserved search exchange.");
        Assert.Empty(CompactCandidateBuilder.Build(owner.History(), inContext: true).Preserved);
        Assert.Equal(8, peer.RequestCount);
        Assert.Contains(
            owner.Archive.ReadMessages(),
            row => row.Message.ToJsonString().Contains("opaque-result")
        );
        await manager.ShutdownAsync();
    }

    [Fact]
    public void Native_error_closes_its_call_but_unanswered_search_keeps_only_its_contiguous_continuation()
    {
        JsonObject Row(long seq, params JsonObject[] blocks)
        {
            var row = AnthropicCanonicalConverter.ConvertAssistant(
                Reply("end_turn", blocks),
                "a/wire",
                1000,
                1
            )!;
            row["__meta"]!["seq"] = seq;
            return row;
        }
        var call = Row(1, Search());
        var error = Row(
            2,
            Obj(
                """{"type":"web_search_tool_result","tool_use_id":"search","content":{"type":"web_search_tool_result_error","error_code":"unavailable"}}"""
            )
        );
        var tail = Row(3, Text("Later answer."));
        var closed = CompactCandidateBuilder.Build([call, error, tail], inContext: true);
        Assert.Equal(2, closed.Items.Count);
        Assert.Equal(2, closed.Items[0].End);
        Assert.Equal(2, CompactCandidateBuilder.Split([call, error, tail], 1));
        var user = Obj(
            """{"role":"user","parts":[{"text":"A different turn."}],"__meta":{"seq":4}}"""
        );
        var pending = CompactCandidateBuilder.Build(
            [call, Row(2, Text("Continuing search.")), user, Row(5, Text("New answer."))],
            inContext: true
        );
        Assert.Equal(2, pending.Items[0].End);
        Assert.Equal(4, pending.Items[1].Start);
    }
}
