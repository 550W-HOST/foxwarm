using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCreationParityTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Selected_prompt_admission_uses_creator_read_authority_not_destination_isolation(
        bool unified
    )
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        f.Manager.Nodes.Registry.Create("prompt-bound");
        await f.Manager.CreateAgentAsync("restricted", false, isolatedNode: "prompt-bound");
        var directory = f.Manager.AgentDirectory("restricted");
        var outside = Path.Combine(f.Data, "outside.md");
        await File.WriteAllTextAsync(outside, "outside selected prompt");
        await File.WriteAllTextAsync(
            Path.Combine(directory, "selected.md"),
            "target selected prompt"
        );

        async Task<JsonNode?> Create(string name, string path, SessionOwner? creator = null)
        {
            var args = new JsonObject
            {
                ["agentName"] = "restricted",
                ["sessionName"] = name,
                ["node"] = "master",
                ["systemPromptFiles"] = new JsonArray(path),
            };
            return unified
                ? await f.ToolAsync(
                    "call_tool",
                    new JsonObject { ["toolId"] = "builtin:create_session", ["args"] = args },
                    creator
                )
                : await f.ToolAsync("create_session", args, creator);
        }
        // A full-access creator may select outside files for an isolated, remotely bound target.
        Successful(await Create("outside-allowed", outside));
        var admitted = await f.Manager.RequiredAsync("restricted/outside-allowed");
        Assert.Equal("prompt-bound", f.Manager.CurrentNode(admitted));
        Assert.Contains(
            "outside selected prompt",
            admitted.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString()
        );
        Successful(await Create("relative-allowed", "memory/../selected.md"));
        Assert.Contains(
            "target selected prompt",
            (await f.Manager.RequiredAsync("restricted/relative-allowed"))
                .Entry.Snapshot()
                .AuthorityEnvelope["persistentMemorySnapshot"]!.ToString()
        );

        await f.Manager.CreateAgentAsync("creator", false);
        var creator = await f.Manager.CreateNamedAsync("creator", "main", null, null);
        var ownFile = Path.Combine(f.Manager.AgentDirectory("creator"), "selected.md");
        await File.WriteAllTextAsync(ownFile, "creator-owned prompt");
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                """
                version: 1
                rules:
                - id: creator-read-scope
                  action: deny
                  match:
                    agent: creator
                    tool: {source: node, name: read}
                    path: {anyNotWithin: '${agent.dir}'}
                """
            ),
            default
        );
        Successful(await Create("creator-owned", ownFile, creator));
        var initial = f.Manager.Catalog.List().Select(row => SessionWait.Text(row["id"])).ToArray();
        foreach (var path in new[] { outside, "selected.md", Path.Combine(f.Data, "missing.md") })
        {
            var denied = await Create("denied", path, creator);
            Assert.Contains(
                "Tool authorization rule denies node capability `read`",
                denied!["error"]!["message"]!.GetValue<string>()
            );
            Assert.Equal(
                initial,
                f.Manager.Catalog.List().Select(row => SessionWait.Text(row["id"])).ToArray()
            );
            Assert.Null(await f.Manager.GetExistingAsync("restricted/denied"));
            Assert.False(
                File.Exists(Path.Combine(f.Data, "state", "sessions", "restricted", "denied.json"))
            );
        }
        // Selection does not bypass the independent structural prohibition on isolated creators.
        var isolatedDenied = await Create("isolated-denied", "selected.md", admitted);
        Assert.Equal("tool_authorization_denied", isolatedDenied!["error"]!["type"]!.ToString());
        Assert.Null(f.Manager.Catalog.Get("restricted/isolated-denied"));

        // Admission is not a target's ongoing read permission: ordinary refresh keeps the selection.
        await File.WriteAllTextAsync(outside, "updated admitted prompt");
        Successful(
            await f.ToolAsync(
                "refresh_session_snapshot",
                new JsonObject { ["sessionId"] = admitted.Id }
            )
        );
        Assert.Contains(
            "updated admitted prompt",
            admitted.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString()
        );
    }

    [Fact]
    public async Task Session_create_command_uses_operator_authority_even_when_attached_to_an_isolated_Agent()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        f.Manager.Nodes.Registry.Create("prompt-bound");
        await f.Manager.CreateAgentAsync("restricted", false, isolatedNode: "prompt-bound");
        var attached = await f.Manager.CreateNamedAsync("restricted", "main", null, null);
        var outside = Path.Combine(f.Data, "outside.md");
        await File.WriteAllTextAsync(outside, "command outside prompt");
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
        f.Manager.AttachChannel(source.Target, attached);
        await f.Router.HandleExternalMessageAsync(
            source,
            new([
                new JsonObject
                {
                    ["text"] = $"/session create restricted allowed --system-prompt-file {outside}",
                },
            ])
        );
        var created = await f.Manager.RequiredAsync("restricted/allowed");
        Assert.Equal(
            created.Id,
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
        Assert.Contains(
            "command outside prompt",
            created.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString()
        );
        Assert.Equal("prompt-bound", f.Manager.CurrentNode(created));
        Assert.Contains(
            replies,
            text => text.Contains("Created session", StringComparison.Ordinal)
        );
        await f.Router.HandleExternalMessageAsync(
            source,
            new([
                new JsonObject
                {
                    ["text"] = "/session create restricted missing --system-prompt-file missing.md",
                },
            ])
        );
        Assert.Null(f.Manager.Catalog.Get("restricted/missing"));
        Assert.Equal(
            created.Id,
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
    }
}
