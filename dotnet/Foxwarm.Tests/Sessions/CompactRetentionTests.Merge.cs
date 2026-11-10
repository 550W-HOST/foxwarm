using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactRetentionTests
{
    private sealed class RetentionFixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        private readonly List<JsonObject> plans = [];
        private ScriptedResponsesSequenceServer peer = null!;
        private SessionManager manager = null!;
        public SessionOwner Owner { get; private set; } = null!;
        public int Requests => peer.RequestCount;

        /// <summary>Planner responses are taken in order; the last one repeats.</summary>
        public static async Task<RetentionFixture> CreateAsync(int responses)
        {
            var f = new RetentionFixture();
            var data = Path.Combine(f.temp.Path, "data");
            var work = Path.Combine(f.temp.Path, "work");
            Directory.CreateDirectory(work);
            f.peer = new ScriptedResponsesSequenceServer(
                responses,
                async (index, stream, captured) =>
                {
                    var plan = f.plans[Math.Min(index, f.plans.Count - 1)];
                    var payload = new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["id"] = "retention-" + index,
                            ["output"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "function_call",
                                    ["call_id"] = "plan-" + index,
                                    ["name"] = "submit_compact_plan",
                                    ["arguments"] = plan.ToJsonString(),
                                }
                            ),
                        },
                    };
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
                    );
                }
            );
            var options = new ResponsesClientOptions(
                f.peer.BaseUri,
                "wire",
                "a/wire",
                "",
                "",
                20000
            );
            var models = HostModels.Parse(
                new JsonObject
                {
                    ["default"] = "a",
                    ["providers"] = new JsonObject
                    {
                        ["a"] = new JsonObject
                        {
                            ["providerType"] = "openai-responses",
                            ["baseUrl"] = f.peer.BaseUri.ToString(),
                            ["models"] = new JsonArray("wire"),
                            ["contextLimit"] = 200000,
                            ["asyncCompact"] = false,
                        },
                    },
                },
                new JsonObject()
            );
            f.manager = new SessionManager(
                data,
                work,
                options,
                models,
                Path.Combine(f.temp.Path, "skills")
            );
            await f.manager.LoadMainHostAsync();
            f.Owner = await f.manager.CreateNamedAsync("main", "retention", null, null);
            return f;
        }

        public async Task<long> Append(string role, JsonObject part)
        {
            Assert.True(
                await Owner.Entry.SaveLane.AdmitAsync(
                    QueueItem.Prebuilt(
                        new JsonObject { ["role"] = role, ["parts"] = new JsonArray(part) }
                    ) with
                    {
                        Trigger = false,
                    },
                    SaveKind.Strict
                )
            );
            await Owner
                .Registry.HostFor(Owner.Id)
                .AppendQueuedInputsAsync(Owner.Entry.State.Queue.ToArray());
            return Owner.Entry.Snapshot().History.Last().Sequence!.Value;
        }

        /// <summary>The exact operations the retention policy requires now.</summary>
        public JsonObject Required(int summaryChars = 40, params long[] preserve) =>
            new()
            {
                ["replaceAsBlocks"] = new JsonArray(
                    CompactCandidateBuilder
                        .Build(Owner.History(), keepTokens: 0)
                        .Retention.Select(op =>
                            (JsonNode?)
                                new JsonObject
                                {
                                    ["level"] = op.Level,
                                    ["sourceKind"] = op.Kind,
                                    ["sourceStart"] = op.SourceStart,
                                    ["sourceEnd"] = op.SourceEnd,
                                    ["summary"] = new string('s', summaryChars),
                                }
                        )
                        .ToArray()
                ),
                ["preserveMessages"] = new JsonArray(
                    preserve.Select(seq => (JsonNode?)JsonValue.Create(seq)).ToArray()
                ),
            };

        public async Task Compact(params long[] preserve)
        {
            plans.Clear();
            plans.Add(Required(40, preserve));
            await Run();
        }

        public async Task Run(params JsonObject[] responses)
        {
            if (responses.Length > 0)
            {
                plans.Clear();
                plans.AddRange(responses);
            }
            Assert.True((await Owner.Compactor.StartManualAsync(keepPercent: 0)).Started);
            await Owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, Owner.Entry.BestEffortFailureCount);
        }

        public string Layout() =>
            string.Join(
                " ",
                Owner
                    .History()
                    .Where(row => !CompactCandidateBuilder.Completion(row))
                    .Select(row =>
                        row["__meta"]?["contextBlock"] is JsonObject block ? $"L{block["level"]}"
                        : row["__meta"]?["preservedFromBlockId"] is not null ? "P"
                        : CompactCandidateBuilder.Ignored(row) ? "N"
                        : "R"
                    )
            );

        public async ValueTask DisposeAsync()
        {
            await manager.DisposeAsync();
            await peer.DisposeAsync();
            temp.Dispose();
        }
    }

    [Fact]
    public async Task Merges_retire_preserved_rows_and_keep_lifecycle_rows_after_the_new_block()
    {
        await using var f = await RetentionFixture.CreateAsync(4);
        var kept = await f.Append("user", Text());
        await f.Append("user", Text());
        await f.Compact(kept);
        var notice = await f.Append(
            "user",
            new JsonObject
            {
                ["system"] = "<foxwarm-system kind=\"session-boundary\" event=\"notice\" />",
            }
        );
        await f.Append("user", Text());
        await f.Compact();
        await f.Append("user", Text());
        await f.Compact();
        Assert.Equal("L1 P N L1 L1", f.Layout());

        // Level 1 overflows: the two oldest blocks merge. The row kept by the first retires and
        // the notice between them stays after the new block.
        await f.Append("user", Text());
        await f.Compact();
        Assert.Equal("L2 N L1 L1", f.Layout());
        Assert.DoesNotContain(
            f.Owner.History(),
            row => CompactCandidateBuilder.Number(row["__meta"]?["seq"]) == kept
        );
        Assert.Single(
            f.Owner.History(),
            row => CompactCandidateBuilder.Number(row["__meta"]?["seq"]) == notice
        );
        Assert.Contains(f.Owner.Archive.ReadMessages(), row => row.Seq == kept);
        var merged = f.Owner.Archive.ReadBlocks().Single(block => block.Level == 2);
        Assert.Equal(
            new long[] { 1, 2 },
            merged.SourceBlockIds!.Select(id => id!.GetValue<long>()).ToArray()
        );
        Assert.Equal(4, f.Requests);
    }

    [Fact]
    public async Task Over_budget_summaries_are_accepted_after_two_budget_repairs_and_recorded()
    {
        await using var f = await RetentionFixture.CreateAsync(3);
        await f.Append("user", Text());
        await f.Append("user", Text());
        // ~4,000 estimated tokens against the 3,000-token budget of a new level-1 block.
        var over = f.Required(summaryChars: 12200);
        await f.Run(over, over, over);
        Assert.Equal(3, f.Requests);
        Assert.Equal("L1", f.Layout());
        var completion = f.Owner.History().Single(CompactCandidateBuilder.Completion);
        var recorded = Assert.Single(
            completion["compaction"]!["planner"]!["overBudget"]!.AsArray()
        )!;
        Assert.Equal(CompactRetention.NewBlockBudget, recorded["budget"]!.GetValue<int>());
        Assert.Equal(3, completion["compaction"]!["planner"]!["steps"]!.GetValue<int>());
    }
}
