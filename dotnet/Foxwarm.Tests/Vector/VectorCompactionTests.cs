using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorCompactionTests
{
    [Fact]
    public async Task Real_Main_planner_compaction_publishes_Archive_facts_and_indexes_them_only_after_authority_commit()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var planner = new ScriptedResponsesSequenceServer(1, async (_, stream, captured) =>
        {
            var request = JsonNode.Parse(captured.Body)!;
            var prompt = string.Join('\n', request["input"]!.AsArray().OfType<JsonObject>().SelectMany(row => (row["content"] as JsonArray)?.OfType<JsonObject>() ?? []).Select(part => SessionWait.Text(part["text"]) ?? ""));
            var matches = Regex.Matches(prompt, "^- M#(\\d+)(?:-#(\\d+))?\\s", RegexOptions.Multiline);
            Assert.NotEmpty(matches);
            var start = long.Parse(matches[0].Groups[1].Value);
            var final = matches[^1];
            var end = long.Parse(final.Groups[2].Success ? final.Groups[2].Value : final.Groups[1].Value);
            var arguments = new JsonObject
            {
                ["replaceAsBlocks"] = new JsonArray(new JsonObject
                {
                    ["level"] = 1, ["sourceKind"] = "message", ["sourceStart"] = start, ["sourceEnd"] = end,
                    ["summary"] = "violet configuration summary from the synthetic conversation",
                    ["memoryFacts"] = new JsonArray(new JsonObject { ["kind"] = "decision", ["text"] = "Use violet configuration for this synthetic conversation.", ["context"] = "Fixture decision.", ["attributedTo"] = "user" }),
                }),
            };
            var payload = new JsonObject
            {
                ["type"] = "response.completed", ["response"] = new JsonObject
                {
                    ["id"] = "vector-compact", ["output"] = new JsonArray(new JsonObject { ["type"] = "function_call", ["id"] = "vector-plan", ["call_id"] = "vector-plan", ["name"] = "submit_compact_plan", ["arguments"] = EcmaJson.Stringify(arguments) }),
                },
            };
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Encoding.UTF8.GetBytes("data: " + EcmaJson.Stringify(payload) + "\n\n"));
        });
        const string id = "compact-vector";
        await using (var manager = await f.ManagerAsync(lexical: true, modelPeer: planner.BaseUri))
        {
            var owner = await manager.CreateNamedAsync("main", id, null, null);
            await ForkClearLifecycleTests.AppendAsync(owner, Enumerable.Range(1, 8).Select(index => VectorFixture.Message("violet substantive history " + index + " " + new string('x', 1600), index % 2 == 0 ? "model" : "user")).ToArray());
            Assert.True((await owner.Compactor.StartManualAsync(keepPercent: 0)).Started);
            await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(10));
            await owner.DrainAsync().WaitAsync(TimeSpan.FromSeconds(10));
            var block = Assert.Single(owner.Archive.ReadBlocks());
            Assert.Single(block.MemoryFacts!);
            Assert.Contains(owner.Entry.Snapshot().History.Materialize(), row => row["compaction"] is JsonObject);
        }
        // The production shutdown drains accepted fact hooks before closing the native owner.
        await using var restarted = await f.ManagerAsync(lexical: true, modelPeer: planner.BaseUri);
        await restarted.Vector.WaitForStartupAsync();
        var hits = (await restarted.Vector.SearchAsync("violet", 10, new(SessionIds: [id]))).Hits;
        Assert.Contains(hits, hit => hit["matched_facts"] is JsonArray { Count: > 0 });
        Assert.Contains(f.Peer.Requests, request => request.Input.StartsWith("Memory fact (decision)", StringComparison.Ordinal));
    }
}
