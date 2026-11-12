using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    private const string MigrationIsolation = """
        {"isolated":true,"isolatedNode":"bound-node","toolRules":[
          {"effect":"deny","source":"builtin","tool":"image_crop"},
          {"effect":"allow","source":"mcp","server":"srv","tool":"tool1"},
          {"effect":"allow","source":"builtin","tool":"create_session"},
          {"effect":"allow","source":"builtin","tool":"send_to_channel"},
          {"effect":"allow","source":"node","node":"master","tool":"exec"},
          {"effect":"allow","source":"node","node":"elsewhere","tool":"read"}
        ]}
        """;

    private static async Task<bool> Permits(
        SessionManager manager,
        SessionOwner owner,
        WorkspaceTools files,
        string source,
        string name,
        string args,
        string node = "master",
        string? server = null
    )
    {
        try
        {
            await manager.AuthorizeToolAsync(
                owner,
                new ResolvedTool(name, source, name, Obj(args), server, node),
                files,
                CancellationToken.None
            );
            return true;
        }
        catch (ToolAuthorizationDeniedException)
        {
            return false;
        }
    }

    // Calls whose legacy decision is made at authorization time; handler-local limits are
    // checked separately against the generated layer.
    private static readonly (
        string Source,
        string Name,
        string Args,
        string Node,
        string? Server,
        bool Allowed
    )[] ParityCalls =
    [
        ("node", "read", """{"filePath":"a.txt"}""", "bound-node", null, true),
        ("node", "exec", """{"command":"ls"}""", "bound-node", null, true),
        ("node", "exec", """{"command":"ls"}""", "master", null, false),
        ("node", "read", """{"filePath":"a.txt"}""", "elsewhere", null, false),
        ("builtin", "create_session", "{}", "master", null, false),
        ("builtin", "list_agents", "{}", "master", null, false),
        ("builtin", "task", """{"action":"list"}""", "master", null, false),
        ("builtin", "image_crop", "{}", "master", null, false),
        ("builtin", "explain_tool_authorization", "{}", "master", null, false),
        ("builtin", "node", """{"action":"select","nodeId":"bound-node"}""", "master", null, false),
        ("mcp", "tool1", "{}", "master", "srv", true),
        ("mcp", "tool2", "{}", "master", "srv", false),
        ("mcp", "tool1", "{}", "master", "other", false),
        ("builtin", "session", "{}", "master", null, true),
        ("builtin", "session", """{"action":"status"}""", "master", null, true),
        ("builtin", "session", """{"action":"list"}""", "master", null, false),
        ("builtin", "skill", """{"action":"list"}""", "master", null, true),
        (
            "builtin",
            "skill",
            """{"action":"load","skillName":"x","agentName":"alpha"}""",
            "master",
            null,
            true
        ),
        ("builtin", "skill", """{"action":"list","agentName":"beta"}""", "master", null, false),
        ("builtin", "recall", """{"sessionId":"kid"}""", "master", null, true),
        ("builtin", "recall", """{"sessionId":"outside"}""", "master", null, false),
        (
            "builtin",
            "send_to_session",
            """{"sessionId":"kid","message":"x"}""",
            "master",
            null,
            true
        ),
        ("builtin", "wait", "{}", "master", null, true),
        ("builtin", "ask_user", "{}", "master", null, true),
        ("builtin", "continue_script", "{}", "master", null, true),
        ("builtin", "search_tools", "{}", "master", null, true),
    ];

    private static async Task AssertParity(SessionManager manager, string root, string label)
    {
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, root);
        await using var mcp = execution.Mcp;
        foreach (var call in ParityCalls)
            Assert.True(
                call.Allowed
                    == await Permits(
                        manager,
                        owner,
                        execution.Files,
                        call.Source,
                        call.Name,
                        call.Args,
                        call.Node,
                        call.Server
                    ),
                $"{label}: {call.Source}:{call.Name} {call.Args} on {call.Node} should be {(call.Allowed ? "allowed" : "denied")}."
            );

        // Timers decide their new-Session target in the handler, against create_session policy.
        var timers = TimerExecutor(manager, owner, root);
        await using var timerMcp = timers.Mcp;
        async Task<bool> Timer(string name, JsonObject args) =>
            Error(await Call(timers.Tools, name, args)) is null;
        Assert.True(await Timer("create_timer", FreshTimer("alpha")), $"{label}: own-Agent timer");
        Assert.True(await Timer("create_timer", FreshTimer()), $"{label}: default-Agent timer");
        Assert.False(
            await Timer("create_timer", FreshTimer("beta")),
            $"{label}: other-Agent timer"
        );
        var plain = await Call(
            timers.Tools,
            "create_timer",
            Obj("""{"afterSeconds":3600,"message":"x"}""")
        );
        Assert.Null(Error(plain));
        var id = SessionWait.Text(plain["timer"]!["id"])!;
        Assert.True(
            await Timer("update_timer", new JsonObject { ["timerId"] = id, ["message"] = "y" }),
            $"{label}: plain update"
        );
        Assert.True(
            await Timer(
                "update_timer",
                new JsonObject
                {
                    ["timerId"] = id,
                    ["newSession"] = true,
                    ["agentName"] = "alpha",
                }
            ),
            $"{label}: update to an own-Agent new Session"
        );
        Assert.False(
            await Timer(
                "update_timer",
                new JsonObject
                {
                    ["timerId"] = id,
                    ["newSession"] = true,
                    ["agentName"] = "beta",
                }
            ),
            $"{label}: update to another Agent"
        );
    }

    [Fact]
    public void Generated_isolation_layer_orders_denies_first_and_reports_each_exact_rule()
    {
        var isolation = IsolatedToolCompatibility.Metadata(Obj(MigrationIsolation));
        var plan = IsolationMigrationRules.Generate("alpha", isolation, retainedMainLayout: false);
        Assert.Empty(plan.Blockers);
        var rules = plan.Rules.OfType<JsonObject>().ToArray();
        Assert.Equal("isolation-exact-deny", rules[0]["id"]!.GetValue<string>());
        Assert.Equal("deny", rules[0]["action"]!.GetValue<string>());
        // Own-Agent creation targets (shared with new-Session timers) precede the structural deny.
        Assert.Equal("isolation-own-agent-sessions", rules[1]["id"]!.GetValue<string>());
        Assert.Equal("isolation-structural", rules[2]["id"]!.GetValue<string>());
        Assert.Equal("isolation-deny-other", rules[^1]["id"]!.GetValue<string>());
        Assert.Null(rules[^1]["match"]);
        Assert.Equal(
            rules.Length,
            rules.Select(rule => rule["id"]!.GetValue<string>()).Distinct().Count()
        );
        // The bound Node replaces master for unrestricted Node tools; master stays file-only.
        Assert.Contains(rules, rule => rule["id"]!.GetValue<string>() == "isolation-node");
        Assert.DoesNotContain(
            rules,
            rule =>
                rule["action"]!.GetValue<string>() == "allow"
                && SessionWait.Text(rule["match"]?["tool"]?["name"]) == "exec"
        );

        string Kind(string subject) =>
            plan.Notes.First(note => note.Subject == subject && note.Kind != "widened").Kind;
        Assert.Equal("translated", Kind("builtin:image_crop"));
        Assert.Equal("translated", Kind("mcp:srv/tool1"));
        Assert.Equal("dropped", Kind("builtin:create_session"));
        Assert.Contains(
            plan.Notes,
            note => note.Subject == "builtin:create_session" && note.Kind == "widened"
        );
        Assert.Equal("dropped", Kind("builtin:send_to_channel"));
        Assert.Equal("dropped", Kind("node:master/exec"));
        Assert.Equal("dropped", Kind("node:elsewhere/read"));

        // A master-only Agent gets no unrestricted Node rule.
        var masterOnly = IsolationMigrationRules.Generate(
            "alpha",
            IsolatedToolCompatibility.Metadata(Obj("""{"isolated":true}""")),
            retainedMainLayout: false
        );
        Assert.DoesNotContain(
            masterOnly.Rules.OfType<JsonObject>(),
            rule => rule["id"]!.GetValue<string>() == "isolation-node"
        );

        // Too many translated rules and the retained main layout are blockers, not truncation.
        var many = new JsonArray(
            Enumerable
                .Range(0, 240)
                .Select(index =>
                    (JsonNode?)
                        new JsonObject
                        {
                            ["effect"] = "allow",
                            ["source"] = "mcp",
                            ["server"] = "srv",
                            ["tool"] = "t" + index,
                        }
                )
                .ToArray()
        );
        var crowded = new JsonObject { ["isolated"] = true, ["toolRules"] = many };
        Assert.Contains(
            IsolationMigrationRules
                .Generate("alpha", IsolatedToolCompatibility.Metadata(crowded), false)
                .Blockers,
            blocker => blocker.Contains("limit is 256")
        );
        Assert.NotEmpty(
            IsolationMigrationRules
                .Generate(
                    "main",
                    IsolatedToolCompatibility.Metadata(Obj("""{"isolated":true}""")),
                    true
                )
                .Blockers
        );
    }

    [Fact]
    public async Task Isolation_migration_layer_keeps_handler_local_limits_as_policy()
    {
        using var temp = new TempDirectory();
        var plan = IsolationMigrationRules.Generate(
            "alpha",
            IsolatedToolCompatibility.Metadata(Obj(MigrationIsolation)),
            false
        );
        await Seed(temp.Path, new JsonObject { ["rules"] = plan.Rules.DeepClone() });
        var agentDir = Path.Combine(temp.Path, "workspace", "agents", "alpha");
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var opaque = await manager.RequiredAsync("opaque");
        var direct = await manager.RequiredAsync("direct");
        var execution = Executor(manager, opaque, temp.Path);
        await using var mcp = execution.Mcp;
        var files = execution.Files;

        Task<bool> Builtin(SessionOwner owner, string name, string args) =>
            Permits(manager, owner, files, "builtin", name, args);

        // Session relations: self, direct parent and child only.
        Assert.True(
            await Builtin(opaque, "send_to_session", """{"sessionId":"self","message":"x"}""")
        );
        Assert.True(
            await Builtin(direct, "send_to_session", """{"sessionId":"<parent>","message":"x"}""")
        );
        Assert.False(
            await Builtin(opaque, "send_to_session", """{"sessionId":"outside","message":"x"}""")
        );
        // Archives and status stay within the Agent and the caller.
        Assert.True(await Builtin(opaque, "get_archived_messages", """{"sessionId":"kid"}"""));
        Assert.False(await Builtin(opaque, "get_archived_messages", """{"sessionId":"outside"}"""));
        // Status is limited to the current Session.
        Assert.False(
            await Builtin(opaque, "session", """{"action":"status","sessionId":"outside"}""")
        );
        Assert.True(await Builtin(opaque, "session", """{"action":"status","sessionId":"self"}"""));
        Assert.False(
            await Builtin(opaque, "session", """{"action":"update-display-name","name":"x"}""")
        );
        // Semantic recall is limited to the current Session and must say so.
        Assert.False(await Builtin(opaque, "recall", """{"vector_query":"x"}"""));
        Assert.True(
            await Builtin(opaque, "recall", """{"vector_query":"x","scope":"current-session"}""")
        );
        Assert.False(await Builtin(opaque, "recall", """{"vector_query":"x","sessionId":"kid"}"""));
        // Timers stay on the caller; channel sends are denied.
        Assert.True(await Builtin(opaque, "list_timers", "{}"));
        Assert.False(await Builtin(opaque, "list_timers", """{"sessionId":"kid"}"""));
        Assert.False(
            await Builtin(opaque, "create_timer", """{"newSession":true,"agentName":"beta"}""")
        );
        Assert.False(await Builtin(opaque, "send_to_channel", """{"message":"x"}"""));
        // Master files and memory stay inside the Agent's directories.
        var inside = Path.Combine(agentDir, "a.txt");
        var outside = Path.Combine(temp.Path, "workspace", "agents", "beta", "a.txt");
        Assert.True(
            await Permits(manager, opaque, files, "node", "read", $$"""{"filePath":"{{inside}}"}""")
        );
        Assert.False(
            await Permits(
                manager,
                opaque,
                files,
                "node",
                "read",
                $$"""{"filePath":"{{outside}}"}"""
            )
        );
        Assert.True(await Builtin(opaque, "read_memory", """{"filePath":"MEMORY.md"}"""));

        // Broad MCP discovery skips servers the layer denies outright.
        var context = manager.VisibilityFor(opaque);
        Assert.True(manager.McpServerVisible(context, "srv"));
        Assert.False(manager.McpServerVisible(context, "other"));
        var foreign = await manager.RequiredAsync("foreign");
        Assert.True(manager.McpServerVisible(manager.VisibilityFor(foreign), "other"));
    }

    [Fact]
    public async Task Noninheritable_agents_reject_new_inheritors_and_reader_marker_blocks_older_readers()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            Assert.True(manager.AgentInheritable("beta"));
            await manager.SetAgentInheritableAsync("beta", false);
            Assert.False(manager.AgentInheritable("beta"));
            var denied = await Assert.ThrowsAsync<InvalidDataException>(() =>
                manager.SetAgentInheritAsync("alpha", "beta")
            );
            Assert.Contains("not inheritable", denied.Message);

            await manager.SetAgentInheritableAsync("beta", true);
            Assert.Null(manager.AgentMetadata["beta"]?["inheritable"]);
            await manager.SetAgentInheritAsync("alpha", "beta");
            var inherited = await Assert.ThrowsAsync<InvalidDataException>(() =>
                manager.SetAgentInheritableAsync("beta", false)
            );
            Assert.Contains("alpha", inherited.Message);
        }

        var marker = Path.Combine(temp.Path, "data", "state", AgentCatalog.InstallationFileName);
        Assert.Equal(
            AgentCatalog.ReaderVersion,
            JsonNode.Parse(await File.ReadAllTextAsync(marker))![
                "minimumReaderVersion"
            ]!.GetValue<int>()
        );
        await File.WriteAllTextAsync(
            marker,
            new JsonObject
            {
                ["minimumReaderVersion"] = AgentCatalog.ReaderVersion + 1,
            }.ToJsonString()
        );
        var refused = await Assert.ThrowsAnyAsync<InvalidDataException>(async () =>
        {
            await using var newer = Manager(temp.Path);
            await newer.LoadAsync();
        });
        Assert.Contains("Upgrade Main", refused.Message);
    }
}
