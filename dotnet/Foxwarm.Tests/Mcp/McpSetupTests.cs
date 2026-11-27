using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

// Setup > MCP: the form view keeps literal credentials out of the browser and a save puts them
// back exactly where they were; replacement and removal use the managed configuration lane.
public sealed class McpSetupTests
{
    private static JsonObject Stored() =>
        new()
        {
            ["transport"] = "stdio",
            ["command"] = "node",
            ["args"] = new JsonArray("server.js", "--key", "arg-secret", "--mode=fast", "${secret:arg-ref}"),
            ["env"] = new JsonObject
            {
                ["API_KEY"] = "env-secret",
                ["LOG_LEVEL"] = "debug",
                ["SERVICE_TOKEN"] = "${secret:service}",
            },
            ["cwd"] = "/srv/peer",
            ["timeoutSeconds"] = 30,
            ["description"] = "kept outside the form",
        };

    [Fact]
    public void View_hides_literal_credentials_and_shows_references_and_ordinary_values()
    {
        var stored = Stored();
        var view = McpClient.SetupView(stored);
        var text = view.ToJsonString();
        Assert.DoesNotContain("arg-secret", text);
        Assert.DoesNotContain("env-secret", text);
        Assert.Equal(
            """{"hidden":"args","index":2}""",
            view["args"]![2]!.ToJsonString()
        );
        Assert.Equal("--key", view["args"]![1]!.GetValue<string>());
        Assert.Equal("--mode=fast", view["args"]![3]!.GetValue<string>());
        Assert.Equal("${secret:arg-ref}", view["args"]![4]!.GetValue<string>());
        Assert.Equal("""{"hidden":"env","key":"API_KEY"}""", view["env"]!["API_KEY"]!.ToJsonString());
        Assert.Equal("debug", view["env"]!["LOG_LEVEL"]!.GetValue<string>());
        Assert.Equal("${secret:service}", view["env"]!["SERVICE_TOKEN"]!.GetValue<string>());
        Assert.Null(view["description"]);

        var http = McpClient.SetupView(
            new JsonObject
            {
                ["transport"] = "auto",
                ["url"] = "https://user:url-password@mcp.example.com/mcp",
                ["token"] = "token-secret",
                ["headers"] = new JsonObject { ["X-Api-Key"] = "header-secret", ["X-Trace"] = "visible" },
                ["oauth"] = new JsonObject { ["clientId"] = "client", ["clientSecret"] = "oauth-secret" },
            }
        );
        var httpText = http.ToJsonString();
        foreach (var secret in new[] { "url-password", "token-secret", "header-secret", "oauth-secret" })
            Assert.DoesNotContain(secret, httpText);
        Assert.Equal("""{"hidden":"url"}""", http["url"]!.ToJsonString());
        Assert.Equal("visible", http["headers"]!["X-Trace"]!.GetValue<string>());
        Assert.True(http["oauth"]!["hasClientSecret"]!.GetValue<bool>());
        Assert.Equal(
            "https://mcp.example.com/mcp",
            McpClient.SetupView(new JsonObject { ["url"] = "https://mcp.example.com/mcp" })["url"]!.GetValue<string>()
        );
    }

    [Fact]
    public void Save_restores_hidden_values_at_their_original_location()
    {
        var stored = Stored();
        var view = McpClient.SetupView(stored);
        Assert.True(JsonNode.DeepEquals(stored, McpClient.FromSetupView(view, stored)));

        // A renamed variable keeps its hidden value; fields the form omits are removed.
        var edited = (JsonObject)view.DeepClone();
        var env = edited["env"]!.AsObject();
        env["PRIMARY_KEY"] = env["API_KEY"]!.DeepClone();
        env.Remove("API_KEY");
        edited.Remove("cwd");
        var saved = McpClient.FromSetupView(edited, stored);
        Assert.Equal("env-secret", saved["env"]!["PRIMARY_KEY"]!.GetValue<string>());
        Assert.Null(saved["cwd"]);
        Assert.Equal("kept outside the form", saved["description"]!.GetValue<string>());

        // A hidden value cannot move into another field, where it could be displayed.
        var moved = (JsonObject)view.DeepClone();
        moved["cwd"] = view["env"]!["API_KEY"]!.DeepClone();
        moved["args"]!.AsArray().Add(new JsonObject { ["hidden"] = "env", ["key"] = "API_KEY" });
        Assert.Throws<InvalidDataException>(() => McpClient.FromSetupView(moved, stored));
        var gone = (JsonObject)view.DeepClone();
        gone["args"]![2] = new JsonObject { ["hidden"] = "args", ["index"] = 9 };
        Assert.Throws<InvalidDataException>(() => McpClient.FromSetupView(gone, stored));
        Assert.Throws<InvalidDataException>(
            () => McpClient.FromSetupView(new JsonObject { ["description"] = "x" }, stored)
        );
    }

    [Fact]
    public async Task Replace_and_remove_go_through_the_lane_and_refusals_change_nothing()
    {
        using var temp = new TempDirectory();
        await using var mcp = new McpClient(temp.Path);
        var file = Path.Combine(temp.Path, "state", "mcp.json");
        await mcp.ReplaceServerAsync(
            "peer",
            current =>
            {
                Assert.Null(current);
                return new JsonObject { ["transport"] = "stdio", ["command"] = "node" };
            }
        );
        var revision = McpClient.Revision(mcp.Configuration.Snapshot()["peer"]);
        Assert.StartsWith("sha256:", revision);
        Assert.Equal("absent", McpClient.Revision(null));

        await Assert.ThrowsAsync<InvalidDataException>(
            () => mcp.ReplaceServerAsync("peer", _ => new JsonObject { ["transport"] = "stdio" })
        );
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => mcp.RemoveServerAsync("peer", _ => throw new InvalidOperationException("refused"))
        );
        Assert.Equal(revision, McpClient.Revision(mcp.Configuration.Snapshot()["peer"]));
        Assert.Contains("\"peer\"", await File.ReadAllTextAsync(file));

        await mcp.RemoveServerAsync(
            "peer",
            current => Assert.Equal(revision, McpClient.Revision(current))
        );
        Assert.Null(mcp.Configuration.Snapshot()["peer"]);
        Assert.DoesNotContain("\"peer\"", await File.ReadAllTextAsync(file));
        await Assert.ThrowsAsync<InvalidDataException>(() => mcp.RemoveServerAsync("peer", _ => { }));
    }
}
