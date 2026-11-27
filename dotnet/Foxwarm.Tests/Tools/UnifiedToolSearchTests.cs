using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// `tool search` rendering for tools called through `tool call`: Node tools on master stand in
// for every such source, since they share the formatter with MCP tools.
public sealed class UnifiedToolSearchTests
{
    private const string Prefix = "discovery_fixture_";
    private static readonly string Description =
        "First sentence of the fixture tool. More " + new string('x', 300) + " tool tail 雪\n*/\u202e";
    private static readonly string ParameterDescription =
        new string('y', 300) + " parameter tail 🦊\t*/\u0001";
    private static readonly string DisplayParameterDescription =
        new string('y', 300) + " parameter tail 🦊\\u0009*\\/\\u0001";

    private static JsonObject Definition(string name, string description) =>
        new()
        {
            ["type"] = "function",
            ["name"] = name,
            ["description"] = description,
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
        };

    // Master Node tools, listed by tool ID as node:master/<name>.
    private static void RegisterNode(ToolRegistry registry, int count, string? description = null)
    {
        for (var index = 0; index < count; index++)
            registry.RegisterBrowser(
                Definition(Prefix + index.ToString("D2"), description ?? Description),
                () => true
            );
    }

    private static async Task<(ToolRegistry Registry, IAsyncDisposable Mcp, TempDirectory Temp)> Registry()
    {
        var temp = new TempDirectory();
        var mcp = new Foxwarm.McpClient(temp.Path);
        return (new ToolRegistry(mcp, _ => temp.Path), mcp, temp);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Tools_show_id_and_summary_and_schemas_only_when_asked(bool? includeSchema)
    {
        var (registry, mcp, temp) = await Registry();
        using var _ = temp;
        await using var __ = mcp;
        RegisterNode(registry, 12);
        var args = new JsonObject { ["sources"] = new JsonArray("node"), ["limit"] = 12 };
        if (includeSchema.HasValue)
            args["includeSchema"] = includeSchema.Value;
        var output = (await UnifiedTools.SearchAsync(registry, args, default))["output"]!.GetValue<string>();
        Assert.StartsWith("Showing 12 of 12 match(es).", output);
        var lines = output.Split('\n').Where(line => line.StartsWith("node:master/" + Prefix)).ToArray();
        Assert.Equal(12, lines.Length);
        Assert.All(lines, line => Assert.EndsWith(" — First sentence of the fixture tool.", line));
        // Schemas are opt-in for text and capped at the first ten results.
        var schemaLines = output.Split('\n').Where(line => line.StartsWith("    args: ")).ToArray();
        Assert.Equal(includeSchema == true ? 10 : 0, schemaLines.Length);
        Assert.All(schemaLines, line => Assert.Contains(DisplayParameterDescription, line));
        Assert.Contains("`tool call <tool-id> --args @args`", output);
        Assert.Contains("`tool call <tool-id> --help`", output);
        Assert.DoesNotContain("declared", output);
        Assert.DoesNotContain("--help to a command", output);

        // Programs keep the complete description and, unless they opt out, the schemas.
        var native = await UnifiedTools.SearchAsync(registry, args, default, budget: new ToolScriptDataBudget());
        var rows = native["tools"]!.AsArray();
        Assert.Null(native["output"]);
        Assert.Equal(12, rows.Count);
        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index]!.AsObject();
            Assert.Equal("node:master/" + Prefix + index.ToString("D2"), row["toolId"]!.GetValue<string>());
            Assert.Equal("tool", row["kind"]!.GetValue<string>());
            Assert.Equal("First sentence of the fixture tool.", row["summary"]!.GetValue<string>());
            Assert.Equal(Description, row["description"]!.GetValue<string>());
            Assert.Equal("master", row["nodeId"]!.GetValue<string>());
            Assert.Equal(includeSchema != false && index < 10, row.ContainsKey("inputSchema"));
        }
    }

    [Fact]
    public async Task Summaries_are_one_escaped_bounded_line_and_the_aggregate_budget_holds()
    {
        Assert.Equal("Copy a file.", UnifiedTools.Summary("Copy a file. Use e.g. paths."));
        Assert.Equal("Uses e.g. paths and more.", UnifiedTools.Summary("Uses e.g. paths and more.\nSecond line."));
        Assert.Equal("Line one", UnifiedTools.Summary("  Line one\r\nLine two"));
        Assert.Equal("Direction \\u202e text", UnifiedTools.Summary("Direction \u202e  text"));
        Assert.Equal(200, UnifiedTools.Summary(new string('z', 500)).EnumerateRunes().Count());
        Assert.EndsWith("…", UnifiedTools.Summary(new string('z', 500)));

        var (registry, mcp, temp) = await Registry();
        using var _ = temp;
        await using var __ = mcp;
        RegisterNode(registry, 120, new string('w', 5000));
        var args = new JsonObject
        {
            ["sources"] = new JsonArray("node"),
            ["limit"] = 200,
            ["includeSchema"] = true,
        };
        var output = (await UnifiedTools.SearchAsync(registry, args, default))["output"]!.GetValue<string>();
        Assert.Contains("more result(s) did not fit in the output.", output);
        Assert.True(output.Length <= 32_000, output.Length.ToString());
        Assert.Equal(
            120,
            (await UnifiedTools.SearchAsync(registry, args, default, budget: new ToolScriptDataBudget()))["tools"]!.AsArray().Count
        );
    }

    // Whole words only, names above descriptions, more matched words first.
    [Fact]
    public void Matching_uses_whole_words_and_weights_names()
    {
        Assert.Equal(-1, UnifiedTools.Score("exa", ["add_secret"], ["Store a value exactly as given."]));
        Assert.True(UnifiedTools.Score("exa", ["web_search_exa"], [""]) > 0);
        Assert.Equal(-1, UnifiedTools.Score("sec", ["add_secret"], [""]));
        // Names split on _, -, /, . and camelCase; a plural s matches its singular.
        foreach (var spelling in new[] { "copy_file", "copy-file", "copy/file", "copy.file", "copyFile", "CopyFiles" })
            Assert.True(UnifiedTools.Score("copy file", [spelling], [""]) >= 650, spelling);
        Assert.True(UnifiedTools.Score("COPY", ["copy_file"], [""]) > 0);
        var name = UnifiedTools.Score("copy", ["copy_file"], [""]);
        var description = UnifiedTools.Score("copy", ["move_file"], ["Copy it first."]);
        Assert.True(name > description);
        var two = UnifiedTools.Score("copy file nodes", ["move"], ["Copy a file between Nodes."]);
        var one = UnifiedTools.Score("copy file nodes", ["move"], ["Copy a value."]);
        Assert.True(two > one);
        Assert.Equal(0, UnifiedTools.Score("", ["anything"], [""]));
        Assert.Equal(0, UnifiedTools.Score("  ", ["anything"], [""]));
    }

    [Fact]
    public async Task Declared_tools_are_one_line_and_programs_keep_their_schema()
    {
        var (registry, mcp, temp) = await Registry();
        using var _ = temp;
        await using var __ = mcp;
        var definition = AgentToolDefinitions
            .Definitions()
            .OfType<JsonObject>()
            .Single(item => item["name"]!.GetValue<string>() == "create_child_session");
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
            ["includeSchema"] = true,
        };
        var output = (await UnifiedTools.SearchAsync(registry, args, default))["output"]!.GetValue<string>();
        var lines = output.Split('\n');
        Assert.Equal("Showing 1 of 1 match(es).", lines[0]);
        Assert.Equal(
            "create_child_session (declared tool) — " + UnifiedTools.Summary(definition["description"]!.GetValue<string>()),
            lines[2]
        );
        Assert.Contains("Call declared tools directly, not through ctl.", output);
        Assert.DoesNotContain("builtin:", output);
        Assert.DoesNotContain("args:", output);
        Assert.DoesNotContain("tool call", output);
        var native = await UnifiedTools.SearchAsync(registry, args, default, budget: new ToolScriptDataBudget());
        var row = native["tools"]![0]!;
        Assert.Equal("declared", row["kind"]!.GetValue<string>());
        Assert.Equal("builtin:create_child_session", row["toolId"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(definition["parameters"], row["inputSchema"]));
    }

    [Fact]
    public async Task Ordinary_and_native_calls_filter_by_policy_and_schemas_follow_the_flag()
    {
        await using var f = await ScriptFixture.Create();
        RegisterNode(f.Registry, 2);
        var args = new JsonObject { ["query"] = "discovery fixture", ["sources"] = new JsonArray("node") };
        var output = (await f.Call("ctl", CtlTestArgs.Search(args)))["output"]!.GetValue<string>();
        Assert.StartsWith("Showing 2 of 2 match(es).", output);
        Assert.DoesNotContain(DisplayParameterDescription, output);
        args["includeSchema"] = true;
        Assert.Contains(DisplayParameterDescription, (await f.Call("ctl", CtlTestArgs.Search(args)))["output"]!.GetValue<string>());
        args.Remove("includeSchema");

        var native = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "base = 'tool search --source node discovery fixture'\n"
                    + "default = call_tool('ctl', {'command': base})['tools']\n"
                    + "disabled = call_tool('ctl', {'command': base + ' --no-schema'})['tools']\n"
                    + "enabled = call_tool('ctl', {'command': base + ' --schema'})['tools']\n"
                    + "return {'default': default, 'disabled': disabled, 'enabled': enabled}\n",
            }
        );
        Assert.True(native["error"] is null, native.ToJsonString());
        var result = native["result"]!.AsObject();
        foreach (var key in new[] { "default", "disabled", "enabled" })
        {
            var rows = result[key]!.AsArray();
            Assert.Equal(2, rows.Count);
            Assert.All(rows, row => Assert.Equal(key != "disabled", row!.AsObject().ContainsKey("inputSchema")));
            Assert.Equal(Description, rows[1]!["description"]!.GetValue<string>());
        }

        await f.Manager.Authorization.InstallAsync(
            System.Text.Encoding.UTF8.GetBytes(
                "version: 1\nrules:\n- id: denied\n  action: deny\n  match: {tool: {source: node, name: discovery_fixture_01}}\n"
            ),
            default
        );
        var filtered = await f.Call("ctl", CtlTestArgs.Search(args));
        Assert.Contains(Prefix + "00", filtered["output"]!.GetValue<string>());
        Assert.DoesNotContain(Prefix + "01", filtered["output"]!.GetValue<string>());
        var nativeFiltered = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('ctl', {'command': 'tool search --source node discovery fixture'})['tools']",
            }
        );
        Assert.True(nativeFiltered["error"] is null, nativeFiltered.ToJsonString());
        Assert.Single(nativeFiltered["result"]!.AsArray());
        // `tool call <tool-id> --help` follows the same visibility.
        var hidden = await f.Call("ctl", new JsonObject { ["command"] = "tool call node:master/" + Prefix + "01 --help" });
        Assert.NotNull(hidden.FailureMessage());
    }

    [Fact]
    public async Task Tool_call_help_shows_a_tools_description_and_arguments()
    {
        await using var f = await ScriptFixture.Create();
        RegisterNode(f.Registry, 1);
        var help = await f.Call("ctl", new JsonObject { ["command"] = "tool call node:master/" + Prefix + "00 --help" });
        var text = help["output"]!.GetValue<string>();
        Assert.StartsWith("Tool: node:master/" + Prefix + "00\n", text);
        Assert.Contains("tool tail 雪\n*/\\u202e", text);
        // Help text is not inside a comment, so only control and direction characters are escaped.
        Assert.Contains("  value: string (required)\n      " + new string('y', 300) + " parameter tail 🦊\\u0009*/\\u0001\n", text);
        Assert.Equal(
            text,
            (await f.Call("ctl", new JsonObject { ["command"] = "tool call --source node --name " + Prefix + "00 --help" }))["output"]!.GetValue<string>()
        );
        var unknown = await f.Call("ctl", new JsonObject { ["command"] = "tool call node:master/missing --help" });
        Assert.NotNull(unknown.FailureMessage());
        // A declared Node tool on the current Node is called directly.
        var declared = await f.Call("ctl", new JsonObject { ["command"] = "tool call node:master/exec --help" });
        Assert.Contains("exec is a declared tool", declared["output"]!.GetValue<string>());
        // Without a tool, --help is the command's own help.
        Assert.StartsWith("Usage: tool call", (await f.Call("ctl", new JsonObject { ["command"] = "tool call --help" }))["output"]!.GetValue<string>());

        // Programs also receive the tool's structured description.
        var native = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] = "return ctl('tool call node:master/" + Prefix + "00 --help')",
            }
        );
        Assert.True(native["error"] is null, native.ToJsonString());
        var tool = native["result"]!["tool"]!;
        Assert.Equal("node:master/" + Prefix + "00", tool["toolId"]!.GetValue<string>());
        Assert.Equal(Description, tool["description"]!.GetValue<string>());
        Assert.Equal("value", tool["inputSchema"]!["required"]![0]!.GetValue<string>());
        Assert.Equal(text, native["result"]!["output"]!.GetValue<string>());
    }
}
