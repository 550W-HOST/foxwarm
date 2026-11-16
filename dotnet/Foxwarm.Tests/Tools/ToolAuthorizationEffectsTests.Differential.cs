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
        List<string> Roots
    )
    {
        // Timers as stored when create_timer returned (a fired one-shot timer is removed).
        internal List<JsonObject> Timers { get; } = [];

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
        // A timer that creates a Session when it fires: the creation probe states the Agent;
        // the Node and parent are decided at fire time.
        ["create_timer new Session"] = world =>
            Ready(
                new(
                    "",
                    "create_timer",
                    Obj("""{"afterSeconds":1,"message":"fire","newSession":true,"agentName":"beta"}"""),
                    Deferred: ["session.create:node"],
                    Probes: (_, _) =>
                        world
                            .Timers.Where(timer => MainTimers.Flag(timer["newSession"]))
                            .Select(timer => ToolAuthorizationEvaluation.CreationTargetOperation(SessionWait.Text(timer["agentName"])!))
                )
            ),
    };

    private static Task<Case> Ready(Case value) => Task.FromResult(value);

    public static TheoryData<string> DifferentialCaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in DifferentialCases.Keys)
            data.Add(name);
        return data;
    }

    [Theory]
    [MemberData(nameof(DifferentialCaseNames))]
    public async Task Operation_plans_match_what_handlers_do(string name)
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
        var world = new DifferentialWorld(manager, caller, temp.Path, [Path.Combine(temp.Path, "workspace")]);
        var @case = (await DifferentialCases[name](world)) with { Name = name };
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
                    world.Timers.AddRange(manager.Timers.List(caller.Id).OfType<JsonObject>().Select(timer => (JsonObject)timer.DeepClone()));
                    await fired.Task.WaitAsync(TimeSpan.FromSeconds(10));
                    // Publication completes after the hook.
                    for (var attempt = 0; attempt < 100 && manager.Catalog.List().All(row => !SessionWait.Text(row["id"])!.EndsWith("/fired")); attempt++)
                        await System.Threading.Tasks.Task.Delay(50);
                }
                return result;
            },
            world.Roots
        );
        Assert.True(problems.Count == 0, name + ":\n" + string.Join("\n", problems));
    }
}
