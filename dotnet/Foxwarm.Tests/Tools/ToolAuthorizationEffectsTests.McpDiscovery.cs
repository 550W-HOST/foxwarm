using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// MCP server discovery under operation rules: the server is known, the tool name is not
// (operation authorization phase 3).
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Mcp_discovery_keeps_unknown_tool_names_unknown()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {op: mcp.call, mcp: {server: example, tool: permitted}, action: allow}\n"
        );
        Assert.True(manager.McpServerVisible(manager.VisibilityFor(owner), "example"));
        Assert.True(manager.ToolVisible(owner, "mcp", "permitted", "example"));
        Assert.False(manager.ToolVisible(owner, "mcp", "other", "example"));
        Assert.False(manager.McpServerVisible(manager.VisibilityFor(owner), "elsewhere"));
    }
}
