using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorTransientRecallTests
{
    [Fact]
    public async Task Bootstrap_uses_the_last_visible_message_window_before_row_limits_and_obeys_captured_fork_caps_like_Source()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string parent = "main/parent";
        const string child = "main/captured";
        const string query = "StableMixedIdentifier";
        var records = new List<ArchiveMessageRecord>();
        for (var seq = 1; seq <= 2053; seq++)
        {
            var message = VectorFixture.Message(seq == 1 ? query + " original visible context" : query + " tool or hidden decoy", seq is 1 or 2053 ? "user" : "tool");
            message["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 };
            if (seq == 2053) message["modelVisible"] = false;
            records.Add(ArchiveMessageRecord.Create(parent, "main", seq, seq * 1000, message));
        }
        f.Archive(parent).WriteMessages(records);
        f.Archive(child).EnsureBranch(parent, 1, 0);
        var late = VectorFixture.Message(query + " forbidden late parent context");
        late["__meta"] = new JsonObject { ["seq"] = 2054, ["timestamp"] = 2054000 };
        records.Add(ArchiveMessageRecord.Create(parent, "main", 2054, 2054000, late));
        f.Archive(parent).WriteMessages([records[^1]]);
        var block = f.Block(parent, first: 1, last: 1, summary: query + " later parent block");
        f.Archive(parent).WriteBlocks([block]);
        var parentHits = ArchiveLexicalRecall.Search(f.Archive(parent), query, 10);
        Assert.Contains(parentHits, hit => VectorRuntime.Integer(hit["start_seq"]) == 1 && hit["kind"]!.GetValue<string>() == "raw");
        Assert.DoesNotContain(parentHits, hit => VectorRuntime.Integer(hit["start_seq"]) is 2052 or 2053);
        var captured = ArchiveLexicalRecall.Search(f.Archive(child), query, 10);
        var only = Assert.Single(captured);
        Assert.Equal(1, VectorRuntime.Integer(only["start_seq"]));
        Assert.DoesNotContain("forbidden", only.ToJsonString());
        var input = new JsonObject
        {
            ["sessionId"] = child, ["query"] = query,
            ["branches"] = new JsonArray(new JsonObject { ["sessionId"] = parent }, new JsonObject { ["sessionId"] = child, ["parentSessionId"] = parent, ["forkMessageSeq"] = 1, ["forkBlockId"] = 0 }),
            ["records"] = new JsonArray(records.Select(record => (JsonNode?)new JsonObject { ["v"] = 1, ["kind"] = "message", ["sessionId"] = record.SessionId, ["agent"] = record.Agent, ["seq"] = record.Seq, ["timestamp"] = record.Timestamp, ["role"] = record.Role, ["message"] = record.Message.DeepClone() }).ToArray()),
            ["blocks"] = JsonSerializer.SerializeToNode(new[] { block }, VectorWire.Json),
        };
        var inputPath = Path.Combine(f.Temp.Path, "transient-input.json");
        await File.WriteAllTextAsync(inputPath, EcmaJson.Stringify(input));
        var source = await VectorFixture.SourceAsync("transient", Path.Combine(f.Temp.Path, "source-transient"), inputPath, Path.Combine(f.Temp.Path, "transient-result.json"));
        VectorRecipeTests.EqualJson(source, new JsonArray(captured.Select(hit => (JsonNode?)hit).ToArray()));
    }
}
