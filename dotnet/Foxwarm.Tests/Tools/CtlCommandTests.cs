using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class CtlCommandTests
{
    private static JsonObject Args(string command, JsonObject? values = null)
    {
        var args = new JsonObject { ["command"] = command };
        if (values is not null)
            args["values"] = values;
        return args;
    }

    private static CtlTarget Target(string command, JsonObject? values = null) =>
        Assert.IsType<CtlTarget>(CtlParser.Parse(Args(command, values)));

    private static CtlError Error(string command, JsonObject? values = null) =>
        Assert.IsType<CtlError>(CtlParser.Parse(Args(command, values)));

    [Fact]
    public void Words_split_like_a_shell_without_expansion()
    {
        var target = Target(
            "ctl memory write 'notes/a b.md' \"say \\\"hi\\\" \\\\ $HOME\" "
        );
        Assert.Equal("builtin", target.Source);
        Assert.Equal("write_memory", target.Name);
        Assert.Equal("notes/a b.md", target.Args["filePath"]!.GetValue<string>());
        Assert.Equal("say \"hi\" \\ $HOME", target.Args["content"]!.GetValue<string>());
        Assert.Equal(
            "a;b|c",
            Target("memory read a\\;b'|'c").Args["filePath"]!.GetValue<string>()
        );
        foreach (var shell in new[] { "session list | head", "session list; ls", "session list &", "memory read <x", "memory read $(id)", "memory read `id`" })
            Assert.Contains("not a shell", Error(shell).Message);
        Assert.Contains("Unterminated", Error("memory read 'open").Message);
    }

    [Fact]
    public void Values_bind_only_whole_at_name_arguments_and_must_all_be_used()
    {
        var text = "line one\nline two";
        var bound = Target("memory write notes.md @body", new() { ["body"] = text });
        Assert.Equal(text, bound.Args["content"]!.GetValue<string>());
        Assert.Equal(
            "@literal",
            Target("memory read @@literal").Args["filePath"]!.GetValue<string>()
        );
        Assert.Equal(
            "x@y",
            Target("memory read x@y").Args["filePath"]!.GetValue<string>()
        );
        Assert.Contains("values.missing", Error("memory read @missing").Message);
        Assert.Contains("not a valid @name", Error("memory read @bad.name").Message);
        Assert.Contains(
            "Unused values: extra",
            Error("memory read a.md", new() { ["extra"] = 1 }).Message
        );
        var fromJson = CtlParser.Parse(
            new JsonObject
            {
                ["command"] = "memory write a.md --content=@body",
                ["valuesJson"] = "{\"body\":\"json text\"}",
            }
        );
        Assert.Equal(
            "json text",
            Assert.IsType<CtlTarget>(fromJson).Args["content"]!.GetValue<string>()
        );
        Assert.IsType<CtlError>(
            CtlParser.Parse(
                new JsonObject
                {
                    ["command"] = "memory read a.md",
                    ["values"] = new JsonObject(),
                    ["valuesJson"] = "{}",
                }
            )
        );
        // Bound values are checked against the parameter type, never coerced.
        Assert.Contains(
            "bound value is a number",
            Error("memory write a.md @body", new() { ["body"] = 3 }).Message
        );
    }

    [Fact]
    public void Options_accept_kebab_and_property_spellings_and_check_types()
    {
        var listed = Target("session list fox --count=5 --scope all --start 2");
        Assert.Equal("session", listed.Name);
        Assert.Equal("list", listed.Args["action"]!.GetValue<string>());
        Assert.Equal("fox", listed.Args["query"]!.GetValue<string>());
        Assert.Equal(5, listed.Args["count"]!.GetValue<long>());
        Assert.Equal(2, listed.Args["start"]!.GetValue<long>());
        var camel = Target("node copy --targetPath=c.txt master a.txt box --overwrite");
        Assert.Equal("c.txt", camel.Args["targetPath"]!.GetValue<string>());
        Assert.Equal("box", camel.Args["targetNode"]!.GetValue<string>());
        Assert.Contains("more than once", Error("node copy master a box b --target-path c").Message);
        var copy = Target("node copy master a.txt box --target-path b.txt --no-overwrite");
        Assert.Equal("b.txt", copy.Args["targetPath"]!.GetValue<string>());
        Assert.False(copy.Args["overwrite"]!.GetValue<bool>());
        Assert.True(
            Target("node copy master a box b --overwrite=true").Args["overwrite"]!.GetValue<bool>()
        );
        Assert.Contains("one of current-agent, all", Error("session list --scope everyone").Message);
        Assert.Contains("an integer", Error("session list --count many").Message);
        Assert.Contains("Unknown option `--bogus`", Error("session list --bogus 1").Message);
        Assert.Contains("Missing required argument <filePath>", Error("memory read").Message);
        Assert.Contains("Unexpected argument", Error("memory read a b").Message);
        var error = Error("session list --count many");
        Assert.Equal("session list", error.Command!.Path);
    }

    [Fact]
    public void Arrays_repeat_or_take_one_json_value_and_objects_take_json_or_values()
    {
        var search = Assert.IsType<CtlSearch>(
            CtlParser.Parse(Args("tool search browser open --source node --source mcp --limit 3"))
        );
        Assert.Equal("browser open", search.Args["query"]!.GetValue<string>());
        Assert.Equal(["node", "mcp"], search.Args["sources"]!.AsArray().Select(value => value!.GetValue<string>()));
        Assert.Equal(3, search.Args["limit"]!.GetValue<long>());
        var json = Assert.IsType<CtlSearch>(CtlParser.Parse(Args("tool search --source '[\"builtin\"]' --no-schema")));
        Assert.Equal("builtin", json.Args["sources"]![0]!.GetValue<string>());
        Assert.False(json.Args["includeSchema"]!.GetValue<bool>());
        var call = Assert.IsType<CtlCall>(
            CtlParser.Parse(Args("tool call node:box/read --args '{\"filePath\":\"x\"}'"))
        );
        Assert.Equal("node:box/read", call.Descriptor["toolId"]!.GetValue<string>());
        Assert.Equal("x", call.Descriptor["args"]!["filePath"]!.GetValue<string>());
        var bound = Assert.IsType<CtlCall>(
            CtlParser.Parse(
                Args(
                    "tool call --source mcp --server 'my server' --name probe --args @a",
                    new() { ["a"] = new JsonObject { ["n"] = 1 } }
                )
            )
        );
        Assert.Equal("my server", bound.Descriptor["server"]!.GetValue<string>());
        Assert.Equal(1, bound.Descriptor["args"]!["n"]!.GetValue<int>());
        Assert.Empty(Assert.IsType<CtlCall>(CtlParser.Parse(Args("tool call builtin:list_mcp_servers"))).Descriptor["args"]!.AsObject());
        Assert.Contains("JSON", Error("tool call builtin:x --args notjson").Message);
        Assert.Contains("toolId", Error("tool call").Message);
    }

    [Fact]
    public void Rest_text_is_taken_raw_after_options_and_binds_only_when_exactly_one_name()
    {
        var raw = Target("channel send webui:x it's done; really | ok");
        Assert.Equal("webui:x", raw.Args["channelTargetId"]!.GetValue<string>());
        Assert.Equal("it's done; really | ok", raw.Args["message"]!.GetValue<string>());
        Assert.Equal(
            "--not-a-flag",
            Target("channel send webui:x -- --not-a-flag").Args["message"]!.GetValue<string>()
        );
        Assert.Equal(
            "bound text",
            Target("channel send webui:x @m", new() { ["m"] = "bound text" }).Args["message"]!.GetValue<string>()
        );
        Assert.Equal(
            "@m hi",
            Target("channel send webui:x @@m hi").Args["message"]!.GetValue<string>()
        );
        Assert.Contains("Missing required", Error("channel send webui:x").Message);
    }

    [Fact]
    public void Help_forms_and_unknown_commands_resolve_to_help_or_usage()
    {
        Assert.Equal(new CtlHelpRequest(null, null), CtlParser.Parse(Args("")));
        Assert.Equal(new CtlHelpRequest(null, null), CtlParser.Parse(Args("help")));
        Assert.Equal(new CtlHelpRequest("session", null), CtlParser.Parse(Args("session")));
        Assert.Equal(new CtlHelpRequest("session", null), CtlParser.Parse(Args("session --help")));
        Assert.Equal(new CtlHelpRequest("session", "list"), CtlParser.Parse(Args("session list --help")));
        Assert.Equal(new CtlHelpRequest("session", "list"), CtlParser.Parse(Args("help session list")));
        var visibleAll = new Func<CtlCommand, bool>(_ => true);
        var unknown = Error("session lst");
        Assert.Contains("`session list`", CtlHelp.Error(unknown, visibleAll));
        Assert.Equal("session", unknown.Noun);
        Assert.Contains("Did you mean `session`", CtlHelp.Error(Error("sesion list"), visibleAll));
        // Suggestions come from the commands the caller may see.
        Assert.DoesNotContain(
            "session list",
            CtlHelp.Error(unknown, command => command.Path != "session list")
        );
        Assert.Contains("session list", CtlHelp.Render(new("session", null), visibleAll));
        Assert.Contains("--count <number>", CtlHelp.Render(new("session", "list"), visibleAll));
        Assert.Null(CtlHelp.Render(new("session", "missing"), visibleAll));
        Assert.All(
            CtlRegistry.Nouns,
            noun => Assert.True(CtlHelp.Render(new(noun.Name, null), visibleAll)!.Length < CtlHelp.MaxLength)
        );
    }

    [Fact]
    public void Quoting_only_an_option_value_keeps_the_option()
    {
        Assert.Equal(
            "hello world",
            Target("memory edit MEMORY.md --old-text=\"hello world\" --new-text=x").Args["oldText"]!.GetValue<string>()
        );
        var write = Target("memory write notes.md --content=\"hello world\"");
        Assert.Equal("hello world", write.Args["content"]!.GetValue<string>());
        Assert.Equal("notes.md", write.Args["filePath"]!.GetValue<string>());
        var call = Assert.IsType<CtlCall>(CtlParser.Parse(Args("tool call node:box/read --args='{\"filePath\":\"x y\"}'")));
        Assert.Equal("x y", call.Descriptor["args"]!["filePath"]!.GetValue<string>());
        // A quoted option name is ordinary text.
        Assert.Equal(
            "--content=x",
            Target("memory write notes.md \"--content=x\"").Args["content"]!.GetValue<string>()
        );
        Assert.Equal(
            "--content=x",
            Target("memory write notes.md --\"content=x\"").Args["content"]!.GetValue<string>()
        );
    }

    [Fact]
    public void Rest_follows_a_positional_given_as_an_option()
    {
        var sent = Target("channel send --channel-target-id webui:x @m", new() { ["m"] = "message" });
        Assert.Equal("webui:x", sent.Args["channelTargetId"]!.GetValue<string>());
        Assert.Equal("message", sent.Args["message"]!.GetValue<string>());
        Assert.Equal(
            "plain words",
            Target("channel send --channel-target-id webui:x plain words").Args["message"]!.GetValue<string>()
        );
    }

    [Fact]
    public void Model_options_build_the_target_model_objects()
    {
        var created = Target("session create main worker --model sonnet --effort high --force-effort max");
        Assert.True(
            JsonNode.DeepEquals(
                new JsonObject { ["modelId"] = "sonnet", ["effort"] = "high" },
                created.Args["model"]
            )
        );
        Assert.True(JsonNode.DeepEquals(new JsonObject { ["effort"] = "max" }, created.Args["forceModel"]));
        Assert.Contains("one of", Error("session create main worker --effort extreme").Message);
        Assert.Contains("an integer", Error("session list --count 2.5").Message);
    }

    // Selection intent is read from the command words, even when the call is invalid.
    [Theory]
    [InlineData("node select box", null, true)]
    [InlineData("node select box", "values-json", true)]
    [InlineData("node select box", "extra-key", true)]
    [InlineData("node select", null, true)]
    [InlineData("tool call builtin:node --args @a", "unused", true)]
    [InlineData("tool call builtin:node --args @a", "values-json", true)]
    [InlineData("tool call --source builtin --name node --args='{\"action\":\"select\"}' --bogus", null, true)]
    [InlineData("tool call builtin:node --args @list", "unused", false)]
    [InlineData("node list --bogus", null, false)]
    [InlineData("tool call node:box/node --args @a", "unused", false)]
    [InlineData("tool call mcp:srv/node --args @a", null, false)]
    public void Node_selection_intent_survives_invalid_calls(string command, string? damage, bool selects)
    {
        var args = Args(
            command,
            new()
            {
                ["a"] = new JsonObject { ["action"] = "select", ["nodeId"] = "box" },
                ["list"] = new JsonObject { ["action"] = "list" },
            }
        );
        if (!command.Contains('@'))
            args.Remove("values");
        else if (!command.Contains("@list"))
            args["values"]!.AsObject().Remove("list");
        else
            args["values"]!.AsObject().Remove("a");
        if (damage == "unused")
            args["values"]!["unused"] = 1;
        if (damage == "values-json")
        {
            args.Remove("values");
            args["valuesJson"] = "{";
        }
        if (damage == "extra-key")
            args["unexpected"] = true;
        Assert.Equal(selects, CtlParser.SelectsNode(args));
    }

    // Hints in tool output name commands from the registry and read back to the same call.
    [Fact]
    public async Task Command_hints_round_trip_through_the_parser()
    {
        var cases = new (string Builtin, JsonObject Args)[]
        {
            ("recall", new JsonObject { ["target"] = "msg#12" }),
            ("recall", new JsonObject { ["sessionId"] = "a/b", ["target"] = "msg#3", ["toolDetail"] = "full", ["previewLength"] = 20000 }),
            ("recall", new JsonObject { ["sessionId"] = "a/b", ["text_query"] = "it's a \"quote\" | here", ["beforeSeq"] = 40 }),
            ("view_session", new JsonObject { ["sessionId"] = "a/b", ["before"] = 10, ["count"] = 5, ["historyVersion"] = 3, ["parts"] = new JsonArray("text", "tools") }),
            ("image_crop", new JsonObject { ["id"] = "img_1", ["x"] = 0, ["y"] = 0, ["width"] = 100, ["height"] = 100 }),
            ("image_write_to_file", new JsonObject { ["id"] = "@img", ["filePath"] = "artifacts/my file.png" }),
            ("send_to_channel", new JsonObject { ["channelTargetId"] = "webui:x", ["message"] = "--starts like a flag" }),
            ("create_session", new JsonObject { ["agentName"] = "main", ["sessionName"] = "w", ["model"] = new JsonObject { ["modelId"] = "sonnet", ["effort"] = "low" } }),
        };
        foreach (var (builtin, expected) in cases)
        {
            var text = CtlCommandText.For(builtin, expected);
            Assert.StartsWith("ctl ", text);
            var parsed = Assert.IsType<CtlTarget>(CtlParser.Parse(Args(text)));
            Assert.Equal(builtin, parsed.Name);
            var canonical = (JsonObject)expected.DeepClone();
            foreach (var pair in parsed.Command.Fixed ?? [])
                canonical[pair.Key] = pair.Value?.DeepClone();
            Assert.True(JsonNode.DeepEquals(canonical, parsed.Args), text + " => " + parsed.Args.ToJsonString());
        }
        Assert.Equal("ctl history recall msg#12", CtlCommandText.For("recall", new JsonObject { ["target"] = "msg#12" }));
        // Hints can carry any argument of these builtins.
        await using var f = await ScriptFixture.Create();
        foreach (var builtin in new[] { "recall", "view_session", "image_crop", "image_write_to_file" })
        {
            var properties = f.Manager.ToolRegistry.Entries
                .Single(entry => entry.Definition["name"]!.GetValue<string>() == builtin)
                .Definition["parameters"]!["properties"]!.AsObject()
                .Select(pair => pair.Key);
            var command = CtlRegistry.ForTarget("builtin", builtin).Single();
            Assert.All(properties, property => Assert.Contains(command.Parameters, parameter => parameter.Arg == property));
        }
        Assert.Equal("ctl history recall", CtlCommandText.Prefix("recall"));
    }

    // The same corpus is checked by the WebUI display parser (packages/webui/test/ctlCall.test.mjs).
    [Fact]
    public void Conformance_corpus_matches_the_parser()
    {
        var corpus = JsonNode.Parse(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", "ctl-conformance.json"))
        )!;
        foreach (var item in corpus["cases"]!.AsArray())
        {
            var args = new JsonObject { ["command"] = item!["command"]!.DeepClone() };
            if (item["values"] is JsonObject values)
                args["values"] = values.DeepClone();
            JsonNode? actual = CtlParser.Parse(args) switch
            {
                CtlTarget target => new JsonObject
                {
                    ["toolId"] = target.Source + ":" + target.Name,
                    ["args"] = target.Args.DeepClone(),
                },
                CtlCall call => call.Descriptor.DeepClone(),
                _ => null,
            };
            Assert.True(
                JsonNode.DeepEquals(item["descriptor"], actual),
                item["command"] + " => " + actual?.ToJsonString()
            );
        }
    }

    [Fact]
    public void Ctl_calls_describe_their_canonical_target_for_display_and_batch_rules()
    {
        var described = CtlParser.Describe(Args("node select box"))!;
        Assert.Equal(("builtin", "node", "select"), (described.Source, described.Name, described.Args["action"]!.GetValue<string>()));
        var unified = CtlParser.Describe(Args("tool call mcp:srv/probe --args @a", new() { ["a"] = new JsonObject() }))!;
        Assert.Equal(("mcp", "probe", "srv"), (unified.Source, unified.Name, unified.Server));
        Assert.Null(CtlParser.Describe(Args("help")));
        Assert.Equal(("session", new JsonObject { ["action"] = "list" }.ToJsonString()), (ToolActivity.Target("ctl", Args("session list")).Name, ToolActivity.Target("ctl", Args("session list")).Args.ToJsonString()));
    }

    [Fact]
    public async Task Registry_commands_target_registered_builtins_with_their_declared_arguments()
    {
        await using var f = await ScriptFixture.Create();
        var registered = f
            .Manager.ToolRegistry.Entries.ToDictionary(
                entry => entry.Definition["name"]!.GetValue<string>(),
                StringComparer.Ordinal
            );
        foreach (var command in CtlRegistry.Commands.Where(command => command.Local is null))
        {
            Assert.True(registered.TryGetValue(command.Name!, out var entry), command.Path);
            Assert.Equal(entry!.Source, command.Source);
            var schema = entry.Definition["parameters"] as JsonObject ?? new JsonObject();
            var properties = schema["properties"] as JsonObject ?? new JsonObject();
            foreach (var parameter in command.Parameters)
            {
                // A dotted Arg names a field of an object argument.
                var path = parameter.Arg.Split('.');
                Assert.True(properties.ContainsKey(path[0]), command.Path + " " + parameter.Arg);
                if (path.Length > 1)
                    Assert.True(
                        (properties[path[0]]?["properties"] as JsonObject)?.ContainsKey(path[1]) == true,
                        command.Path + " " + parameter.Arg
                    );
            }
            foreach (var key in command.Fixed ?? [])
                Assert.True(properties.ContainsKey(key.Key), command.Path + " " + key.Key);
            foreach (var required in (schema["required"] as JsonArray ?? []).Select(value => value!.GetValue<string>()))
                Assert.True(
                    command.Fixed?.ContainsKey(required) == true
                        || command.Parameters.Any(parameter => parameter.Arg == required && parameter.Required),
                    command.Path + " leaves required " + required + " optional"
                );
        }
        // Every builtin outside the native default set has a specific command; the rest stay
        // reachable through `tool call`.
        var uncovered = registered
            .Values.Where(entry =>
                entry.Source == "builtin"
                && !entry.DefaultInject
                && !CtlRegistry.ForTarget("builtin", entry.Definition["name"]!.GetValue<string>()).Any()
            )
            .Select(entry => entry.Definition["name"]!.GetValue<string>())
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(["start_toolscript_run"], uncovered);
    }

    [Fact]
    public async Task Default_declarations_keep_the_native_set_and_one_ctl_declaration()
    {
        await using var f = await ScriptFixture.Create();
        var names = f
            .Manager.ModelDefinitions(f.Owner)
            .Select(definition => definition!["name"]!.GetValue<string>())
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] expected =
        [
            "ask_user",
            "continue_script",
            "create_child_session",
            "ctl",
            "edit",
            "exec",
            "read",
            "run_script",
            "send_to_session",
            "submit_compact_plan",
            "task",
            "wait",
            "write",
        ];
        Assert.Equal(
            expected.Where(name => Foxwarm.ToolScript.MontyWorker.IsSupported || name is not ("run_script" or "continue_script")).Where(name => LocalExecManager.IsSupported || name != "exec"),
            names
        );
        var ctl = f.Manager.ModelDefinitions(f.Owner).Single(definition => definition!["name"]!.GetValue<string>() == "ctl")!;
        Assert.Equal(["command"], ctl["parameters"]!["required"]!.AsArray().Select(value => value!.GetValue<string>()));
        Assert.Equal(
            ["command", "values", "valuesJson"],
            ctl["parameters"]!["properties"]!.AsObject().Select(pair => pair.Key)
        );
    }

    private static SessionToolExecutor Executor(ScriptFixture f)
    {
        var tools = new SessionToolExecutor(new WorkspaceTools(f.Work), f.Owner, f.Manager, f.Manager.ToolRegistry);
        tools.BeginTurn();
        return tools;
    }

    private static async Task<TurnToolExecution> Run(SessionToolExecutor tools, string name, JsonObject args) =>
        await tools.ExecuteAttributedAsync(
            new JsonObject { ["id"] = Guid.NewGuid().ToString("N"), ["name"] = name, ["args"] = args },
            default
        );

    [Fact]
    public async Task Commands_resolve_to_the_same_target_as_direct_calls_and_record_it()
    {
        await using var f = await ScriptFixture.Create();
        var tools = Executor(f);
        var direct = await Run(tools, "skill", new JsonObject { ["action"] = "list" });
        var command = await Run(tools, "ctl", Args("skill list"));
        Assert.Null((command.Response as JsonObject)?["error"]);
        Assert.Equal(direct.Response!.ToJsonString(), command.Response!.ToJsonString());
        Assert.Equal("builtin", SessionWait.Text(command.Target!["source"]));
        Assert.Equal("skill", SessionWait.Text(command.Target["name"]));
        Assert.Equal("ctl", SessionWait.Text(command.Target["invocationName"]));
        Assert.Equal("list", SessionWait.Text(command.Target["action"]));
        // The former model wrapper is gone; call_tool is only ToolScript's host function.
        var removed = await Run(tools, "call_tool", new JsonObject { ["toolId"] = "builtin:skill", ["args"] = new JsonObject { ["action"] = "list" } });
        Assert.Contains("Unknown tool: call_tool", removed.Response!.ToJsonString());
        var search = await Run(tools, "search_tools", new JsonObject());
        Assert.Contains("Unknown tool: search_tools", search.Response!.ToJsonString());
        var nested = await Run(tools, "ctl", Args("tool call builtin:ctl --args @a", new() { ["a"] = Args("help") }));
        Assert.Contains("not a concrete tool", nested.Response!.ToJsonString());
        var invalid = await Run(tools, "ctl", Args("session list --count many"));
        Assert.Equal("invalid_command", SessionWait.Text(invalid.Response!["error"]!["type"]));
        Assert.Contains("Usage: session list", SessionWait.Text(invalid.Response["error"]!["message"]));
    }

    [Fact]
    public async Task Help_and_discovery_follow_each_target_policy_and_targets_keep_their_checks()
    {
        await using var f = await ScriptFixture.Create();
        var tools = Executor(f);
        var help = SessionWait.Text((await Run(tools, "ctl", Args("help"))).Response!["output"])!;
        Assert.Contains("memory", help);
        Assert.Contains("timer", help);
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                """
                version: 1
                rules:
                - id: no-memory
                  action: deny
                  tool: {source: builtin, name: [read_memory, write_memory, edit_memory, delete_memory, apply_patch_memory]}
                - id: no-timer-create
                  action: deny
                  tool: {source: builtin, name: create_timer}
                - id: retired
                  action: allow
                  tool: {source: builtin, name: search_tools}
                """
            ),
            default
        );
        var filtered = SessionWait.Text((await Run(tools, "ctl", Args("help"))).Response!["output"])!;
        Assert.DoesNotContain("\n  memory", filtered);
        Assert.Contains("\n  timer", filtered);
        var timer = SessionWait.Text((await Run(tools, "ctl", Args("timer"))).Response!["output"])!;
        Assert.DoesNotContain("timer create", timer);
        Assert.Contains("timer list", timer);
        var hidden = await Run(tools, "ctl", Args("timer create --help"));
        Assert.Equal("invalid_command", SessionWait.Text(hidden.Response!["error"]!["type"]));
        Assert.DoesNotContain("mean `timer create`", SessionWait.Text(hidden.Response!["error"]!["message"]));
        var misspelled = SessionWait.Text((await Run(tools, "ctl", Args("timer creat"))).Response!["error"]!["message"])!;
        Assert.DoesNotContain("`timer create`", misspelled);
        Assert.Contains(
            "`timer list`",
            SessionWait.Text((await Run(tools, "ctl", Args("timer lst"))).Response!["error"]!["message"])
        );
        var denied = await Run(tools, "ctl", Args("memory read MEMORY.md"));
        Assert.Equal("tool_authorization_denied", SessionWait.Text(denied.Response!["error"]!["type"]));
        Assert.Equal("read_memory", SessionWait.Text(denied.Target!["name"]));
        var discovered = SessionWait.Text((await Run(tools, "ctl", Args("tool search memory --source builtin --limit 50"))).Response!["output"])!;
        Assert.DoesNotContain("builtin:read_memory", discovered);
        // A rule naming the removed discovery builtin loads, with a warning, and matches nothing.
        var policy = ToolAuthorizationYaml.Parse(
            Encoding.UTF8.GetBytes("version: 1\nrules:\n- action: allow\n  tool: search_tools\n")
        );
        Assert.Contains(policy.Warnings, warning => warning.Contains("search_tools"));
        Assert.True(f.Manager.ToolVisible(f.Owner, "builtin", "ctl"));
    }

    [Fact]
    public async Task ToolScript_calls_ctl_and_receives_the_target_native_value()
    {
        await using var f = await ScriptFixture.Create();
        var tools = Executor(f);
        var run = await Run(
            tools,
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "a = call_tool('ctl', {'command': 'skill list'})\n"
                    + "b = call_tool('skill', {'action': 'list'})\n"
                    + "found = call_tool('ctl', {'command': 'tool search skill --source builtin'})['tools']\n"
                    + "try:\n    call_tool('ctl', {'command': 'session list --count many'})\n    bad = 'accepted'\nexcept Exception as error:\n    bad = str(error)\n"
                    + "return {'same': a == b, 'found': [row['toolId'] for row in found], 'bad': bad}\n",
            }
        );
        Assert.True(run.Response?["result"] is JsonObject, run.Response?.ToJsonString());
        var result = run.Response!["result"]!.AsObject();
        Assert.True(result["same"]!.GetValue<bool>(), run.Response.ToJsonString());
        Assert.Contains("builtin:skill", result["found"]!.AsArray().Select(value => value!.GetValue<string>()));
        Assert.Contains("Usage: session list", result["bad"]!.GetValue<string>());
    }
}
