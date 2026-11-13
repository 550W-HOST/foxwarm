using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    private const string SameAgentCreationPolicy = """
        version: 1
        defaultAction: allow
        rules:
        - action: deny
          tool: {source: builtin, name: create_session}
          args: {agentName: {agent: {sameAgent: false}}}
        """;

    private static (
        SessionToolExecutor Tools,
        WorkspaceTools Files,
        Foxwarm.McpClient Mcp,
        ToolRegistry Registry
    ) TimerExecutor(SessionManager manager, SessionOwner owner, string root)
    {
        var execution = Executor(manager, owner, root);
        foreach (var definition in TimerToolDefinitions.Definitions().OfType<JsonObject>())
        {
            var name = definition["name"]!.GetValue<string>();
            execution.Registry.Register(
                definition,
                "builtin",
                false,
                (caller, args, token) =>
                    manager.ExecuteTimerToolAsync(caller.Hosted, name, args, token)
            );
        }
        return execution;
    }

    private static JsonObject FreshTimer(string? agent = null, string? owner = null)
    {
        var args = Obj("""{"afterSeconds":3600,"message":"scheduled work","newSession":true}""");
        if (agent is not null)
            args["agentName"] = agent;
        if (owner is not null)
            args["sessionId"] = owner;
        return args;
    }

    [Fact]
    public async Task Create_session_agent_relationship_is_registered_and_shared_without_granting_timer_permission()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, SameAgentCreationPolicy);
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "create_session",
                    Obj("""{"agentName":"alpha","sessionName":"permitted"}""")
                )
            )
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "create_session",
                    Obj("""{"agentName":"beta","sessionName":"forbidden"}""")
                )
            )
        );
        Assert.Null(manager.Catalog.Get("beta/forbidden"));
        Assert.Null(Error(await Call(execution.Tools, "create_timer", FreshTimer("alpha"))));
        var transformed = FreshTimer();
        transformed["agentName"] = new JsonArray(" beta ");
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "ctl",
                    CtlTestArgs.Unified(new JsonObject { ["toolId"] = "builtin:create_timer", ["args"] = transformed })
                )
            )
        );
        Assert.Single(manager.Timers.List(owner.Id));
        Assert.Equal(
            "tool_error",
            Error(await Call(execution.Tools, "create_timer", FreshTimer("missing-agent")))
        );
        Assert.Equal(
            "tool_error",
            Error(await Call(execution.Tools, "create_timer", FreshTimer(owner: "missing-session")))
        );
        await Policy(
            manager,
            SameAgentCreationPolicy
                + """

                - action: deny
                  tool: {source: builtin, name: create_timer}
                """
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_timer", FreshTimer("alpha")))
        );
        Assert.Single(manager.Timers.List(owner.Id));
        Assert.Throws<InvalidDataException>(() =>
            ToolAuthorizationYaml.Parse(
                System.Text.Encoding.UTF8.GetBytes(
                    SameAgentCreationPolicy.Replace("name: create_session", "name: create_timer")
                )
            )
        );
    }

    [Fact]
    public async Task Creation_target_uses_caller_not_owner_and_preserves_alias_and_literal_owner_contracts()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, SameAgentCreationPolicy);
        // The owner alias resolves to beta. Omission inherits beta, not the alpha caller.
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_timer", FreshTimer(owner: "outside")))
        );
        var created = await Call(execution.Tools, "create_timer", FreshTimer("alpha", "outside"));
        Assert.Null(Error(created));
        var timer = created["timer"]!.AsObject();
        Assert.Equal("outside", SessionWait.Text(timer["sessionId"]));
        var id = SessionWait.Text(timer["id"])!;
        var update = new JsonObject
        {
            ["sessionId"] = "outside",
            ["timerId"] = id,
            ["message"] = "updated",
        };
        Assert.Null(Error(await Call(execution.Tools, "update_timer", update)));
        update["sessionId"] = "foreign";
        Assert.NotNull(
            Error(await Call(execution.Tools, "update_timer", update.DeepClone().AsObject()))
        );
        Assert.Empty(manager.Timers.List("foreign"));
        Assert.Single(manager.Timers.List("outside"));
        // No creation occurs, so an ordinary timer may still deliver to that existing owner.
        var ordinary = FreshTimer(owner: "outside");
        ordinary["newSession"] = false;
        Assert.Null(Error(await Call(execution.Tools, "create_timer", ordinary)));
    }

    [Fact]
    public async Task Update_checks_inherited_target_but_clearing_or_switching_action_removes_creation_requirement()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var created = await Call(execution.Tools, "create_timer", FreshTimer("beta"));
        var id = SessionWait.Text(created["timer"]!["id"])!;
        await Policy(manager, SameAgentCreationPolicy);
        var update = new JsonObject { ["timerId"] = id, ["message"] = "replacement" };
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "update_timer", update))
        );
        Assert.Equal(
            "scheduled work",
            SessionWait.Text(manager.Timers.Get(id, owner.Id)["message"])
        );
        update["agentName"] = " alpha ";
        Assert.Null(
            Error(await Call(execution.Tools, "update_timer", update.DeepClone().AsObject()))
        );
        Assert.Equal("alpha", SessionWait.Text(manager.Timers.Get(id, owner.Id)["agentName"]));
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
            - action: deny
              tool: {source: builtin, name: create_session}
            """
        );
        var cleared = await Call(
            execution.Tools,
            "update_timer",
            new JsonObject { ["timerId"] = id, ["newSession"] = false }
        );
        Assert.Null(Error(cleared));
        Assert.Null(cleared["timer"]!["agentName"]);
        var script = await Call(
            execution.Tools,
            "update_timer",
            new JsonObject
            {
                ["timerId"] = id,
                ["action"] = "toolscript",
                ["script"] = Obj("""{"code":"return 1"}"""),
            }
        );
        Assert.Null(Error(script));
        Assert.False(script["timer"]!["newSession"]!.GetValue<bool>());
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "update_timer",
                    new JsonObject { ["timerId"] = id, ["script"] = Obj("""{"code":"return 2"}""") }
                )
            )
        );
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "update_timer",
                    new JsonObject
                    {
                        ["timerId"] = id,
                        ["action"] = "message",
                        ["message"] = "ordinary",
                    }
                )
            )
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "update_timer",
                    new JsonObject
                    {
                        ["timerId"] = id,
                        ["newSession"] = true,
                        ["agentName"] = "alpha",
                    }
                )
            )
        );
    }

    [Fact]
    public async Task Creation_policy_intersects_agent_rules()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            Obj(
                """{"rules":[{"tool":{"source":"builtin","name":"create_session"},"args":{"agentName":{"agent":{"sameAgent":false}}},"action":"deny"}]}"""
            )
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        Assert.Null(Error(await Call(execution.Tools, "create_timer", FreshTimer("alpha"))));
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_timer", FreshTimer("beta")))
        );
    }

    [Fact]
    public async Task New_target_check_applies_to_real_nested_toolscript_and_agent_local_denials()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            Obj(
                """{"rules":[{"tool":{"source":"builtin","name":"create_session"},"args":{"agentName":{"agent":{"sameAgent":false}}},"action":"deny"}]}"""
            )
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var denied = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] = "return call_tool('builtin:create_timer', args)",
                ["args"] = FreshTimer("beta"),
            }
        );
        Assert.Equal("failed", SessionWait.Text(denied["status"]));
        Assert.Contains("Tool authorization", SessionWait.Text(denied["error"]));
        Assert.Empty(manager.Timers.List(owner.Id));
        var allowed = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] = "return call_tool('builtin:create_timer', args)",
                ["args"] = FreshTimer("alpha"),
            }
        );
        Assert.Equal("completed", SessionWait.Text(allowed["status"]));
        Assert.Equal("alpha", SessionWait.Text(allowed["result"]!["timer"]!["agentName"]));
    }

    [Fact]
    public async Task Concurrent_update_authorizes_the_row_it_will_write_not_the_newer_store_target()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var saved = await manager.ExecuteTimerToolAsync(
            owner,
            "create_timer",
            FreshTimer("beta"),
            default
        );
        var id = SessionWait.Text(saved["timer"]!["id"])!;
        await Policy(manager, SameAgentCreationPolicy);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = 0;
        manager.Timers.WriteStage = _ =>
        {
            if (Interlocked.Exchange(ref first, 1) != 0)
                return;
            held.TrySetResult();
            release.Task.GetAwaiter().GetResult();
        };
        var blocker = manager.ExecuteTimerToolAsync(
            owner,
            "create_timer",
            Obj("""{"afterSeconds":3600,"message":"hold store lane"}"""),
            default
        );
        try
        {
            await held.Task.WaitAsync(TimeSpan.FromSeconds(10));
            // Hot owner and installed policy complete synchronously up to the held store lane.
            var clear = manager.ExecuteTimerToolAsync(
                owner,
                "update_timer",
                new JsonObject { ["timerId"] = id, ["newSession"] = false },
                default
            );
            var inherited = manager.ExecuteTimerToolAsync(
                owner,
                "update_timer",
                new JsonObject { ["timerId"] = id, ["message"] = "stale candidate" },
                default
            );
            Assert.False(clear.IsCompleted);
            Assert.False(inherited.IsCompleted);
            release.TrySetResult();
            await blocker;
            await clear;
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() => inherited);
            Assert.False(manager.Timers.Get(id, owner.Id)["newSession"]!.GetValue<bool>());
        }
        finally
        {
            release.TrySetResult();
            await blocker;
            manager.Timers.WriteStage = null;
        }
    }

    [Theory]
    [InlineData("allow", "deny", "deny", "Indeterminate")]
    [InlineData("deny", "deny", "allow", "Deny")]
    [InlineData("deny", "allow", "allow", "Indeterminate")]
    [InlineData("allow", "allow", "deny", "Allow")]
    public void Timer_target_precheck_preserves_unknown_earlier_first_match_outcomes(
        string first,
        string second,
        string fallback,
        string expected
    )
    {
        var policy = ToolAuthorizationPolicy.Normalize(
            Obj(
                $$$"""
                {"version":1,"defaultAction":"{{{fallback}}}","rules":[
                  {"action":"{{{first}}}","tool":{"source":"builtin","name":"create_session"},"args":{"sessionName":"future_name"}},
                  {"action":"{{{second}}}","tool":{"source":"builtin","name":"create_session"},"args":{"agentName":"beta"}}
                ]}
                """
            )
        );
        var request = new ToolAuthorizationRequest(
            "builtin",
            "create_session",
            null,
            Obj("""{"agentName":"beta"}"""),
            [],
            "alpha",
            "alpha/source",
            "master",
            "/synthetic",
            "/synthetic/alpha",
            "/synthetic/alpha/memory"
        );
        Assert.Equal(
            Enum.Parse<CreationTargetDecision>(expected),
            ToolAuthorizationEvaluation.EvaluateCreationTarget(policy, request)
        );
        // The ordinary evaluator remains exact, not three-state: these real arguments
        // select the earlier rule, while another concrete name selects the target rule.
        Assert.Equal(
            first == "allow",
            ToolAuthorizationEvaluation
                .Evaluate(
                    policy,
                    request with
                    {
                        Args = Obj("""{"agentName":"beta","sessionName":"future_name"}"""),
                    }
                )
                .Allowed
        );
        Assert.Equal(
            second == "allow",
            ToolAuthorizationEvaluation
                .Evaluate(
                    policy,
                    request with
                    {
                        Args = Obj("""{"agentName":"beta","sessionName":"another_name"}"""),
                    }
                )
                .Allowed
        );
    }

    [Fact]
    public void Agent_creation_allowlist_requires_a_known_internal_same_agent_target()
    {
        var policy = ToolAuthorizationPolicy.Normalize(
            Obj(
                """
                {"version":1,"defaultAction":"deny","rules":[
                  {"action":"allow","tool":{"source":"builtin","name":"create_session"},"args":{"agentName":{"agent":{"sameAgent":true}}}}
                ]}
                """
            )
        );
        var request = new ToolAuthorizationRequest(
            "builtin",
            "create_session",
            null,
            Obj("""{"agentName":"alpha"}"""),
            [],
            "alpha",
            "alpha/source",
            "master",
            "/synthetic",
            "/synthetic/alpha",
            "/synthetic/alpha/memory"
        );
        Assert.True(ToolAuthorizationEvaluation.Evaluate(policy, request).Allowed);
        Assert.False(
            ToolAuthorizationEvaluation
                .Evaluate(policy, request with { Args = Obj("""{"agentName":"beta"}""") })
                .Allowed
        );
        Assert.False(
            ToolAuthorizationEvaluation.Evaluate(policy, request with { Args = new() }).Allowed
        );
        Assert.False(
            ToolAuthorizationEvaluation
                .Evaluate(policy, request with { Args = Obj("""{"agentName":["alpha"]}""") })
                .Allowed
        );
        Assert.False(
            ToolAuthorizationEvaluation
                .Evaluate(policy, request with { Principal = "external", ExternalId = "peer" })
                .Allowed
        );
    }

    [Fact]
    public async Task Indeterminate_registration_reports_future_parameters_and_does_not_write_a_timer()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
            - action: allow
              tool: {source: builtin, name: create_session}
              args: {sessionName: future_name}
            - action: deny
              tool: {source: builtin, name: create_session}
              args: {agentName: {agent: {sameAgent: false}}}
            """
        );
        var result = await Call(execution.Tools, "create_timer", FreshTimer("beta"));
        Assert.Equal("tool_authorization_denied", Error(result));
        Assert.Contains("Future Session parameters", result.ToJsonString());
        Assert.Empty(manager.Timers.List(owner.Id));
        Assert.Null(Error(await Call(execution.Tools, "create_timer", FreshTimer("alpha"))));
    }
}
