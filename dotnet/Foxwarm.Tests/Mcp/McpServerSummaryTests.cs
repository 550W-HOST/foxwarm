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
                "invalid username user%2Dname",
                "invalid username user-name",
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
