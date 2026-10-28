using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class LegacyHistoryAuthorityTests
{
    private static async Task<JsonObject> Source(string root)
    {
        var repo = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Owned Source checkout is required.");
        using var process = Process.Start(new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            ArgumentList = { Path.Combine(repo, "dotnet/Foxwarm.Tests/Fixtures/legacy-history-fixture-ts.mjs"), root },
        })!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        var text = await stdout;
        Assert.True(process.ExitCode == 0, text + await stderr);
        const string prefix = "LEGACY_HISTORY_FIXTURE:";
        return JsonNode.Parse(text.Split('\n').Single(line => line.StartsWith(prefix, StringComparison.Ordinal))[prefix.Length..])!.AsObject();
    }

    private static string Authority(string root, string id = "legacy") =>
        Path.Combine(root, "state", "sessions", id + ".json");

    private static void EqualHistory(JsonArray expected, IEnumerable<HistoryMessage> actual) =>
        Assert.True(JsonNode.DeepEquals(expected, new JsonArray(actual.Select(row => (JsonNode)row.ToJson()).ToArray())));

    private static Task Complete(System.Net.Sockets.NetworkStream stream, params JsonObject[] output) =>
        LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Encoding.UTF8.GetBytes(
            "data: " + new JsonObject
            {
                ["type"] = "response.completed",
                ["response"] = new JsonObject { ["id"] = "legacy-history-reply", ["output"] = new JsonArray(output.Cast<JsonNode>().ToArray()) },
            }.ToJsonString() + "\n\n"));

    [Fact]
    public async Task Source_history_load_save_fork_request_and_new_append_keep_missing_identity_and_recorded_provenance()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var fixture = await Source(data);
        Assert.True(fixture["sourceSaved"]!.GetValue<bool>());
        var expected = fixture["history"]!.AsArray();
        var original = await File.ReadAllTextAsync(Authority(data));
        var inspection = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(data));
        Assert.True(inspection.CanSelect);
        Assert.Empty(inspection.Issues);
        Assert.Equal(original, await File.ReadAllTextAsync(Authority(data)));
        await using var peer = new ScriptedResponsesSequenceServer(1, async (_, stream, captured) =>
        {
            var request = JsonNode.Parse(captured.Body)!;
            var wire = request["input"]!.ToJsonString();
            Assert.Contains("Legacy opening", wire);
            Assert.Contains("Legacy tool result without metadata", wire);
            Assert.Contains("Unsequenced large response", wire);
            Assert.Contains("Recorded sequence without recorded time", wire);
            Assert.Contains("Continue legacy work", wire);
            Assert.DoesNotContain("Retained unsequenced diagnostic", wire);
            Assert.DoesNotContain("__meta", wire);
            await Complete(stream, new JsonObject
            {
                ["type"] = "message", ["role"] = "assistant",
                ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = "Continued historical context." }),
            });
        });
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 50000);
        string childId;
        string[] archiveBefore;
        await using (var manager = new SessionManager(data, work, options, HostModels.ForTest(options)))
        {
            await manager.LoadMainHostAsync();
            Assert.Empty(manager.Owners());
            var owner = await manager.RequiredAsync("legacy");
            var snapshot = owner.Entry.Snapshot();
            EqualHistory(expected, snapshot.History);
            Assert.Equal(41, snapshot.NextMessageSeq);
            Assert.Equal("parent", SessionWait.Text(snapshot.AuthorityEnvelope["parentSessionId"]));
            Assert.Null(snapshot.History[0].Sequence);
            Assert.Equal(7, snapshot.History[4].Sequence);
            Assert.Null(snapshot.History[4].ToJson()["__meta"]!["timestamp"]);
            Assert.Equal(original, await File.ReadAllTextAsync(Authority(data)));
            archiveBefore = owner.Archive.ReadMessages().Select(row => row.MessageJson).ToArray();
            var renderer = new ContextPreviewRenderer(new JsonObject { ["previewLength"] = 2000 });
            var unidentified = renderer.Item(snapshot.History[0].ToJson(), sessionId: owner.Id);
            Assert.Null(unidentified.Sequence);
            Assert.Null(unidentified.DrillDown);
            Assert.Contains("Legacy opening", unidentified.Body);
            var identified = renderer.Item(snapshot.History[4].ToJson(), sessionId: owner.Id);
            Assert.Equal(7, identified.Sequence);
            Assert.Contains("msg#7", identified.DrillDown);
            var exact = await ArchiveRecallTool.ExecuteAsync(manager, owner, new JsonObject { ["target"] = "msg#1" });
            Assert.Contains("Legacy opening", exact["output"]!.GetValue<string>());
            Assert.Empty(owner.Archive.ReadEffectiveMessagesRange(2, 2));
            Assert.Null(snapshot.History[0].Sequence);
            await owner.Entry.SaveLane.SaveStrictAsync();
            var saved = JsonNode.Parse(await File.ReadAllTextAsync(Authority(data)))!;
            Assert.True(JsonNode.DeepEquals(expected, saved["history"]));
            Assert.Equal("parent", saved["parentSessionId"]!.GetValue<string>());
            Assert.Equal(archiveBefore, owner.Archive.ReadMessages().Select(row => row.MessageJson));

            var child = await manager.ForkAsync(owner, "copy");
            childId = child.Id;
            EqualHistory(expected, child.Entry.Snapshot().History.Take(expected.Count));
            Assert.Equal(40, child.Archive.ReadBranch()!.MessageCap);
            Assert.Equal(new long[] { 41, 42 }, child.Archive.ReadMessages().Select(row => row.Seq));
            Assert.Equal("legacy", Assert.Single(child.Archive.ReadEffectiveMessagesRange(1, 1)).SessionId);
            Assert.Null(child.Entry.Snapshot().History[0].Sequence);

            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await new SessionRuntime(manager).SubmitAndRunAsync(owner.Id, QueueItem.UserText("Continue legacy work"));
            await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(1, peer.RequestCount);
            var continued = owner.Entry.Snapshot();
            EqualHistory(expected, continued.History.Take(expected.Count));
            Assert.Equal(new long?[] { 41, 42 }, continued.History.Skip(expected.Count).Select(row => row.Sequence));
            Assert.Equal(43, continued.NextMessageSeq);
            Assert.Equal(archiveBefore, owner.Archive.ReadMessages().Take(archiveBefore.Length).Select(row => row.MessageJson));
            Assert.All(owner.Archive.ReadMessages().Skip(archiveBefore.Length), row =>
            {
                Assert.Equal(row.Seq, CompactCandidateBuilder.Number(row.Message["__meta"]!["seq"]));
                Assert.True(row.Timestamp > 40000);
                Assert.Equal(row.Timestamp, SessionWait.Number(row.Message["__meta"]!["timestamp"]));
            });
        }
        await using (var reopened = new SessionManager(data, work, options, HostModels.ForTest(options)))
        {
            await reopened.LoadMainHostAsync();
            var owner = await reopened.RequiredAsync("legacy");
            EqualHistory(expected, owner.Entry.Snapshot().History.Take(expected.Count));
            Assert.Equal(43, owner.Entry.Snapshot().NextMessageSeq);
            var child = await reopened.RequiredAsync(childId);
            EqualHistory(expected, child.Entry.Snapshot().History.Take(expected.Count));
            Assert.Equal(archiveBefore, owner.Archive.ReadMessages().Take(archiveBefore.Length).Select(row => row.MessageJson));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Null_parent_uses_catalog_topology_and_survives_first_catalog_migration(bool hasParent)
    {
        using var temp = new TempDirectory();
        await SessionCatalogMigrationTests.Authority(temp.Path, "legacy");
        var file = Authority(temp.Path);
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["parentSessionId"] = null;
        raw["history"] = new JsonArray(new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "Legacy no metadata" }) });
        raw["meta"]!["messageCount"] = 1;
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        var row = SessionCatalogTests.Row("legacy", 0);
        row["parentSessionId"] = hasParent ? "parent" : null;
        var rows = new JsonObject { ["legacy"] = row };
        if (hasParent)
        {
            await SessionCatalogMigrationTests.Authority(temp.Path, "parent");
            rows["parent"] = SessionCatalogTests.Row("parent", 0);
        }
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "state/sessions.json"), new JsonObject { ["sessions"] = rows }.ToJsonString());
        var original = await File.ReadAllTextAsync(file);
        var report = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(temp.Path));
        Assert.Empty(report.Issues);
        Assert.Equal(original, await File.ReadAllTextAsync(file));
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        await using var manager = new SessionManager(temp.Path, Path.Combine(temp.Path, "work"), options, HostModels.ForTest(options));
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("legacy");
        Assert.Equal(hasParent ? "parent" : null, SessionWait.Text(owner.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]));
        await owner.Entry.SaveLane.SaveStrictAsync();
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(file))!;
        Assert.True(JsonNode.DeepEquals(raw["history"], saved["history"]));
        Assert.Equal(hasParent, saved.AsObject().ContainsKey("parentSessionId"));
    }

    [Fact]
    public void Active_optional_metadata_does_not_relax_new_Archive_admission_or_present_invalid_fields()
    {
        var message = new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "Legacy" }) };
        foreach (var metadata in new JsonNode?[] { null, new JsonObject(), new JsonObject { ["timestamp"] = 0 }, new JsonObject { ["seq"] = 3 }, new JsonObject { ["seq"] = null, ["timestamp"] = null } })
        {
            message["__meta"] = metadata?.DeepClone();
            SessionAuthorityDocument.ValidateMessage(message, null, "history[0]");
            Assert.Throws<InvalidDataException>(() => ArchiveMessageRecord.Create("legacy", "main", 3, 0, message));
        }
        foreach (var invalid in new JsonObject[] { new() { ["seq"] = 0 }, new() { ["seq"] = -1 }, new() { ["seq"] = 1.5 }, new() { ["seq"] = "3" }, new() { ["timestamp"] = "old" } })
        {
            message["__meta"] = invalid;
            Assert.Throws<InvalidDataException>(() => SessionAuthorityDocument.ValidateMessage(message, null, "history[0]"));
        }
        message["__meta"] = new JsonObject { ["seq"] = 3, ["timestamp"] = 0 };
        Assert.Equal(3, ArchiveMessageRecord.Create("legacy", "main", 3, 0, message).Seq);
    }
}
