using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WebUiPromptSnapshotTests
{
    [Fact]
    public async Task Authenticated_full_and_ranged_history_preserve_the_saved_prompt_not_current_memory()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var owner = await f.Manager.CreateNamedAsync("main", "prompt-history", null, null);
        await ForkClearLifecycleTests.AppendAsync(
            owner,
            Enumerable
                .Range(1, 3)
                .Select(i => new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "input " + i }),
                })
                .ToArray()
        );
        const string saved = "  Saved prompt\r\n<literal> & \"quotes\" \\ café 🦊\n\n";
        await owner.Entry.SaveLane.CommitMemorySnapshotAsync(saved);
        var captured = owner.Entry.Snapshot();
        var memory = Path.Combine(f.Work, "memory", "CURRENT.md");
        Directory.CreateDirectory(Path.GetDirectoryName(memory)!);
        await File.WriteAllTextAsync(memory, "Changed on disk, not the saved prompt.");
        var route = "api/sessions/" + owner.Id + "/history";
        Assert.Equal(HttpStatusCode.Unauthorized, (await f.Native.GetAsync(route)).StatusCode);
        foreach (
            var query in new[]
            {
                "",
                "?tail=1",
                "?prefixLength=2&historyVersion=" + captured.HistoryVersion,
                "?afterSeq=2&historyVersion=" + captured.HistoryVersion,
            }
        )
        {
            var history = (await f.Admin.GetFromJsonAsync<JsonObject>(route + query))!;
            Assert.Equal(saved, history["persistentMemorySnapshot"]!.GetValue<string>());
            Assert.False(history["session"]!.AsObject().ContainsKey("persistentMemorySnapshot"));
        }
        var authority = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(f.Manager.DataRoot, "state", "sessions", owner.Id + ".json")
            )
        )!;
        Assert.Equal(saved, authority["persistentMemorySnapshot"]!.GetValue<string>());

        await owner.Entry.SaveLane.CommitMemorySnapshotAsync("Later saved prompt");
        var oldResponse = WebUiContract.History(
            captured,
            f.Manager.Models,
            false,
            false,
            null,
            null,
            null
        );
        Assert.Equal(saved, oldResponse["persistentMemorySnapshot"]!.GetValue<string>());
        Assert.Equal(
            "Later saved prompt",
            (await f.Admin.GetFromJsonAsync<JsonObject>(route))![
                "persistentMemorySnapshot"
            ]!.GetValue<string>()
        );
    }

    [Theory]
    [InlineData(false, null)]
    [InlineData(true, null)]
    [InlineData(true, "")]
    public void Missing_null_and_empty_snapshot_remain_empty(bool present, string? text)
    {
        var state = new SessionState("main");
        if (present)
            state.AuthorityEnvelope["persistentMemorySnapshot"] = text;
        else
            state.AuthorityEnvelope.Remove("persistentMemorySnapshot");
        var models = Foxwarm.Models.HostModels.Parse(
            new JsonObject { ["providers"] = new JsonObject() },
            new JsonObject()
        );
        var history = WebUiContract.History(
            state.Snapshot(),
            models,
            false,
            false,
            null,
            null,
            null
        );
        Assert.Equal("", history["persistentMemorySnapshot"]!.GetValue<string>());
    }
}
