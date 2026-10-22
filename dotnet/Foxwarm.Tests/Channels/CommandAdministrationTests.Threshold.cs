using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class CommandAdministrationTests
{
    [Fact]
    public async Task Compact_threshold_command_rejects_floored_zero_without_replacing_saved_policy()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = Source(replies);
        f.Manager.AttachChannel(source.Target, f.Owner);
        var fallback = SessionWait.Number(f.Owner.BuildDto()["effectiveCompactThresholdTokens"]);
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session compact-threshold 8.75k")
        );
        var saved = await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath);
        Assert.Equal(8750, SessionWait.Number(JsonNode.Parse(saved)!["compactThresholdTokens"]));
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(
            source,
            Message("/session compact-threshold 0.9")
        );
        Assert.Contains("❌", replies.Single());
        Assert.Equal(8750, f.Owner.Metadata().CompactThreshold);
        Assert.Equal(
            8750,
            SessionWait.Number(f.Owner.BuildDto()["effectiveCompactThresholdTokens"])
        );
        Assert.Equal(saved, await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath));
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(source, Message("/session compact-threshold"));
        Assert.Contains("`8750`", replies.Single());
        foreach (var value in new[] { "1.9", "0.0019k" })
        {
            await f.Router.HandleExternalMessageAsync(
                source,
                Message("/session compact-threshold " + value)
            );
            Assert.Equal(1, f.Owner.Metadata().CompactThreshold);
            Assert.Equal(
                1,
                SessionWait.Number(
                    JsonNode.Parse(
                        await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath)
                    )!["compactThresholdTokens"]
                )
            );
        }
        foreach (var clear in new[] { "clear", "unset" })
        {
            await f.Router.HandleExternalMessageAsync(
                source,
                Message("/session compact-threshold 8000 ignored")
            );
            Assert.Equal(8000, f.Owner.Metadata().CompactThreshold);
            await f.Router.HandleExternalMessageAsync(
                source,
                Message("/session compact-threshold " + clear)
            );
            Assert.Null(f.Owner.Metadata().CompactThreshold);
            Assert.Equal(
                fallback,
                SessionWait.Number(f.Owner.BuildDto()["effectiveCompactThresholdTokens"])
            );
            Assert.False(
                JsonNode
                    .Parse(await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath))!
                    .AsObject()
                    .ContainsKey("compactThresholdTokens")
            );
        }
        Assert.Empty(f.Owner.History());
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Compact_threshold_settings_validate_before_flooring_and_tool_keeps_its_caller_semantics()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        var definitions = SessionSettingsDefinitions.Definitions();
        foreach (var definition in UnifiedToolDefinitions.All())
            definitions.Add(definition?.DeepClone());
        f.Registry = SessionToolExecutor.CreateRegistry(
            definitions,
            f.Manager.OutboundMcp,
            owner => f.Manager.IdentityWorkspace(owner).ToolDirectory,
            f.Manager.Nodes
        );
        async Task Set(JsonObject args)
        {
            var result = await f.ToolAsync(
                "call_tool",
                new JsonObject
                {
                    ["source"] = "builtin",
                    ["name"] = "set_session_compact_threshold",
                    ["args"] = args,
                }
            );
            Assert.Null(result?["error"]);
        }
        var fallback = SessionWait.Number(f.Owner.BuildDto()["effectiveCompactThresholdTokens"]);
        await Set(new JsonObject { ["thresholdTokens"] = 8750.9 });
        Assert.Equal(8750, f.Owner.Metadata().CompactThreshold);
        var saved = await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Owner.Entry.SaveLane.CommitSettingsAsync(
                new JsonObject { ["compactThresholdTokens"] = 0 },
                f.Manager.Models
            )
        );
        Assert.Equal(saved, await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath));
        Assert.Equal(8750, f.Owner.Metadata().CompactThreshold);
        // Nonpositive/absent tool input inspects; a positive fraction reaches settings unfloored.
        await Set(new JsonObject { ["thresholdTokens"] = 0 });
        await Set(new JsonObject());
        Assert.Equal(saved, await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath));
        await Set(new JsonObject { ["thresholdTokens"] = 0.9 });
        Assert.Equal(0, f.Owner.Metadata().CompactThreshold);
        Assert.Equal(
            fallback,
            SessionWait.Number(f.Owner.BuildDto()["effectiveCompactThresholdTokens"])
        );
        Assert.Equal(
            0,
            SessionWait.Number(
                JsonNode.Parse(await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath))![
                    "compactThresholdTokens"
                ]
            )
        );
        await Set(new JsonObject { ["clear"] = true });
        Assert.Null(f.Owner.Metadata().CompactThreshold);
        Assert.False(
            JsonNode
                .Parse(await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath))!
                .AsObject()
                .ContainsKey("compactThresholdTokens")
        );
    }
}
