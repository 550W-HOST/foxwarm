using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Channel guests take their authorization policy from a creator template Agent.
public sealed class GuestTemplateTests
{
    private static ExternalChannelContext Source(string sender = "11") =>
        new("alpha", "telegram", "guest-" + sender, sender, "operator", _ => Task.CompletedTask);

    private static async Task<ExternalChannelFixture> Fixture(JsonObject guest)
    {
        var channel = ExternalChannelFixture.Channel();
        channel["guestAgent"] = guest;
        return await ExternalChannelFixture.CreateAsync(new JsonObject { ["alpha"] = channel });
    }

    private static JsonArray TemplateRules() =>
        new(
            new JsonObject
            {
                ["id"] = "guest-wait",
                ["action"] = "allow",
                ["match"] = new JsonObject
                {
                    ["tool"] = new JsonObject { ["source"] = "builtin", ["name"] = "wait" },
                },
            },
            new JsonObject { ["id"] = "guest-deny", ["action"] = "deny" }
        );

    private static async Task<bool> Allowed(SessionManager manager, SessionOwner owner, string name)
    {
        try
        {
            await manager.AuthorizeToolAsync(
                owner,
                new ResolvedTool(name, "builtin", name, new JsonObject()),
                null,
                CancellationToken.None
            );
            return true;
        }
        catch (ToolAuthorizationDeniedException)
        {
            return false;
        }
    }

    [Fact]
    public async Task Inherited_guests_are_created_by_the_template_and_bounded_by_its_rules()
    {
        await using var f = await Fixture(
            new JsonObject
            {
                ["agentId"] = "guest",
                ["mode"] = "inherited",
                ["template"] = "guest",
                ["node"] = "guest-node",
            }
        );
        await f.Manager.CreateAgentAsync("guest", false);
        await f.Manager.SetAgentRulesAsync("guest", TemplateRules());
        var created = await f.Manager.ProvisionChannelGuestAsync(Source());
        Assert.NotNull(created);
        Assert.NotEqual("guest", created.Agent);
        Assert.Equal("guest", f.Manager.AgentInherit(created.Agent));
        var row = f.Manager.AgentMetadata[created.Agent]!.AsObject();
        Assert.Equal("guest", row["createdBy"]!.GetValue<string>());
        Assert.Equal("guest-node", row["defaultNode"]!.GetValue<string>());
        Assert.Null(row["isolated"]);
        Assert.Null(row["rules"]);
        Assert.True(await Allowed(f.Manager, created, "wait"));
        Assert.False(await Allowed(f.Manager, created, "list_agents"));

        // One edit of the template updates every guest.
        await f.Manager.SetAgentRulesAsync(
            "guest",
            new JsonArray(new JsonObject { ["id"] = "guest-deny", ["action"] = "deny" })
        );
        Assert.False(await Allowed(f.Manager, created, "wait"));
    }

    [Fact]
    public async Task Guest_provisioning_refuses_without_a_template_unless_explicitly_unrestricted()
    {
        await using (
            var f = await Fixture(new JsonObject { ["agentId"] = "guest", ["mode"] = "inherited" })
        )
        {
            await f.Manager.CreateAgentAsync("guest", false);
            var refused = await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Manager.ProvisionChannelGuestAsync(Source())
            );
            Assert.Contains("template", refused.Message);
            Assert.Equal(["guest", "main"], f.Manager.Agents().Order());
        }

        // A configuration written for legacy isolation (isolated plus node) is refused too.
        await using (
            var f = await Fixture(
                new JsonObject
                {
                    ["agentId"] = "guest",
                    ["mode"] = "inherited",
                    ["isolated"] = true,
                    ["node"] = "guest-node",
                }
            )
        )
        {
            await f.Manager.CreateAgentAsync("guest", false);
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Manager.ProvisionChannelGuestAsync(Source())
            );
        }

        // A template without rules would bound nothing.
        await using (
            var f = await Fixture(
                new JsonObject
                {
                    ["agentId"] = "guest",
                    ["mode"] = "inherited",
                    ["template"] = "guest",
                }
            )
        )
        {
            await f.Manager.CreateAgentAsync("guest", false);
            var refused = await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Manager.ProvisionChannelGuestAsync(Source())
            );
            Assert.Contains("no rules", refused.Message);
        }

        await using (
            var f = await Fixture(
                new JsonObject
                {
                    ["agentId"] = "guest",
                    ["mode"] = "inherited",
                    ["isolated"] = false,
                }
            )
        )
        {
            await f.Manager.CreateAgentAsync("guest", false);
            var created = await f.Manager.ProvisionChannelGuestAsync(Source());
            Assert.NotNull(created);
            Assert.Null(f.Manager.AgentMetadata[created.Agent]?["createdBy"]);
        }
    }

    [Fact]
    public async Task Single_mode_guests_require_the_template_chain_and_configured_default_Node()
    {
        await using var f = await Fixture(
            new JsonObject
            {
                ["agentId"] = "guest",
                ["template"] = "policy",
                ["node"] = "guest-node",
            }
        );
        await f.Manager.CreateAgentAsync("policy", false);
        await f.Manager.SetAgentRulesAsync("policy", TemplateRules());
        await f.Manager.CreateAgentAsync("guest", false);
        var refused = await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.ProvisionChannelGuestAsync(Source("21"))
        );
        Assert.Contains("template", refused.Message);

        await f.Manager.DeleteAgentAsync("guest");
        await f.Manager.CreateAgentAsync(
            "guest",
            false,
            guestTemplate: "policy",
            defaultNode: "other-node"
        );
        refused = await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.ProvisionChannelGuestAsync(Source("22"))
        );
        Assert.Contains("default Node", refused.Message);

        await f.Manager.SetAgentDefaultPlacementAsync("guest", true, "guest-node", false, null);
        var created = await f.Manager.ProvisionChannelGuestAsync(Source("23"));
        Assert.NotNull(created);
        Assert.Equal("guest", created.Agent);
        Assert.False(await Allowed(f.Manager, created, "list_agents"));
        Assert.True(await Allowed(f.Manager, created, "wait"));
    }
}
