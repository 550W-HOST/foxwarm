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
    public async Task Outbound_MCP_error_redacts_password_from_URL_userinfo()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var fixture = await OutboundMcpFixture.CreateAsync();
        var url = new UriBuilder(peer.Url + "/mcp")
        {
            UserName = "test-user",
            Password = "test-password",
        }.Uri.ToString();
        await fixture.ConfigureAsync(url);
        var result = await fixture.CallAsync(
            fixture.First,
            "fail",
            new JsonObject { ["errorMessage"] = "authentication failed: test-password" }
        );
        var text = result!.ToJsonString();
        Assert.DoesNotContain("test-password", text);
        Assert.Contains("configured secret data", text);
    }

    [Fact]
    public async Task Alternate_percent_escape_casing_is_redacted_through_outbound_MCP()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var fixture = await OutboundMcpFixture.CreateAsync();
        var url = peer.Url.Replace("http://", "http://specificuser:sec%2Fret@") + "/mcp";
        await fixture.ConfigureAsync(url);
        var result = await fixture.CallAsync(
            fixture.First,
            "fail",
            new JsonObject { ["errorMessage"] = "password: sec%2fret" }
        );
        var text = result!.ToJsonString();
        Assert.DoesNotContain("sec%2fret", text);
        Assert.Contains("configured secret data", text);
    }

    [Fact]
    public async Task Error_redaction_distinguishes_username_from_username_only_credential()
    {
        using var temp = new TempDirectory();
        await using var client = new McpClient(temp.Path);
        await client.ConfigureAsync(
            new JsonObject { ["name"] = "remote", ["url"] = "https://a:sec%2Fret@example.test/mcp" },
            default
        );
        var config = new McpConfiguration(temp.Path);
        Assert.Equal("remote failed", config.Redact("remote failed"));
        foreach (var error in new[] { "a:sec%2Fret", "sec%2fret", "sec/ret" })
            Assert.Contains("configured secret data", config.Redact(error));
        await client.ConfigureAsync(
            new JsonObject { ["name"] = "token", ["url"] = "https://token%2Fvalue@example.test/mcp" },
            default
        );
        await client.ConfigureAsync(
            new JsonObject { ["name"] = "empty-password", ["url"] = "https://empty-token:@example.test/mcp" },
            default
        );
        var updated = new McpConfiguration(temp.Path);
        foreach (var error in new[] { "token%2Fvalue", "token%2fvalue", "token/value", "empty-token" })
            Assert.Contains("configured secret data", updated.Redact(error));
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
                        "https://user%2Dname:url%2Dpassword@mcp.example.com/mcp?apikey=url%2Dsecret&bare-secret#frag-secret",
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
                "user%2Dname:url%2Dpassword rejected",
                "user-name:url-password rejected",
                "invalid password url%2Dpassword",
                "invalid password url-password",
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
