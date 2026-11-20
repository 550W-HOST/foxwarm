using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Explain additions never inspect master paths the probe did not, nor fail the probe; a
// creation target with unknown future facts is attributed to the rules that made it so.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static JsonObject ScriptProbe(string owner) =>
        Obj(
            "{\"probes\":[{\"sessionId\":\"" + owner + "\",\"toolId\":\"builtin:run_script\",\"args\":{\"filePath\":\"code.py\"}}]}"
        );

    private static JsonObject Obligation(JsonNode variant, string id) =>
        variant["obligations"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(item => item["id"]!.GetValue<string>() == id);

    // A policy root only an added obligation would inspect is never inspected: a symlink cycle
    // there neither fails the explanation nor becomes the obligation's reason.
    [Fact]
    public async Task Explain_additions_do_not_inspect_policy_roots_the_probe_did_not()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var cycle = Path.Combine(temp.Path, "policy-cycle");
        File.CreateSymbolicLink(cycle, cycle);
        Assert.Throws<IOException>(() => AuthorizationPaths.CanonicalPotential(cycle));
        await Policy(
            manager,
            $"version: 1\ndefaultAction: allow\nrules:\n- id: source-path\n  tool: {{source: node, name: read}}\n  args: {{filePath: code.py}}\n  path: {{allWithin: '{cycle}'}}\n  action: deny\n"
        );
        foreach (
            var probe in new[]
            {
                (await Explain(execution.Tools, ScriptProbe(owner.Id)))["probes"]![0]!,
                (
                    await manager.ExplainToolAuthorizationAsync(
                        owner,
                        execution.Files,
                        ScriptProbe(owner.Id),
                        default
                    )
                )["probes"]![0]!,
            }
        )
        {
            Assert.Null(probe["error"]);
            Assert.Equal("allow", probe["active"]!["decision"]!.GetValue<string>());
            var read = Obligation(probe["active"]!, "source-read");
            Assert.False(read["evaluated"]!.GetValue<bool>());
            Assert.Equal(
                $"its path facts are not established by the probe (`{cycle}`)",
                read["reason"]!.GetValue<string>()
            );
        }
    }

    // A root the probe's own assessment inspected is reused, so the addition is evaluated.
    [Fact]
    public async Task Explain_additions_reuse_roots_the_probe_inspected()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
              - id: script-root
                tool: {source: builtin, name: run_script}
                path: {allWithin: '${workspace}'}
                action: allow
              - id: source-root
                tool: {source: node, name: read}
                path: {allWithin: '${workspace}'}
                action: deny
            """
        );
        var probe = (await Explain(execution.Tools, ScriptProbe(owner.Id)))["probes"]![0]!;
        Assert.Equal("allow", probe["active"]!["decision"]!.GetValue<string>());
        var read = Obligation(probe["active"]!, "source-read");
        Assert.Equal("deny", read["decision"]!.GetValue<string>());
        Assert.Equal("source-root", read["layers"]![0]!["rule"]!["id"]!.GetValue<string>());
    }

    // The inspection record: recording keeps results, replay answers only from them and never
    // inspects; without a record, inspection is unchanged.
    [Fact]
    public void Path_inspection_replay_answers_only_recorded_paths()
    {
        using var temp = new TempDirectory();
        var known = Path.Combine(temp.Path, "known");
        var other = Path.Combine(temp.Path, "other");
        var record = new PathInspectionRecord();
        using (AuthorizationPaths.Inspecting(record, replay: false))
            Assert.Equal(known, AuthorizationPaths.CanonicalPotential(known));
        Assert.Equal([known], record.Inspected.Keys);
        using (AuthorizationPaths.Inspecting(record, replay: true))
        {
            Assert.Equal(known, AuthorizationPaths.CanonicalPotential(known));
            Assert.Throws<PathNotEstablishedException>(() => AuthorizationPaths.CanonicalPotential(other));
        }
        Assert.Single(record.Inspected);
        Assert.Equal(other, AuthorizationPaths.CanonicalPotential(other));
    }

    private const string RegistrationDeny =
        "Tool authorization rules deny creating a Session in Agent 'alpha'.";
    private const string RegistrationIndeterminate =
        "Future Session parameters make create_session target authorization indeterminate at timer registration. Place a decisive creation-target rule before rules depending on future names or settings.";
    private const string RegistrationAsk =
        "Tool authorization rules require approval to create Sessions in Agent 'alpha'. A scheduled creation can't be approved in advance, so this timer was not registered.";
    private const string TargetFor =
        "the create_session creation target (`builtin:create_session`)";
    private const string Conservative =
        ", depending on arguments known only when the Session is created, for `builtin:create_timer`, called as `create_timer`.";
    private const string Definite = " for `builtin:create_timer`, called as `create_timer`.";

    // A conditional rule (future Session name) followed by an unconditional rule or the allow
    // default. The registration outcome is unchanged; the attribution names only what
    // contributed the deny or ask, as definite or conservative.
    [Theory]
    [InlineData("allow", "allow", "allow", null, null, null)]
    [InlineData("allow", "default", "allow", null, null, null)]
    [InlineData("allow", "ask", "indeterminate", RegistrationIndeterminate, "Rule `unconditional-ask` (#2) in the global policy may require approval for " + TargetFor + Conservative, "unconditional-ask:ask")]
    [InlineData("allow", "deny", "indeterminate", RegistrationIndeterminate, "Rule `unconditional-deny` (#2) in the global policy may deny " + TargetFor + Conservative, "unconditional-deny:deny")]
    [InlineData("ask", "allow", "indeterminate", RegistrationIndeterminate, "Rule `future-ask` (#1) in the global policy may require approval for " + TargetFor + Conservative, "future-ask:ask")]
    [InlineData("ask", "ask", "ask", RegistrationAsk, "Rule `unconditional-ask` (#2) in the global policy requires approval for " + TargetFor + Definite, null)]
    [InlineData("ask", "deny", "deny", RegistrationDeny, "Rule `unconditional-deny` (#2) in the global policy denied " + TargetFor + Definite, null)]
    [InlineData("ask", "default", "indeterminate", RegistrationIndeterminate, "Rule `future-ask` (#1) in the global policy may require approval for " + TargetFor + Conservative, "future-ask:ask")]
    [InlineData("deny", "allow", "indeterminate", RegistrationIndeterminate, "Rule `future-deny` (#1) in the global policy may deny " + TargetFor + Conservative, "future-deny:deny")]
    [InlineData("deny", "ask", "deny", RegistrationDeny, "Rule `future-deny` (#1) in the global policy may deny " + TargetFor + Conservative, "future-deny:deny")]
    [InlineData("deny", "deny", "deny", RegistrationDeny, "Rule `unconditional-deny` (#2) in the global policy denied " + TargetFor + Definite, null)]
    [InlineData("deny", "default", "indeterminate", RegistrationIndeterminate, "Rule `future-deny` (#1) in the global policy may deny " + TargetFor + Conservative, "future-deny:deny")]
    public async Task Creation_targets_with_future_facts_name_only_contributing_rules(
        string unknown,
        string known,
        string decision,
        string? registration,
        string? attribution,
        string? conservative
    )
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var policy =
            $"version: 1\ndefaultAction: allow\nrules:\n- id: future-{unknown}\n  tool: {{source: builtin, name: create_session}}\n  args: {{sessionName: special}}\n  action: {unknown}\n";
        if (known != "default")
            policy +=
                $"- id: unconditional-{known}\n  tool: {{source: builtin, name: create_session}}\n  action: {known}\n";
        await Policy(manager, policy);
        var timer = Obj(
            """{"afterSeconds":3600,"message":"later","newSession":true,"agentName":"alpha"}"""
        );
        var probe = new JsonObject
        {
            ["probes"] = new JsonArray(
                new JsonObject
                {
                    ["sessionId"] = owner.Id,
                    ["toolId"] = "builtin:create_timer",
                    ["args"] = timer.DeepClone(),
                }
            ),
        };

        var full = Obligation(
            (await Explain(execution.Tools, (JsonObject)probe.DeepClone()))["probes"]![0]!["active"]!,
            "creation-target"
        );
        Assert.Equal(decision, full["decision"]!.GetValue<string>());
        var layer = full["layers"]![0]!.AsObject();
        probe["compact"] = true;
        var compact = (await Explain(execution.Tools, probe))["probes"]![0]!["obligation"];
        if (conservative is { } cause)
        {
            var (id, action) = (cause.Split(':')[0], cause.Split(':')[1]);
            var index = id.StartsWith("future-", StringComparison.Ordinal) ? 1 : 2;
            Assert.True(
                JsonNode.DeepEquals(
                    Obj(
                        $$"""{"layer":"global","decision":"{{decision}}","conservative":true,"rules":[{"index":{{index}},"id":"{{id}}","action":"{{action}}"}]}"""
                    ),
                    layer
                ),
                layer.ToJsonString()
            );
            Assert.True(
                JsonNode.DeepEquals(
                    Obj(
                        $$"""{"id":"creation-target","decision":"{{decision}}","conservative":true,"rules":["{{id}}"]}"""
                    ),
                    compact
                ),
                compact?.ToJsonString()
            );
        }
        else if (decision == "allow")
        {
            Assert.Null(compact);
            Assert.Null(layer["conservative"]);
        }
        else
        {
            // Definite: the stopping rule gives this outcome itself.
            Assert.Equal($"unconditional-{known}", layer["rule"]!["id"]!.GetValue<string>());
            Assert.Equal($"unconditional-{known}", compact!["rule"]!.GetValue<string>());
        }

        var response = await Call(execution.Tools, "create_timer", timer);
        if (registration is null)
        {
            Assert.Null(response["error"]);
            Assert.Single(manager.Timers.List(owner.Id));
        }
        else
        {
            Assert.Equal("tool_authorization_denied", Error(response));
            Assert.Equal(registration + " " + attribution, Message(response));
            Assert.Empty(manager.Timers.List(owner.Id));
        }
    }
}
