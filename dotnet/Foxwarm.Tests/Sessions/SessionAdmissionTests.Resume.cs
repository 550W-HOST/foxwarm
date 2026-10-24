using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionAdmissionTests
{
    [Fact]
    public void Resume_wrapper_keeps_reference_attribute_order_escaping_and_local_timestamp()
    {
        var wrapper = SessionBoundary.SystemEvent("session-resumed", "\"quoted\" <event> & 'hint'");
        Assert.Matches(
            "^<foxwarm-system kind=\"event\" type=\"session-resumed\" hint=\"&quot;quoted&quot; &lt;event&gt; &amp; 'hint'\" time=\"\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} [+-]\\d{4}\" />$",
            wrapper
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Busy_recovery_recognizes_existing_resume_wrappers_in_either_attribute_order(
        bool referenceOrder
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Seed(data, "busy");
        var wrapper = referenceOrder
            ? SessionBoundary.SystemEvent("session-resumed", "Existing restart event")
            : "<foxwarm-system hint=\"Existing restart event\" time=\"2026-01-01 00:00:00 +0000\" type=\"session-resumed\" kind=\"event\" />";
        var file = Path.Combine(data, "state", "sessions", "busy.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["busy"] = true;
        raw["busyStartedAt"] = 1;
        raw["queue"] = new JsonArray(
            PersistentSessionAuthorityStore.ToQueueJson(
                new QueueItem(QueueItemType.Background, [new JsonObject { ["system"] = wrapper }])
            )
        );
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        var owner = await manager.RequiredAsync("busy");
        Assert.False(owner.Metadata().Busy);
        var retained = Assert.Single(owner.Entry.Snapshot().Queue);
        Assert.Equal(wrapper, SessionWait.Text(Assert.Single(retained.Parts!)["system"]));
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        Assert.False(saved["busy"]!.GetValue<bool>());
        Assert.Single(saved["queue"]!.AsArray());
        Assert.Equal(wrapper, SessionWait.Text(saved["queue"]![0]!["parts"]![0]!["system"]));
    }
}
