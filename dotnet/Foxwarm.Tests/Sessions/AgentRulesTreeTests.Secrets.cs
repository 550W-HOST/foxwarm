using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    // Rules that let an Agent edit configuration but end in a selector-free deny, so exec on
    // master is denied: the shape of the shipped restricted templates plus configuration tools.
    private const string ConfigurationEditorRules = """
        [
          {"tool":{"source":"builtin","name":["set_config","mcp_config"]},"action":"allow"},
          {"tool":{"source":"node","name":"read"},"action":"allow"},
          {"action":"deny"}
        ]
        """;

    private const string ProviderModels = """
        default: local/wire
        providers:
          local:
            providerType: openai-responses
            baseUrl: 'http://127.0.0.1:1/v1/'
            apiKey: '${secret:provider-key}'
            models: [wire]
        """;

    // Agent tools plus the configuration and explanation tools.
    private static async Task<ExternalChannelFixture> ConfigurationFixture()
    {
        var f = await Fixture();
        var definitions = WorkspaceTools.Definitions();
        foreach (
            var item in AgentToolDefinitions
                .Definitions()
                .Concat(UnifiedToolDefinitions.All().OfType<JsonObject>())
                .Concat(MainLocalToolDefinitions.Definitions().OfType<JsonObject>())
        )
            definitions.Add(
                HandoffConfirmation.Definition(item, f.Manager.HandoffConfirmationEnabled)
            );
        definitions.Add(ToolAuthorizationToolDefinition.Definition());
        definitions.Add(ToolAuthorizationToolDefinition.ExplainDefinition());
        foreach (var item in SecretToolDefinitions.Definitions())
            definitions.Add(item?.DeepClone());
        definitions.Add(AskUserToolDefinitions.Definition());
        foreach (var item in LocalExecManager.Definitions())
            definitions.Add(item?.DeepClone());
        f.Registry = SessionToolExecutor.CreateRegistry(
            definitions,
            f.Manager.OutboundMcp,
            owner => f.Manager.IdentityWorkspace(owner).ToolDirectory,
            f.Manager.Nodes,
            f.Manager.NodeProviders
        );
        return f;
    }

    [Fact]
    public async Task Configuration_changes_that_send_stored_secrets_follow_each_Agent_policy()
    {
        await using var f = await ConfigurationFixture();
        f.Configuration.Secrets.Store.Set("provider-key", "synthetic-provider-secret-0101");
        await f.Configuration.SaveAsync(new JsonObject { ["yaml"] = ProviderModels });
        var restricted = await ChildAgent(f, "editor", rules: Rules(ConfigurationEditorRules));
        var granted = Rules(ConfigurationEditorRules);
        granted.Insert(0, Obj("""{"secrets":{"anyOf":["provider-*"]},"action":"allow"}"""));
        var trusted = await ChildAgent(f, "trusted-editor", rules: granted);

        async Task<JsonNode?> SetModels(SessionOwner owner, string yaml)
        {
            var path = Path.Combine(
                f.Manager.IdentityWorkspace(owner).ToolDirectory,
                "models.yaml"
            );
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, yaml);
            return await f.ToolAsync(
                "set_config",
                new JsonObject { ["target"] = "models", ["filePath"] = path },
                owner
            );
        }
        Task<JsonNode?> Mcp(SessionOwner owner, string args) =>
            f.ToolAsync("mcp_config", Obj(args), owner);
        void SecretsDenied(JsonNode? result)
        {
            Assert.Equal("tool_authorization_denied", SessionWait.Text(result?["error"]?["type"]));
            Assert.Contains("`provider-key`", SessionWait.Text(result?["error"]?["message"]));
        }
        string Installed() => File.ReadAllText(f.Configuration.ActivePath);

        var redirected = ProviderModels.Replace(
            "127.0.0.1:1",
            "127.0.0.1:2",
            StringComparison.Ordinal
        );
        var moreModels = ProviderModels.Replace(
            "[wire]",
            "[wire, other]",
            StringComparison.Ordinal
        );

        // A restricted Agent may edit a secret-using provider in ways that send it nowhere new.
        var before = Installed();
        SecretsDenied(await SetModels(restricted, redirected));
        Assert.Equal(before, Installed());
        Successful(await SetModels(restricted, moreModels));
        Assert.Contains("other", Installed());
        // A secrets rule grants the named secrets; an unrestricted Agent needs no rule.
        Successful(await SetModels(trusted, redirected));
        Assert.Contains("127.0.0.1:2", Installed());
        Successful(await SetModels(f.Owner, moreModels));

        const string added = """
            {"name":"remote","url":"http://127.0.0.1:1/mcp","token":"${secret:provider-key}","enable":false}
            """;
        SecretsDenied(await Mcp(restricted, added));
        Successful(await Mcp(f.Owner, added));
        Successful(await Mcp(restricted, """{"name":"remote","description":"Synthetic server"}"""));
        SecretsDenied(
            await Mcp(restricted, """{"name":"remote","url":"http://127.0.0.1:2/mcp"}""")
        );
        Successful(await Mcp(trusted, """{"name":"remote","url":"http://127.0.0.1:2/mcp"}"""));
        Successful(
            await Mcp(
                restricted,
                """{"name":"plain","url":"http://127.0.0.1:3/mcp","enable":false}"""
            )
        );

        // explain_tool_authorization shows the facts and how each layer decided them.
        var probe = Path.Combine(
            f.Manager.IdentityWorkspace(restricted).ToolDirectory,
            "models.yaml"
        );
        // The unrestricted Agent restored the original base URL above.
        await File.WriteAllTextAsync(probe, redirected);
        var explainResult = await f.ToolAsync(
            "explain_tool_authorization",
            new JsonObject
            {
                ["probes"] = new JsonArray(
                    new JsonObject
                    {
                        ["sessionId"] = restricted.Id,
                        ["source"] = "builtin",
                        ["name"] = "set_config",
                        ["args"] = new JsonObject { ["target"] = "models", ["filePath"] = probe },
                    },
                    new JsonObject
                    {
                        ["sessionId"] = restricted.Id,
                        ["source"] = "builtin",
                        ["name"] = "mcp_config",
                        ["args"] = new JsonObject { ["name"] = "remote", ["timeoutSeconds"] = 30 },
                    }
                ),
            }
        );
        Assert.True(explainResult?["output"] is not null, explainResult?.ToJsonString());
        var explained = JsonNode.Parse(SessionWait.Text(explainResult!["output"])!)!;
        var active = explained["probes"]![0]!["active"]!;
        Assert.Equal("deny", SessionWait.Text(active["decision"]));
        Assert.Equal("""["provider-key"]""", active["facts"]!["secrets"]!.ToJsonString());
        var local = active["layers"]!
            .AsArray()
            .Single(layer => SessionWait.Text(layer!["layer"]) == "agent:editor")!;
        Assert.Equal("allow", SessionWait.Text(local["rule"]!["action"]));
        Assert.Equal("deny", SessionWait.Text(local["secrets"]!["decision"]));
        Assert.Equal(
            "deny",
            SessionWait.Text(local["secrets"]!["unrestrictedMasterExec"]!["decision"])
        );
        var global = active["layers"]!
            .AsArray()
            .Single(layer => SessionWait.Text(layer!["layer"]) == "global")!;
        Assert.Equal("allow", SessionWait.Text(global["secrets"]!["decision"]));
        var timeout = explained["probes"]![1]!["active"]!;
        Assert.Equal("allow", SessionWait.Text(timeout["decision"]));
        Assert.Null(timeout["facts"]!["secrets"]);
    }
}
