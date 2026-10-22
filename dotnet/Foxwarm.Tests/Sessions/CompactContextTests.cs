using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CompactContextTests
{
    private const string Completion =
        "<foxwarm-system kind=\"session-boundary\" event=\"compact-completed\" />";

    [Theory]
    [InlineData(Completion)]
    [InlineData(
        "<FOXWARM-SYSTEM event = \"compact-completed\" kind=\"session-boundary\">notice</FOXWARM-SYSTEM>"
    )]
    [InlineData("Compaction completed. Previous continuation.")]
    [InlineData("Manual compaction completed. Previous continuation.")]
    [InlineData("**COMPACTION COMPLETED. PARENT SESSION `p`. CURRENT SESSION ID IS `s`.**")]
    public void Only_standalone_model_visible_completion_notices_are_removed(string system)
    {
        var row = Message(new JsonObject { ["system"] = system });
        Assert.True(CompactCandidateBuilder.Completion(row));
        row["modelVisible"] = false;
        Assert.False(CompactCandidateBuilder.Completion(row));
        row.Remove("modelVisible");
        foreach (
            var content in new JsonObject[]
            {
                new() { ["text"] = "Keep this conversation." },
                new() { ["thinking"] = "Keep this reasoning." },
                new() { ["functionCall"] = new JsonObject { ["name"] = "read" } },
                new() { ["functionResponse"] = new JsonObject { ["name"] = "read" } },
                new() { ["inlineData"] = new JsonObject { ["mimeType"] = "image/png" } },
                new() { ["inlineDataRef"] = new JsonObject { ["imageId"] = "image" } },
            }
        )
        {
            row["parts"]!.AsArray().Add(content);
            Assert.False(CompactCandidateBuilder.Completion(row));
            row["parts"]!.AsArray().RemoveAt(1);
        }
        row["parts"]!
            .AsArray()
            .Add(new JsonObject { ["text"] = "System payload", ["systemPayload"] = true });
        Assert.True(CompactCandidateBuilder.Completion(row));
    }

    [Theory]
    [InlineData(
        "<foxwarm-message type=\"inter-agent\">Discuss event=\"compact-completed\".</foxwarm-message>"
    )]
    [InlineData(
        "<foxwarm-system kind=\"event\" hint=\"Discuss event=&quot;compact-completed&quot;\" />"
    )]
    [InlineData("<foxwarm-system kind=\"session-boundary\" event=\"new-child\" />")]
    [InlineData("<foxwarm-system-notice kind=\"session-boundary\" event=\"compact-completed\" />")]
    public void Quoted_markers_and_other_boundaries_are_not_completion_notices(string system)
    {
        Assert.False(
            CompactCandidateBuilder.Completion(Message(new JsonObject { ["system"] = system }))
        );
    }

    [Fact]
    public async Task Real_compaction_retains_recent_input_and_display_history_and_commits_continuation_context()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var peer = new LoopbackResponsesServer(
            async (stream, captured) =>
            {
                var texts = JsonNode.Parse(captured.Body)!["input"]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .SelectMany(row => (row["content"] as JsonArray)?.OfType<JsonObject>() ?? [])
                    .Select(row => SessionWait.Text(row["text"]) ?? "");
                var matches = Regex.Matches(
                    string.Join("\n", texts),
                    "^- M#(\\d+)(?:-#(\\d+))?\\s",
                    RegexOptions.Multiline
                );
                Assert.NotEmpty(matches);
                var last = matches[^1];
                var args = new JsonObject
                {
                    ["replaceAsBlocks"] = new JsonArray(
                        new JsonObject
                        {
                            ["level"] = 1,
                            ["sourceKind"] = "message",
                            ["sourceStart"] = long.Parse(matches[0].Groups[1].Value),
                            ["sourceEnd"] = long.Parse(
                                last.Groups[2].Success ? last.Groups[2].Value : last.Groups[1].Value
                            ),
                            ["summary"] = "Synthetic conversation and loaded instructions.",
                        }
                    ),
                };
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "compact-context",
                        ["output"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["call_id"] = "compact-plan",
                                ["name"] = "submit_compact_plan",
                                ["arguments"] = args.ToJsonString(),
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
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 20000);
        var models = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = peer.BaseUri.ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["contextLimit"] = 20000,
                        ["asyncCompact"] = false,
                    },
                },
            },
            new JsonObject()
        );
        string childId;
        long[] retainedSequences;
        long staleCompletionSeq;
        string marker;
        await using (
            var manager = new SessionManager(
                data,
                work,
                options,
                models,
                Path.Combine(temp.Path, "skills")
            )
        )
        {
            await manager.LoadMainHostAsync();
            var parent = await manager.CreateNamedAsync("main", "parent", null, null);
            var (owner, _) = await manager.CreateChildAsync(
                parent,
                "child",
                null,
                null,
                null,
                null
            );
            childId = owner.Id;
            var consumedSkillSequences = new List<long>();
            // Historical inputs still use real ingress and canonical Archive/authority commits.
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            async Task<long> Append(JsonObject row)
            {
                await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.Prebuilt(row));
                await owner
                    .Registry.HostFor(owner.Id)
                    .AppendQueuedInputsAsync(owner.Entry.State.Queue.ToArray());
                return owner.Entry.Snapshot().History.Last().Sequence!.Value;
            }
            foreach (
                var (name, skill) in new[]
                {
                    ("skill", "current-skill"),
                    ("load_skill", "legacy-skill"),
                }
            )
            {
                consumedSkillSequences.Add(
                    await Append(
                        Message(
                            new JsonObject
                            {
                                ["functionCall"] = new JsonObject
                                {
                                    ["id"] = skill,
                                    ["name"] = name,
                                    ["args"] = new JsonObject
                                    {
                                        ["action"] = "load",
                                        ["skillName"] = " " + skill + " ",
                                    },
                                },
                            },
                            "model"
                        )
                    )
                );
                consumedSkillSequences.Add(
                    await Append(
                        Message(
                            new JsonObject
                            {
                                ["functionResponse"] = new JsonObject
                                {
                                    ["tool_use_id"] = skill,
                                    ["name"] = name,
                                    ["response"] = new JsonObject
                                    {
                                        ["output"] = new string('s', 9000),
                                    },
                                },
                            },
                            "tool"
                        )
                    )
                );
            }
            for (var index = 0; index < 10; index++)
                await Append(
                    Message(
                        new JsonObject
                        {
                            ["text"] = "Context " + index + " " + new string('x', 9000),
                        }
                    )
                );
            var notice = Message(new JsonObject { ["text"] = "Recent retry notice" }, "model");
            notice["modelVisible"] = false;
            notice["__meta"] = new JsonObject { ["noticeType"] = "llm-retry" };
            var noticeSeq = await Append(notice);
            staleCompletionSeq = await Append(Message(new JsonObject { ["system"] = Completion }));
            var mixed = Message(new JsonObject { ["system"] = Completion });
            mixed["parts"]!
                .AsArray()
                .Add(new JsonObject { ["text"] = "Real conversation beside a lifecycle notice." });
            var mixedSeq = await Append(mixed);
            await manager.SendAsync(
                parent,
                owner.Id,
                "Keep investigating the quoted marker event=\"compact-completed\"; this is a real instruction.",
                trigger: false
            );
            await owner
                .Registry.HostFor(owner.Id)
                .AppendQueuedInputsAsync(owner.Entry.State.Queue.ToArray());
            var sentSeq = owner.Entry.Snapshot().History.Last().Sequence!.Value;
            var recentSkillSeq = await Append(
                Message(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "recent-skill",
                            ["name"] = "skill",
                            ["args"] = new JsonObject
                            {
                                ["action"] = "load",
                                ["skillName"] = "recent-skill",
                            },
                        },
                    },
                    "model"
                )
            );
            var recentResponseSeq = await Append(
                Message(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "recent-skill",
                            ["name"] = "skill",
                            ["response"] = new JsonObject
                            {
                                ["output"] = "Instructions still in the recent tail.",
                            },
                        },
                    },
                    "tool"
                )
            );
            retainedSequences = [noticeSeq, mixedSeq, sentSeq, recentSkillSeq, recentResponseSeq];
            var before = owner.Entry.Snapshot();
            var split = CompactCandidateBuilder.Split(before.History.Materialize());
            Assert.All(
                retainedSequences.Append(staleCompletionSeq),
                seq => Assert.True(seq >= before.History[split].Sequence)
            );
            var admission = await owner.Compactor.StartManualAsync();
            Assert.True(admission.Started);
            await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
            var after = owner.Entry.Snapshot();
            Assert.Single(owner.Archive.ReadBlocks());
            Assert.Equal(1, peer.RequestCount);
            Assert.Equal(0, owner.Entry.BestEffortFailureCount);
            var afterSequences = after.History.Select(row => row.Sequence).ToArray();
            Assert.All(retainedSequences, seq => Assert.Contains(seq, afterSequences));
            Assert.DoesNotContain(staleCompletionSeq, afterSequences);
            Assert.All(consumedSkillSequences, seq => Assert.DoesNotContain(seq, afterSequences));
            marker = after.History.Last().ToJson()["parts"]![0]!["system"]!.GetValue<string>();
            Assert.Contains("parentSessionId=\"" + parent.Id + "\"", marker);
            Assert.Contains("currentSessionId=\"" + childId + "\"", marker);
            Assert.Contains("`current-skill`, `legacy-skill`", marker);
            Assert.DoesNotContain("recent-skill", marker);
            Assert.Contains("action=&quot;load&quot;", marker);
            Assert.Equal(
                marker,
                owner.Archive.ReadMessages().Last().Message["parts"]![0]![
                    "system"
                ]!.GetValue<string>()
            );
            var archiveSequences = owner.Archive.ReadMessages().Select(row => row.Seq).ToArray();
            Assert.All(
                retainedSequences.Append(staleCompletionSeq).Concat(consumedSkillSequences),
                seq => Assert.Contains(seq, archiveSequences)
            );
            // A captured COW root remains unchanged after the replacement is published.
            Assert.Contains(before.History, row => row.Sequence == staleCompletionSeq);
        }
        await using var reloaded = new SessionManager(
            data,
            work,
            options,
            models,
            Path.Combine(temp.Path, "skills")
        );
        await reloaded.LoadMainHostAsync();
        var restored = await reloaded.RequiredAsync(childId);
        Assert.All(
            retainedSequences,
            seq => Assert.Contains(restored.Entry.Snapshot().History, row => row.Sequence == seq)
        );
        Assert.DoesNotContain(
            restored.Entry.Snapshot().History,
            row => row.Sequence == staleCompletionSeq
        );
        Assert.Equal(
            marker,
            restored.Entry.Snapshot().History.Last().ToJson()["parts"]![0]![
                "system"
            ]!.GetValue<string>()
        );
        Assert.Single(restored.Archive.ReadBlocks());
    }

    private static JsonObject Message(JsonObject part, string role = "user") =>
        new() { ["role"] = role, ["parts"] = new JsonArray(part) };
}
