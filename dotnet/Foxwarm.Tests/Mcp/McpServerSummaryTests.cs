using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class McpServerSummaryTests
{
    [Fact]
    public async Task Summaries_omit_url_header_and_env_credentials()
    {
        using var temp = new TempDirectory();
        await using var mcp = new McpClient(temp.Path);
        await mcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "query",
                ["url"] =
                    "https://user:url-password@mcp.example.com:8443/v1/mcp?apikey=url-secret&mode=mode-value&bare-secret#frag-secret",
                ["headers"] = new JsonObject { ["X-Api-Key"] = "header-secret" },
                ["token"] = "token-secret",
            },
            default
        );
        await mcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "stdio",
                ["transport"] = "stdio",
                ["command"] = "node",
                ["args"] = new JsonArray("server.js", "--key", "arg-secret"),
                ["env"] = new JsonObject { ["API_KEY"] = "env-secret" },
            },
            default
        );
        var listed = await mcp.ListServersAsync(default);
        var text = listed.ToJsonString();
        foreach (
            var secret in new[]
            {
                "url-password",
                "url-secret",
                "mode-value",
                "bare-secret",
                "frag-secret",
                "header-secret",
                "token-secret",
                "arg-secret",
                "env-secret",
            }
        )
            Assert.DoesNotContain(secret, text);
        var query = listed["servers"]!
            .AsArray()
            .Single(row => row!["name"]!.GetValue<string>() == "query")!;
        Assert.Equal(
            "https://mcp.example.com:8443/v1/mcp?apikey=REDACTED&mode=REDACTED&REDACTED",
            query["url"]!.GetValue<string>()
        );
        Assert.Equal("X-Api-Key", query["headerKeys"]![0]!.GetValue<string>());
        Assert.True(query["hasToken"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Error_redaction_covers_URL_query_user_info_and_fragment()
    {
        using var temp = new TempDirectory();
        await using (var mcp = new McpClient(temp.Path))
            await mcp.ConfigureAsync(
                new JsonObject
                {
                    ["name"] = "query",
                    ["url"] =
                        "https://user:url-password@mcp.example.com/mcp?apikey=url%2Dsecret&bare-secret#frag-secret",
                },
                default
            );
        var configuration = new McpConfiguration(temp.Path);
        foreach (
            var leaked in new[]
            {
                "GET https://mcp.example.com/mcp?apikey=url%2Dsecret failed",
                "invalid apikey url-secret",
                "bad item bare-secret",
                "user:url-password rejected",
                "anchor frag-secret",
            }
        )
            Assert.Equal(
                "MCP operation failed because the underlying error contained configured secret data.",
                configuration.Redact(leaked)
            );
        Assert.Equal(
            "connect to mcp.example.com failed",
            configuration.Redact("connect to mcp.example.com failed")
        );
    }
}
