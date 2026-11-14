using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class UnifiedToolSearchTests
{
    private const string Prefix = "discovery_fixture_";
    private static readonly string Description = new string('x', 300) + " tool tail 雪\n*/\u202e";
    private static readonly string ParameterDescription =
        new string('y', 300) + " parameter tail 🦊\t*/\u0001";
    private static readonly string DisplayDescription =
        new string('x', 300) + " tool tail 雪\\u000a*\\/\\u202e";
    private static readonly string DisplayParameterDescription =
        new string('y', 300) + " parameter tail 🦊\\u0009*\\/\\u0001";

    private static void Register(ToolRegistry registry, int count, string? description = null)
    {
        for (var index = 0; index < count; index++)
            registry.Register(
                new JsonObject
                {
                    ["name"] = Prefix + index.ToString("D2"),
                    ["description"] = description ?? Description,
                    ["parameters"] = new JsonObject
                    {
                        ["type"] = "object",
                        ["properties"] = new JsonObject
                        {
                            ["value"] = new JsonObject
                            {
                                ["type"] = "string",
                                ["description"] = ParameterDescription,
                            },
                        },
                        ["required"] = new JsonArray("value"),
                        ["additionalProperties"] = false,
                    },
                },
                "builtin",
                index == 0,
                (_, args, _) =>
                    Task.FromResult(new JsonObject { ["output"] = args["value"]!.DeepClone() })
            );
    }

    [Theory]
    [InlineData(null)]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Complete_escaped_descriptions_preserve_schema_defaults_overrides_and_first_ten_cap(
        bool? includeSchema
    )
    {
        using var temp = new TempDirectory();
        await using var mcp = new Foxwarm.McpClient(temp.Path);
        var registry = new ToolRegistry(mcp, _ => temp.Path);
        Register(registry, 12);
        var args = new JsonObject { ["sources"] = new JsonArray("builtin"), ["limit"] = 12 };
        if (includeSchema.HasValue)
            args["includeSchema"] = includeSchema.Value;
        var ordinary = await UnifiedTools.SearchAsync(registry, args, default);
        var output = ordinary["output"]!.GetValue<string>();
        Assert.Contains("Found 12 tool(s); 12 total match(es).", output);
        Assert.DoesNotContain("[hidden]", output);
        var declarations = output
            .Split('\n')
            .Where(line => line.StartsWith("call_tool("))
            .ToArray();
        Assert.Equal(12, declarations.Length);
        var native = await UnifiedTools.SearchAsync(
            registry,
            args,
            default,
            budget: new ToolScriptDataBudget()
        );
        var rows = native["tools"]!.AsArray();
        Assert.Equal(12, rows.Count);
        for (var index = 0; index < rows.Count; index++)
        {
            var schemaIncluded = includeSchema != false && index < 10;
            Assert.Contains(DisplayDescription, declarations[index]);
            Assert.Equal(schemaIncluded, declarations[index].Contains(DisplayParameterDescription));
            Assert.Equal(!schemaIncluded, declarations[index].Contains("schema omitted"));
            Assert.Equal(Description, rows[index]!["description"]!.GetValue<string>());
            Assert.Equal(index != 0, rows[index]!["hidden"]!.GetValue<bool>());
            Assert.Equal(schemaIncluded, rows[index]!.AsObject().ContainsKey("inputSchema"));
            if (schemaIncluded)
                Assert.Equal(
                    ParameterDescription,
                    rows[index]!["inputSchema"]!["properties"]!["value"]![
                        "description"
                    ]!.GetValue<string>()
                );
        }
        Assert.Single(registry.ModelDefinitions());
        Assert.Equal(Prefix + "00", registry.ModelDefinitions()[0]!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task Handoff_confirmation_creation_lookup_keeps_identity_and_complete_descriptions()
    {
        using var temp = new TempDirectory();
        await using var mcp = new Foxwarm.McpClient(temp.Path);
        var registry = new ToolRegistry(mcp, _ => temp.Path);
        var definition = HandoffConfirmation.Definition(
            AgentToolDefinitions
                .Definitions()
                .OfType<JsonObject>()
                .Single(item => item["name"]!.GetValue<string>() == "create_child_session"),
            true
        );
        registry.Register(
            definition,
            "builtin",
            true,
            (_, _, _) => throw new InvalidOperationException("Discovery must not invoke the tool.")
        );
        var args = new JsonObject
        {
            ["sources"] = new JsonArray("builtin"),
            ["query"] = "create_child_session",
            ["limit"] = 1,
        };
        var ordinary = await UnifiedTools.SearchAsync(registry, args, default);
        var output = ordinary["output"]!.GetValue<string>();
        Assert.Contains("Found 1 tool(s); 1 total match(es).", output);
        Assert.Contains("builtin:create_child_session", output);
        Assert.Contains(definition["description"]!.GetValue<string>(), output);
        foreach (var property in definition["parameters"]!["properties"]!.AsObject())
            if (property.Value?["description"] is JsonValue description)
                Assert.Contains(description.GetValue<string>().Replace("\n", "\\u000a"), output);
        Assert.Contains("handoffRecall: string", output);
        Assert.Contains("handoffConfirmation: string", output);
        var native = await UnifiedTools.SearchAsync(
            registry,
            args,
            default,
            budget: new ToolScriptDataBudget()
        );
        Assert.True(
            JsonNode.DeepEquals(definition["parameters"], native["tools"]![0]!["inputSchema"])
        );
    }

    [Fact]
    public async Task Long_individual_declarations_render_and_broad_searches_keep_the_aggregate_budget()
    {
        using var temp = new TempDirectory();
        await using var mcp = new Foxwarm.McpClient(temp.Path);
        var registry = new ToolRegistry(mcp, _ => temp.Path);
        var description = new string('z', 5000) + " complete tail";
        Register(registry, 12, description);
        var args = new JsonObject
        {
            ["sources"] = new JsonArray("builtin"),
            ["query"] = Prefix + "00",
            ["limit"] = 1,
        };
        var single = await UnifiedTools.SearchAsync(registry, args, default);
        Assert.Contains(
            "Found 1 tool(s); 1 total match(es).",
            single["output"]!.GetValue<string>()
        );
        Assert.Contains(description, single["output"]!.GetValue<string>());
        args.Remove("query");
        args["limit"] = 200;
        var broad = await UnifiedTools.SearchAsync(registry, args, default);
        var output = broad["output"]!.GetValue<string>();
        var declarations = output
            .Split('\n')
            .Where(line => line.StartsWith("call_tool("))
            .ToArray();
        Assert.InRange(declarations.Length, 1, 11);
        Assert.All(declarations, declaration => Assert.Contains(description, declaration));
        Assert.Contains("selected tool(s) omitted by declaration/output limits.", output);
        Assert.True(output.Length <= 32000);
        var native = await UnifiedTools.SearchAsync(
            registry,
            args,
            default,
            budget: new ToolScriptDataBudget()
        );
        Assert.Equal(12, native["tools"]!.AsArray().Count);
    }

    [Fact]
    public async Task Ordinary_and_real_native_calls_keep_default_schemas_visibility_and_hidden_invocation()
    {
        await using var f = await ScriptFixture.Create();
        Register(f.Registry, 2);
        var args = new JsonObject { ["query"] = Prefix, ["sources"] = new JsonArray("builtin") };
        var ordinary = await f.Call("search_tools", args);
        var output = ordinary["output"]!.GetValue<string>();
        Assert.Contains("Found 2 tool(s); 2 total match(es).", output);
        Assert.Contains(DisplayDescription, output);
        Assert.Contains(DisplayParameterDescription, output);
        Assert.DoesNotContain("[hidden]", output);
        args["includeSchema"] = false;
        var summary = await f.Call("search_tools", args);
        Assert.Contains(DisplayDescription, summary["output"]!.GetValue<string>());
        Assert.DoesNotContain(DisplayParameterDescription, summary["output"]!.GetValue<string>());
        Assert.Contains("schema omitted", summary["output"]!.GetValue<string>());

        var native = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "base = {'query': 'discovery_fixture_', 'sources': ['builtin']}\n"
                    + "default = call_tool('search_tools', base)['tools']\n"
                    + "disabled = call_tool('search_tools', dict(base, includeSchema=False))['tools']\n"
                    + "enabled = call_tool('search_tools', dict(base, includeSchema=True))['tools']\n"
                    + "effect = call_tool('builtin:discovery_fixture_01', {'value': 'called'})\n"
                    + "return {'default': default, 'disabled': disabled, 'enabled': enabled, 'effect': effect}\n",
            }
        );
        Assert.True(native["error"] is null, native.ToJsonString());
        Assert.Equal("completed", native["status"]!.GetValue<string>());
        var result = native["result"]!.AsObject();
        foreach (var key in new[] { "default", "disabled", "enabled" })
        {
            var rows = result[key]!.AsArray();
            Assert.Equal(2, rows.Count);
            Assert.All(
                rows,
                row => Assert.Equal(key != "disabled", row!.AsObject().ContainsKey("inputSchema"))
            );
            Assert.Equal(Description, rows[1]!["description"]!.GetValue<string>());
            Assert.True(rows[1]!["hidden"]!.GetValue<bool>());
        }
        Assert.Equal("called", result["effect"]!["output"]!.GetValue<string>());
        Assert.False(
            f.Registry.Entries.Single(entry =>
                entry.Definition["name"]!.GetValue<string>() == Prefix + "01"
            ).DefaultInject
        );

        await f.Manager.Authorization.InstallAsync(
            System.Text.Encoding.UTF8.GetBytes(
                "version: 1\nrules:\n- id: denied\n  action: deny\n  match: {tool: {source: builtin, name: discovery_fixture_01}}\n"
            ),
            default
        );
        var filtered = await f.Call("search_tools", args);
        Assert.DoesNotContain(Prefix + "01", filtered["output"]!.GetValue<string>());
        var nativeFiltered = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('search_tools', {'query': 'discovery_fixture_', 'sources': ['builtin']})['tools']",
            }
        );
        Assert.True(nativeFiltered["error"] is null, nativeFiltered.ToJsonString());
        Assert.Single(nativeFiltered["result"]!.AsArray());
        Assert.Equal(Prefix + "00", nativeFiltered["result"]![0]!["name"]!.GetValue<string>());
        var denied = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "builtin:" + Prefix + "01",
                ["args"] = new JsonObject { ["value"] = "denied" },
            }
        );
        Assert.Equal("tool_authorization_denied", denied["error"]!["type"]!.GetValue<string>());
    }
}
