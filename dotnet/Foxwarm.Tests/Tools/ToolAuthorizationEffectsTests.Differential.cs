using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Timers;
using Foxwarm.Tools;
using static Foxwarm.Tests.OperationEffectConformance;

namespace Foxwarm.Tests;

// Differential conformance (OperationEffectConformance): each case is a representative real call
// of a capability with side effects, including its omitted-argument default forms. Node and
// secret capabilities are in NodeAuthorizationTreeTests.Differential.cs and
// AgentRulesTreeTests.Differential.cs, whose fixtures register them.
public sealed partial class ToolAuthorizationEffectsTests
{
    private sealed record DifferentialWorld(
        SessionManager Manager,
        SessionOwner Caller,
        string Root,
        List<string> Roots,
        Func<string, JsonObject, Task<JsonObject>> Call
    )
    {

        internal async Task<string> Task(string? owner = null)
        {
            var created = await Manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "create", ["title"] = "differential", ["notifySession"] = false },
                owner ?? Caller.Id
            );
            return SessionWait.Text(created.Payload["task"]!["id"])!;
        }
    }

    // Case name → builder (setup may write files or create Tasks before the call).
    private static readonly Dictionary<string, Func<DifferentialWorld, Task<Case>>> DifferentialCases = new()
    {
        // create_agent
        ["create_agent default"] = _ => Ready(new("", "create_agent", Obj("""{"agentName":"d-default"}"""))),
        ["create_agent without main"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-nomain","createMainSession":false}"""))),
        ["create_agent defaultNode"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-node","defaultNode":"master"}"""))),
        ["create_agent inherit"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-inherit","inherit":"alpha"}"""))),
        ["create_agent inheritMemory (caller source)"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-memory","createMainSession":false,"inheritMemory":true}"""))),
        ["create_agent inheritMemory with main"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-memory-main","inheritMemory":true}"""))),
        ["create_agent inheritMemory (named source)"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-memory-named","inheritMemory":true,"sourceSessionId":"foreign"}"""))),
        ["create_agent missing source"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-missing","sourceSessionId":"beta/new-source"}"""))),
        ["create_agent convert caller"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-convert","convertSession":true}"""))),
        ["create_agent convert named"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-convert-named","convertSession":true,"sourceSessionId":"direct"}"""))),
        ["create_agent convert with memory"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-convert-memory","convertSession":true,"inheritMemory":true}"""))),
        ["create_agent symlinked memory"] = world =>
        {
            var memory = Path.Combine(world.Manager.AgentDirectory("alpha"), "memory");
            var physical = Path.Combine(world.Root, "linked-memory");
            Directory.CreateDirectory(physical);
            File.WriteAllText(Path.Combine(physical, "linked.md"), "physical memory");
            Directory.Delete(memory, true);
            Directory.CreateSymbolicLink(memory, physical);
            world.Roots.Add(physical);
            return Ready(new("", "create_agent", Obj("""{"agentName":"d-link","createMainSession":false,"inheritMemory":true}""")));
        },
        // create_child_session (and fork)
        ["create_child_session default"] = _ => Ready(new("", "create_child_session", Obj("""{"suffix":"k-default"}"""))),
        ["create_child_session other Agent"] = _ =>
            Ready(new("", "create_child_session", Obj("""{"suffix":"k-beta","agentName":"beta"}"""))),
        ["create_child_session explicit Node"] = _ =>
            Ready(new("", "create_child_session", Obj("""{"suffix":"k-node","node":"master"}"""))),
        ["create_child_session fork"] = _ =>
            Ready(new("", "create_child_session", Obj("""{"suffix":"k-fork","fork":true}"""))),
        ["create_child_session Task"] = async world =>
        {
            var task = await world.Task();
            return new("", "create_child_session", new JsonObject { ["suffix"] = "k-task", ["taskId"] = task }, Tasks: [task]);
        },
        ["create_child_session Task in other Agent"] = async world =>
        {
            var task = await world.Task();
            return new(
                "",
                "create_child_session",
                new JsonObject { ["suffix"] = "k-task-beta", ["agentName"] = "beta", ["taskId"] = task },
                Tasks: [task]
            );
        },
        // create_session
        ["create_session other Agent"] = _ =>
            Ready(new("", "create_session", Obj("""{"agentName":"beta","sessionName":"s-beta"}"""))),
        ["create_session own Agent"] = _ =>
            Ready(new("", "create_session", Obj("""{"agentName":"alpha","sessionName":"s-alpha"}"""))),
        ["create_session parent"] = _ =>
            Ready(new("", "create_session", Obj("""{"agentName":"alpha","sessionName":"s-parent","parentSessionId":"opaque"}"""))),
        ["create_session explicit Node"] = _ =>
            Ready(new("", "create_session", Obj("""{"agentName":"beta","sessionName":"s-node","node":"master"}"""))),
        // move_session and delete_session
        ["move_session rename"] = _ =>
            Ready(new("", "move_session", Obj("""{"sessionId":"direct","newSessionId":"renamed"}"""))),
        ["move_session other Agent"] = _ =>
            Ready(new("", "move_session", Obj("""{"sessionId":"direct","newAgentName":"beta","newSessionId":"moved"}"""))),
        ["move_session new Agent"] = _ =>
            Ready(new("", "move_session", Obj("""{"sessionId":"direct","newAgentName":"m-new","createAgent":true}"""))),
        ["move_session new Agent with memory"] = _ =>
            Ready(new("", "move_session", Obj("""{"sessionId":"direct","newAgentName":"m-memory","createAgent":true,"createAgentInheritMemory":true}"""))),
        ["move_session caller"] = _ => Ready(new("", "move_session", Obj("""{"newAgentName":"beta","newSessionId":"moved-caller"}"""))),
        ["delete_session"] = _ => Ready(new("", "delete_session", Obj("""{"sessionId":"direct"}"""))),
        // copy_between_nodes
        ["copy_between_nodes file"] = world =>
        {
            var source = Path.Combine(world.Root, "copy-source", "file.txt");
            Directory.CreateDirectory(Path.GetDirectoryName(source)!);
            File.WriteAllText(source, "copied bytes");
            var target = Path.Combine(world.Root, "copy-target", "file.txt");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            world.Roots.Add(Path.Combine(world.Root, "copy-target"));
            return Ready(
                new(
                    "",
                    "copy_between_nodes",
                    new JsonObject
                    {
                        ["sourceNode"] = "master",
                        ["sourcePath"] = source,
                        ["targetNode"] = "master",
                        ["targetPath"] = target,
                    }
                )
            );
        },
        // Memory writers
        ["write_memory"] = _ => Ready(new("", "write_memory", Obj("""{"filePath":"notes/new.md","content":"new"}"""))),
        ["edit_memory"] = _ =>
            Ready(new("", "edit_memory", Obj("""{"filePath":"differential.md","oldText":"memory","newText":"edited"}"""))),
        ["delete_memory"] = _ => Ready(new("", "delete_memory", Obj("""{"filePath":"nested/deep.md"}"""))),
        ["create_session parent is caller"] = world =>
            Ready(
                new(
                    "",
                    "create_session",
                    new JsonObject { ["agentName"] = "alpha", ["sessionName"] = "s-child", ["parentSessionId"] = world.Caller.Id }
                )
            ),
        ["create_session parent alias"] = _ =>
            Ready(new("", "create_session", Obj("""{"agentName":"alpha","sessionName":"s-alias","parentSessionId":"self"}"""))),
        ["move_session alias"] = _ =>
            Ready(new("", "move_session", Obj("""{"sessionId":"kid","newSessionId":"renamed-alias"}"""))),
        ["delete_session alias"] = _ => Ready(new("", "delete_session", Obj("""{"sessionId":"kid"}"""))),
        ["create_agent convert alias"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-convert-alias","convertSession":true,"sourceSessionId":"kid"}"""))),
        ["create_agent inheritMemory (alias source)"] = _ =>
            Ready(new("", "create_agent", Obj("""{"agentName":"d-memory-alias","inheritMemory":true,"sourceSessionId":"outside"}"""))),
        ["task assign alias"] = async world =>
        {
            var task = await world.Task();
            return new(
                "",
                "task",
                new JsonObject { ["action"] = "assign", ["taskId"] = task, ["ownerSessionId"] = "kid" },
                Tasks: [task]
            );
        },
        // Agent metadata writers
        ["set_agent_rules"] = async world =>
        {
            Assert.Null(Error(await world.Call("create_agent", Obj("""{"agentName":"d-ruled","createMainSession":false}"""))));
            return new("", "set_agent_rules", Obj("""{"agentName":"d-ruled","rules":[{"op":"env.exec","action":"deny"}]}"""));
        },
        ["set_agent_inherit"] = async world =>
        {
            Assert.Null(Error(await world.Call("create_agent", Obj("""{"agentName":"d-heir","createMainSession":false}"""))));
            return new("", "set_agent_inherit", Obj("""{"agentName":"d-heir","inheritAgentName":"alpha"}"""));
        },
        // A timer that creates a Session when it fires: the creation probe states the Agent;
        // the Node and parent are decided at fire time.
        ["create_timer new Session"] = _ =>
            Ready(
                new(
                    "",
                    "create_timer",
                    Obj("""{"afterSeconds":1,"message":"fire","newSession":true,"agentName":"beta"}"""),
                    Deferred: ["session.create:node"],
                    Probes: TimerCreationTarget
                )
            ),
    };

    private static Task<Case> Ready(Case value) => Task.FromResult(value);

    // A new-Session timer's creation target, from the call's arguments before it runs: the
    // stored row's Agent is the named Agent (normalized as TimerArguments stores it), else the
    // owner Session's.
    private static IEnumerable<AuthorizationOperation> TimerCreationTarget(Case @case, SessionOwner caller) =>
        MainTimers.Flag(@case.Args["newSession"])
            ? [ToolAuthorizationEvaluation.CreationTargetOperation(TimerArguments.Optional(@case.Args["agentName"]) ?? caller.Agent)]
            : [];

    public static TheoryData<string> DifferentialCaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in DifferentialCases.Keys)
            data.Add(name);
        return data;
    }

    // Each case, then each whitespace-padded variant of its identifier arguments, each in a
    // fresh fixture (a variant is derived from the case its own fixture builds).
    [Theory]
    [MemberData(nameof(DifferentialCaseNames))]
    public async Task Operation_plans_match_what_handlers_do(string name)
    {
        var (problems, built) = await RunDifferential(name, @case => @case);
        for (var index = 0; index < Padded(built).Count(); index++)
        {
            var variant = index;
            var (variantProblems, _) = await RunDifferential(name, @case => Padded(@case).ElementAt(variant));
            problems.AddRange(variantProblems);
        }
        Assert.True(problems.Count == 0, name + ":\n" + string.Join("\n", problems));
    }

    private static async Task<(List<string> Problems, Case Case)> RunDifferential(string name, Func<Case, Case> transform)
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        foreach (var agent in new[] { "alpha", "beta" })
        {
            var memory = Path.Combine(temp.Path, "workspace", "agents", agent, "memory");
            Directory.CreateDirectory(Path.Combine(memory, "nested"));
            await File.WriteAllTextAsync(Path.Combine(memory, "differential.md"), "memory of " + agent);
            await File.WriteAllTextAsync(Path.Combine(memory, "nested", "deep.md"), "deep memory of " + agent);
        }
        await using var manager = Manager(temp.Path);
        // Only the Main host starts the timer scheduler.
        if (name.StartsWith("create_timer", StringComparison.Ordinal))
            await manager.LoadMainHostAsync();
        else
            await manager.LoadAsync();
        var caller = await manager.CreateNamedAsync("alpha", "caller", null, null);
        var execution = TimerExecutor(manager, caller, temp.Path, MainLocalToolDefinitions.Definitions());
        await using var mcp = execution.Mcp;
        var world = new DifferentialWorld(
            manager,
            caller,
            temp.Path,
            [Path.Combine(temp.Path, "workspace")],
            (tool, args) => Call(execution.Tools, tool, args)
        );
        var @case = transform((await DifferentialCases[name](world)) with { Name = name });
        await Policy(manager, OperationEffectConformance.Policy);
        var fired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        manager.TimerSessionName = _ => "fired";
        manager.BeforeCreationPublication = id =>
        {
            if (id.EndsWith("/fired", StringComparison.Ordinal))
                fired.TrySetResult();
            return System.Threading.Tasks.Task.CompletedTask;
        };
        var problems = await Run(
            @case,
            manager,
            caller,
            (tool, args) => manager.AssessToolAsync(caller, execution.Registry.Resolve(tool, args), execution.Files, default),
            async (tool, args) =>
            {
                var result = await Call(execution.Tools, tool, args);
                if (tool == "create_timer" && result["error"] is null)
                {
                    await fired.Task.WaitAsync(TimeSpan.FromSeconds(10));
                    // Publication completes after the hook.
                    for (var attempt = 0; attempt < 100 && manager.Catalog.List().All(row => !SessionWait.Text(row["id"])!.EndsWith("/fired")); attempt++)
                        await System.Threading.Tasks.Task.Delay(50);
                }
                return result;
            },
            world.Roots
        );
        return (problems.Select(problem => "[" + @case.Name + "] " + problem).ToList(), @case);
    }
}
