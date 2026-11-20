using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    // An operation names the MCP server or secret the handler changes: the trimmed name, so
    // padding a name doesn't escape a rule about it.
    [Fact]
    public async Task Writers_are_authorized_on_the_names_they_change()
    {
        await using var f = await ConfigurationFixture();
        async Task Policy(string yaml) => await f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(yaml), default);
        string? Type(JsonNode? result) => result?.FailureCode();

        await Policy("version: 1\nrules:\n- {op: mcp.manage, mcp: {server: protected-server}, action: deny}\n");
        foreach (var name in new[] { "protected-server", " protected-server ", "\tprotected-server\n" })
            Assert.Equal(
                "tool_authorization_denied",
                Type(await f.ToolAsync("mcp_config", new JsonObject { ["name"] = name, ["url"] = "http://127.0.0.1:1/mcp", ["enable"] = false }))
            );
        Assert.False(f.Manager.OutboundMcp.Configuration.Snapshot().ContainsKey("protected-server"));

        await Policy("version: 1\nrules:\n- {op: secret.manage, secret: {anyOf: [protected-key]}, action: deny}\n");
        foreach (var name in new[] { "protected-key", " protected-key " })
            Assert.Equal(
                "tool_authorization_denied",
                Type(await f.ToolAsync("add_secret", new JsonObject { ["name"] = name, ["description"] = "fixture", ["value"] = "synthetic-padded-0606" }))
            );
        Assert.False(f.Configuration.Secrets.Store.Contains("protected-key"));
    }
}
