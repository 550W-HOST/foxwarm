using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCreationParityTests
{
    [Fact]
    public async Task Selected_prompt_files_follow_target_isolation_before_creation_and_keep_bound_Node_precedence()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        f.Manager.Nodes.Registry.Create("prompt-bound");
        await f.Manager.CreateAgentAsync("restricted", false, isolatedNode: "prompt-bound");
        var directory = f.Manager.AgentDirectory("restricted");
        var outside = Path.Combine(f.Data, "outside.md");
        await File.WriteAllTextAsync(outside, "synthetic outside prompt marker");
        await File.WriteAllTextAsync(
            Path.Combine(directory, "selected.md"),
            "target prompt marker"
        );
        var sibling = directory + "-sibling";
        Directory.CreateDirectory(sibling);
        await File.WriteAllTextAsync(Path.Combine(sibling, "selected.md"), "sibling prompt marker");
        var initial = f.Manager.Catalog.List().Select(row => SessionWait.Text(row["id"])).ToArray();
        foreach (
            var path in new[]
            {
                outside,
                Path.Combine(f.Data, "missing.md"),
                Path.Combine(sibling, "selected.md"),
            }
        )
        {
            var response = await f.ToolAsync(
                "create_session",
                new JsonObject
                {
                    ["agentName"] = "restricted",
                    ["sessionName"] = "rejected",
                    ["systemPromptFiles"] = new JsonArray(path),
                }
            );
            Assert.Contains("can only access agents/restricted/", response!["error"]!.ToString());
            Assert.Equal(
                initial,
                f.Manager.Catalog.List().Select(row => SessionWait.Text(row["id"])).ToArray()
            );
            Assert.Null(await f.Manager.GetExistingAsync("restricted/rejected"));
            Assert.False(
                File.Exists(
                    Path.Combine(f.Data, "state", "sessions", "restricted", "rejected.json")
                )
            );
        }
        async Task<SessionOwner> Create(string agent, string name, string path)
        {
            var response = await f.ToolAsync(
                "create_session",
                new JsonObject
                {
                    ["agentName"] = agent,
                    ["sessionName"] = name,
                    ["node"] = "master",
                    ["systemPromptFiles"] = new JsonArray(path),
                }
            );
            Assert.True(
                response is JsonObject && response["error"] is null,
                response?.ToJsonString()
            );
            return await f.Manager.RequiredAsync(agent == "main" ? name : agent + "/" + name);
        }
        var owned = await Create("restricted", "owned", "memory/../selected.md");
        Assert.Equal("prompt-bound", f.Manager.CurrentNode(owned));
        var ownedDisk = JsonNode.Parse(
            await File.ReadAllTextAsync(owned.AuthorityStore.AuthorityPath)
        )!;
        Assert.Contains("target prompt marker", ownedDisk["persistentMemorySnapshot"]!.ToString());
        Assert.DoesNotContain(
            "synthetic outside prompt marker",
            ownedDisk["persistentMemorySnapshot"]!.ToString()
        );
        var unrestricted = await Create("main", "outside-allowed", outside);
        var outsideDisk = JsonNode.Parse(
            await File.ReadAllTextAsync(unrestricted.AuthorityStore.AuthorityPath)
        )!;
        Assert.Contains(
            "synthetic outside prompt marker",
            outsideDisk["persistentMemorySnapshot"]!.ToString()
        );
    }

    [Fact]
    public async Task Session_create_command_uses_the_same_target_prompt_file_boundary_without_changing_binding()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        f.Manager.Nodes.Registry.Create("prompt-bound");
        await f.Manager.CreateAgentAsync("restricted", false, isolatedNode: "prompt-bound");
        var outside = Path.Combine(f.Data, "outside.md");
        await File.WriteAllTextAsync(outside, "synthetic command outside marker");
        var replies = new List<string>();
        var source = new ExternalChannelContext(
            "alpha",
            "telegram",
            "prompt-selection",
            "11",
            "operator",
            text =>
            {
                replies.Add(text);
                return Task.CompletedTask;
            }
        );
        f.Manager.AttachChannel(source.Target, f.Owner);
        await f.Router.HandleExternalMessageAsync(
            source,
            new([
                new JsonObject
                {
                    ["text"] =
                        $"/session create restricted rejected --system-prompt-file {outside}",
                },
            ])
        );
        Assert.Contains(
            replies,
            text => text.Contains("can only access agents/restricted/", StringComparison.Ordinal)
        );
        Assert.Null(f.Manager.Catalog.Get("restricted/rejected"));
        Assert.Equal(
            f.Owner.Id,
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
    }
}
