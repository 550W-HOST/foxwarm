using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    // A restricted Agent that may manage secrets and read or edit files in its own directory.
    private const string SecretKeeperRules = """
        [
          {"tool":{"source":"builtin","name":["add_secret","list_secrets"]},"action":"allow"},
          {"tool":{"source":"node","name":["read","edit"]},"path":{"allWithin":"${agent.dir}"},"action":"allow"},
          {"action":"deny"}
        ]
        """;

    private const string ModelsWithPendingSecret = """
        default: local/wire
        providers:
          local:
            providerType: openai-responses
            baseUrl: 'http://127.0.0.1:1/v1/'
            apiKey: '${secret:provider-key}'
            models: [wire]
          pending:
            providerType: openai-responses
            baseUrl: 'http://127.0.0.1:2/v1/'
            apiKey: '${secret:pending-key}'
            models: [wire]
        """;

    private static JsonObject Output(JsonNode? result)
    {
        Successful(result);
        return result!.AsObject();
    }

    private static string? ErrorMessage(JsonNode? result) =>
        SessionWait.Text(result?["error"]?["message"]);

    [Fact]
    public async Task Agents_add_secrets_they_own_without_reading_them_back()
    {
        await using var f = await ConfigurationFixture();
        var store = f.Configuration.Secrets.Store;
        store.Set("provider-key", "synthetic-provider-secret-0101");
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = ProviderModels });
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = ModelsWithPendingSecret });
        var keeper = await ChildAgent(f, "keeper", rules: Rules(SecretKeeperRules));
        var keeperDirectory = f.Manager.IdentityWorkspace(keeper).ToolDirectory;
        var mainDirectory = f.Manager.IdentityWorkspace(f.Owner).ToolDirectory;
        Directory.CreateDirectory(keeperDirectory);
        Directory.CreateDirectory(mainDirectory);
        Task<JsonNode?> Add(SessionOwner owner, string args) =>
            f.ToolAsync("add_secret", Obj(args), owner);

        // A value given directly: stored, owned by the caller, and never echoed.
        const string AgentValue = "synthetic-agent-token-0202";
        var added = Output(
            await Add(
                keeper,
                $$"""{"name":"agent-token","description":"Synthetic token","value":"{{AgentValue}}"}"""
            )
        );
        Assert.DoesNotContain(AgentValue, added.ToJsonString());
        Assert.Equal("""{"kind":"agent","agent":"keeper"}""", added["owner"]!.ToJsonString());
        Assert.Equal("keeper", store.Owner("agent-token"));
        Assert.Equal(AgentValue, store.Resolve("agent-token"));
        Assert.Contains(
            f.Configuration.Secrets.Exposures.List(),
            exposure => exposure.Label == "agent-token" && exposure.LastSource == "tool-call"
        );

        // Existing names are never replaced, whoever owns them.
        foreach (var existing in new[] { "agent-token", "provider-key" })
        {
            var refused = await Add(
                keeper,
                $$"""{"name":"{{existing}}","value":"other-value-0303"}"""
            );
            Assert.Contains("already exists", ErrorMessage(refused));
        }
        Assert.Equal(AgentValue, store.Resolve("agent-token"));
        Assert.Equal("synthetic-provider-secret-0101", store.Resolve("provider-key"));
        foreach (
            var invalid in new[]
            {
                """{"name":"two-sources","value":"a-value-0404","filePath":"x"}""",
                """{"name":"no-source"}""",
                """{"name":"Bad Name","value":"a-value-0404"}""",
                """{"name":"delete-value","value":"a-value-0404","deleteFile":true}""",
            }
        )
            Denied(await Add(keeper, invalid));

        // Filling a name configuration already references sends it somewhere: that needs the
        // grant any other secret needs, which this Agent lacks and main has.
        var pending = await Add(
            keeper,
            """{"name":"pending-key","value":"synthetic-pending-0505"}"""
        );
        Assert.Equal("tool_authorization_denied", SessionWait.Text(pending?["error"]?["type"]));
        Assert.Contains("`pending-key`", ErrorMessage(pending));
        Assert.False(store.Contains("pending-key"));

        // A file on the caller's Node, read by the server and optionally deleted afterwards.
        var mainFile = Path.Combine(mainDirectory, "pending.txt");
        await File.WriteAllTextAsync(mainFile, "synthetic-pending-0505\n");
        var filled = Output(
            await Add(
                f.Owner,
                $$"""{"name":"pending-key","filePath":"{{mainFile}}","deleteFile":true}"""
            )
        );
        Assert.True(filled["fileDeleted"]!.GetValue<bool>());
        Assert.False(File.Exists(mainFile));
        Assert.Equal("synthetic-pending-0505", store.Resolve("pending-key"));
        Assert.Equal("main", store.Owner("pending-key"));

        // The restricted Agent may read only its own directory.
        await File.WriteAllTextAsync(mainFile, "synthetic-foreign-0606");
        Denied(await Add(keeper, $$"""{"name":"foreign-key","filePath":"{{mainFile}}"}"""));
        Assert.False(store.Contains("foreign-key"));
        var keeperFile = Path.Combine(keeperDirectory, "token.txt");
        await File.WriteAllTextAsync(keeperFile, "synthetic-file-token-0707\r\n");
        Successful(
            await Add(keeper, """{"name":"file-token","filePath":"token.txt","deleteFile":true}""")
        );
        Assert.False(File.Exists(keeperFile));
        Assert.Equal("synthetic-file-token-0707", store.Resolve("file-token"));
        await File.WriteAllTextAsync(keeperFile, "");
        Assert.Contains(
            "empty",
            ErrorMessage(await Add(keeper, """{"name":"empty-file","filePath":"token.txt"}"""))
        );
        await File.WriteAllBytesAsync(keeperFile, [0xff, 0xfe, 0x00]);
        Assert.Contains(
            "UTF-8",
            ErrorMessage(await Add(keeper, """{"name":"binary-file","filePath":"token.txt"}"""))
        );

        // list_secrets: names, owners, uses and what this caller may use; never values.
        var listed = Output(await f.ToolAsync("list_secrets", new JsonObject(), keeper));
        var text = listed.ToJsonString();
        foreach (
            var value in new[]
            {
                AgentValue,
                "synthetic-provider-secret-0101",
                "synthetic-pending-0505",
            }
        )
            Assert.DoesNotContain(value, text);
        JsonNode Entry(JsonObject list, string name) =>
            list["secrets"]!.AsArray().Single(item => SessionWait.Text(item!["name"]) == name)!;
        Assert.Equal(
            ["agent-token", "file-token", "pending-key", "provider-key"],
            listed["secrets"]!.AsArray().Select(item => SessionWait.Text(item!["name"]))
        );
        Assert.Equal("allow", SessionWait.Text(Entry(listed, "agent-token")["usable"]));
        Assert.Equal(
            "Synthetic token",
            SessionWait.Text(Entry(listed, "agent-token")["description"])
        );
        Assert.Equal("deny", SessionWait.Text(Entry(listed, "provider-key")["usable"]));
        Assert.Equal(
            """{"kind":"instance"}""",
            Entry(listed, "provider-key")["owner"]!.ToJsonString()
        );
        Assert.Equal(
            """[{"kind":"provider","id":"local"}]""",
            Entry(listed, "provider-key")["usages"]!.ToJsonString()
        );
        Assert.Equal("deny", SessionWait.Text(Entry(listed, "pending-key")["usable"]));
        var unrestricted = Output(await f.ToolAsync("list_secrets", new JsonObject(), f.Owner));
        Assert.All(
            unrestricted["secrets"]!.AsArray(),
            item => Assert.Equal("allow", SessionWait.Text(item!["usable"]))
        );

        // Explanations show which secret facts the caller owns and that they need no rule.
        await File.WriteAllTextAsync(
            Path.Combine(keeperDirectory, "models.yaml"),
            ModelsWithPendingSecret
                + "\n"
                + """
                  mine:
                    providerType: openai-responses
                    baseUrl: 'http://127.0.0.1:3/v1/'
                    apiKey: '${secret:agent-token}'
                    models: [wire]

                """
        );
        var explainResult = await f.ToolAsync(
            "explain_tool_authorization",
            new JsonObject
            {
                ["probes"] = new JsonArray(
                    new JsonObject
                    {
                        ["sessionId"] = keeper.Id,
                        ["source"] = "builtin",
                        ["name"] = "set_config",
                        ["args"] = new JsonObject
                        {
                            ["target"] = "models",
                            ["filePath"] = Path.Combine(keeperDirectory, "models.yaml"),
                        },
                    }
                ),
            }
        );
        var explained = JsonNode.Parse(SessionWait.Text(explainResult!.AsObject()["output"])!)!;
        var active = explained["probes"]![0]!["active"]!;
        Assert.Equal("""["agent-token"]""", active["facts"]!["secrets"]!.ToJsonString());
        Assert.Equal("""["agent-token"]""", active["facts"]!["ownedSecrets"]!.ToJsonString());
        var local = active["layers"]!
            .AsArray()
            .Single(layer => SessionWait.Text(layer!["layer"]) == "agent:keeper")!;
        Assert.Equal(
            """{"decision":"allow","rule":null,"owned":true}""",
            local["secrets"]!.ToJsonString()
        );

        // Deleting the Agent hands its secrets to the instance.
        await f.Manager.DeleteAgentAsync("keeper");
        Assert.Null(store.Owner("agent-token"));
        Assert.Null(store.Owner("file-token"));
        Assert.Equal("main", store.Owner("pending-key"));
    }

    [Fact]
    public async Task Configuration_literals_move_into_the_store_for_callers_who_could_read_them()
    {
        await using var f = await ConfigurationFixture();
        var store = f.Configuration.Secrets.Store;
        const string Literal = "synthetic-literal-credential-0808";
        var yaml = $$"""
            # Hand-written models file; comments and layout stay.
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: 'http://127.0.0.1:1/v1/'   # local test server
                apiKey: {{Literal}}
                models: [wire]
              copy:
                providerType: openai-responses
                baseUrl: 'http://127.0.0.1:1/v1/'
                apiKey: "{{Literal}}"
                models: [wire]
            """;
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = yaml });
        var installed = File.ReadAllText(f.Configuration.ActivePath);
        var keeper = await ChildAgent(f, "keeper", rules: Rules(SecretKeeperRules));
        const string Move = """
            {"name":"moved-key","description":"Moved","fromConfig":[
              {"target":"models","path":["providers","local","apiKey"]},
              {"target":"models","path":["providers","copy","apiKey"]}
            ]}
            """;

        // The keeper may not read the models file, so it may not file its value under a name.
        Denied(await f.ToolAsync("add_secret", Obj(Move), keeper));
        Assert.False(store.Contains("moved-key"));
        Assert.Equal(installed, File.ReadAllText(f.Configuration.ActivePath));

        var moved = Output(await f.ToolAsync("add_secret", Obj(Move), f.Owner));
        Assert.DoesNotContain(Literal, moved.ToJsonString());
        Assert.Equal(
            """["models:providers.local.apiKey","models:providers.copy.apiKey"]""",
            moved["moved"]!.ToJsonString()
        );
        Assert.Null(moved["notMoved"]);
        Assert.Equal(Literal, store.Resolve("moved-key"));
        // Moved values belong to the instance, not to the Agent that moved them.
        Assert.Null(store.Owner("moved-key"));
        var rewritten = File.ReadAllText(f.Configuration.ActivePath);
        Assert.DoesNotContain(Literal, rewritten);
        Assert.Equal(
            installed
                .Replace("\"" + Literal + "\"", "\"${secret:moved-key}\"", StringComparison.Ordinal)
                .Replace(Literal, "\"${secret:moved-key}\"", StringComparison.Ordinal),
            rewritten
        );

        // Fields that hold different values, or that already use a secret, are refused before
        // anything is stored.
        var again = await f.ToolAsync(
            "add_secret",
            Obj(
                """{"name":"second-key","fromConfig":[{"target":"models","path":["providers","local","apiKey"]}]}"""
            ),
            f.Owner
        );
        Assert.Contains("already uses a stored secret", ErrorMessage(again));
        Assert.False(store.Contains("second-key"));

        // MCP fields move through the MCP configuration, as a patch of the server.
        Successful(
            await f.ToolAsync(
                "mcp_config",
                Obj(
                    $$"""{"name":"remote","url":"http://127.0.0.1:1/mcp","headers":{"X-Key":"{{Literal}}-mcp","X-Mode":"plain"},"enable":false}"""
                ),
                f.Owner
            )
        );
        var mcpMoved = Output(
            await f.ToolAsync(
                "add_secret",
                Obj(
                    """{"name":"mcp-key","fromConfig":[{"target":"mcp","path":["remote","headers","X-Key"]}]}"""
                ),
                f.Owner
            )
        );
        Assert.Equal("""["mcp:remote.headers.X-Key"]""", mcpMoved["moved"]!.ToJsonString());
        Assert.Equal(Literal + "-mcp", store.Resolve("mcp-key"));
        var server = f.Manager.OutboundMcp.Configuration.Snapshot()["remote"]!;
        Assert.Equal(
            """{"X-Key":"${secret:mcp-key}","X-Mode":"plain"}""",
            server["headers"]!.ToJsonString()
        );
        Assert.DoesNotContain(
            Literal,
            File.ReadAllText(f.Manager.OutboundMcp.Configuration.FilePath)
        );
    }

    [Fact]
    public void Approvals_and_summaries_of_add_secret_never_show_the_value()
    {
        var resolved = new ResolvedTool(
            "add_secret",
            "builtin",
            "add_secret",
            Obj("""{"name":"agent-token","value":"synthetic-hidden-value-0909"}""")
        );
        var shown = SessionManager.ApprovalArgs(resolved);
        Assert.Equal("""{"name":"agent-token","value":"(hidden)"}""", shown.ToJsonString());
        Assert.Equal(
            "agent-token",
            SessionToolExecutor.ToolArgsPreview("add_secret", resolved.Args)
        );
        Assert.Equal("synthetic-hidden-value-0909", SessionWait.Text(resolved.Args["value"]));
    }
}
