using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Timers;
using Foxwarm.Tools;
using static Foxwarm.Tests.OperationEffectConformance;

namespace Foxwarm.Tests;

// Self-tests of the differential conformance harness: real calls whose correct plans pass, and
// injected plan mistakes, each of which the harness must report.
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Differential_harness_reports_injected_plan_mistakes()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.CreateNamedAsync("alpha", "observer", null, null);
        var execution = TimerExecutor(manager, caller, temp.Path, MainLocalToolDefinitions.Definitions());
        await using var mcp = execution.Mcp;
        await Policy(manager, OperationEffectConformance.Policy);
        var work = manager.AgentDirectory("alpha");

        // Assesses and performs a real call; its own plan must pass.
        async Task<(Case Case, AuthorizationOperation[] Operations, List<Effect> Effects, Sources Sources)> Observe(
            string tool,
            JsonObject args
        )
        {
            var @case = new Case(tool, tool, args);
            var assessment = await manager.AssessToolAsync(caller, execution.Registry.Resolve(tool, args), execution.Files, default);
            Assert.Equal(ToolAuthorizationEffect.Allow, assessment.Effect);
            var operations = (assessment.Request.Operations ?? []).ToArray();
            var sources = ListSources(operations);
            var before = Take(manager, [], [work]);
            Assert.Null(Error(await Call(execution.Tools, tool, (JsonObject)args.DeepClone())));
            var effects = Diff(before, Take(manager, [], [work]), manager);
            Assert.Empty(Compare(@case, operations, effects, sources, caller.Id, caller.Agent, manager));
            return (@case, operations, effects, sources);
        }
        void Reports(string mistake, Case @case, IReadOnlyList<AuthorizationOperation> operations, List<Effect> effects, Sources sources) =>
            Assert.True(
                Compare(@case, operations, effects, sources, caller.Id, caller.Agent, manager).Count > 0,
                mistake + " was accepted"
            );

        var source = Path.Combine(work, "observed.txt");
        var write = await Observe("write", new JsonObject { ["filePath"] = source, ["content"] = "write-bytes" });
        Reports(
            "a write declared on the wrong Node",
            write.Case,
            write
                .Operations.Select(operation =>
                    operation.Op != "env.write"
                        ? operation
                        : operation with
                        {
                            Resources = new JsonObject { ["node"] = "wrong-node", ["path"] = operation.Resources["path"]!.DeepClone() },
                            Path = operation.Path! with { Node = "wrong-node" },
                        }
                )
                .ToArray(),
            write.Effects,
            write.Sources
        );

        var copy = await Observe(
            "copy_between_nodes",
            new JsonObject
            {
                ["sourceNode"] = "master",
                ["sourcePath"] = source,
                ["targetNode"] = "master",
                ["targetPath"] = Path.Combine(work, "copied.txt"),
            }
        );
        Reports("a copy without its read leg", copy.Case, copy.Operations.Where(operation => operation.Op != "env.read").ToArray(), copy.Effects, ListSources([]));
        Reports("a copy of a nonempty source that wrote nothing", copy.Case, copy.Operations, [], copy.Sources);
        var never = Path.Combine(work, "never-written");
        var extra = copy.Operations.Single(operation => operation.Op == "env.write") with
        {
            Resources = new JsonObject { ["node"] = "master", ["path"] = never },
            Path = new AuthorizationPath("extra", never, never, "master", true),
        };
        Reports("an unwritten additional destination", copy.Case, copy.Operations.Append(extra).ToArray(), copy.Effects, copy.Sources);
        var otherSource = copy.Operations.Single(operation => operation.Op == "env.read") with
        {
            Path = new AuthorizationPath("sourcePath", Path.Combine(work, "elsewhere.txt"), Path.Combine(work, "elsewhere.txt"), "master", true),
        };
        Reports(
            "a copy declared from another source",
            copy.Case,
            copy.Operations.Select(operation => operation.Op == "env.read" ? otherSource : operation).ToArray(),
            copy.Effects,
            ListSources([otherSource])
        );

        // Agent metadata changes are observed and must be declared.
        var inherit = await Observe("set_agent_inherit", Obj("""{"agentName":"beta","inheritAgentName":"alpha"}"""));
        Assert.Contains(inherit.Effects, effect => effect.Op == "agent.manage");
        Reports("a metadata change with an empty plan", inherit.Case, [], inherit.Effects, inherit.Sources);
        Reports(
            "an inheritance declared as a view of another spelling",
            inherit.Case,
            inherit
                .Operations.Select(operation =>
                    operation.Op != "agent.view"
                        ? operation
                        : operation with { Resources = new JsonObject { ["targetAgent"] = " alpha " } }
                )
                .ToArray(),
            inherit.Effects,
            inherit.Sources
        );
        Reports(
            "an inheritance without its view",
            inherit.Case,
            inherit.Operations.Where(operation => operation.Op != "agent.view").ToArray(),
            inherit.Effects,
            inherit.Sources
        );

        // A Session parented to the caller is its child.
        var child = await Observe(
            "create_session",
            new JsonObject { ["agentName"] = "alpha", ["sessionName"] = "attached", ["parentSessionId"] = caller.Id }
        );
        Reports(
            "a caller-parented Session declared not a child",
            child.Case,
            child
                .Operations.Select(operation =>
                {
                    if (operation.Op != "session.create")
                        return operation;
                    var resources = (JsonObject)operation.Resources.DeepClone();
                    resources["targetSession"]!["child"] = false;
                    return operation with { Resources = resources };
                })
                .ToArray(),
            child.Effects,
            child.Sources
        );
    }

    // A probe's expectation comes from the case, not from state the call writes: a handler that
    // acted on another target fails.
    [Fact]
    public async Task Differential_probes_do_not_follow_the_handler()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadMainHostAsync();
        var caller = await manager.CreateNamedAsync("alpha", "timer-caller", null, null);
        var execution = TimerExecutor(manager, caller, temp.Path, MainLocalToolDefinitions.Definitions());
        await using var mcp = execution.Mcp;
        await Policy(manager, OperationEffectConformance.Policy);
        var published = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        manager.TimerSessionName = _ => "wrong-target";
        manager.BeforeCreationPublication = id =>
        {
            if (id.EndsWith("/wrong-target", StringComparison.Ordinal))
                published.TrySetResult();
            return System.Threading.Tasks.Task.CompletedTask;
        };
        var @case = new Case(
            "registration for beta, performed for alpha",
            "create_timer",
            Obj("""{"afterSeconds":1,"message":"fire","newSession":true,"agentName":"beta"}"""),
            Deferred: ["session.create:node"],
            Probes: TimerCreationTarget
        );
        var problems = await Run(
            @case,
            manager,
            caller,
            (tool, args) => manager.AssessToolAsync(caller, execution.Registry.Resolve(tool, args), execution.Files, default),
            async (tool, args) =>
            {
                // The injected mistake: the handler receives another creation target.
                args["agentName"] = "alpha";
                var result = await Call(execution.Tools, tool, args);
                await published.Task.WaitAsync(TimeSpan.FromSeconds(10));
                for (var attempt = 0; attempt < 100 && manager.Catalog.Get("alpha/wrong-target") is null; attempt++)
                    await System.Threading.Tasks.Task.Delay(25);
                return result;
            },
            [Path.Combine(temp.Path, "workspace")]
        );
        Assert.NotNull(manager.Catalog.Get("alpha/wrong-target"));
        Assert.NotEmpty(problems);
    }
}
