using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Operation rules through real dispatch (operation authorization phase 3): self exemption and
// its structural failures, the ToolScript model-request gate, approval staging, explanation,
// denial attribution, command help and the reader marker.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static void RegisterNode(
        SessionManager manager,
        (SessionToolExecutor Tools, WorkspaceTools Files, Foxwarm.McpClient Mcp, ToolRegistry Registry) execution
    )
    {
        var node = NodeToolDefinitions
            .All()
            .OfType<JsonObject>()
            .Single(item => item["name"]!.GetValue<string>() == "node");
        execution.Registry.Register(
            node,
            "builtin",
            false,
            (owner, args, token) => manager.ExecuteNodeToolAsync(owner.Hosted, args, token)
        );
    }

    private static string ScriptError(JsonObject response) =>
        response["error"] switch
        {
            JsonObject error => SessionWait.Text(error["message"]) ?? "",
            JsonNode other => other.ToString(),
            null => "",
        };

    [Fact]
    public async Task Self_calls_pass_valid_deny_layers_and_structural_failures_still_reject()
    {
        using var temp = new TempDirectory();
        await Seed(
            temp.Path,
            new JsonObject { ["rules"] = JsonNode.Parse("""[{"id":"rest","action":"deny"}]""") }
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, "version: 1\ndefaultAction: deny\nrules: []\n");
        // A fail-closed style layer and a deny default both pass self-scoped calls...
        Assert.Null(Error(await Call(execution.Tools, "list_toolscript_runs", Obj("{}"))));
        Assert.Null(Error(await Call(execution.Tools, "run_script", Obj("""{"code":"return 1"}"""))));
        // ...but not their obligations or nested calls.
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "run_script", Obj("""{"filePath":"job.py"}""")))
        );
        Assert.Contains(
            "denied",
            ScriptError(
                await Call(
                    execution.Tools,
                    "run_script",
                    Obj("""{"code":"return call_tool('read', {'filePath': 'x'})"}""")
                )
            )
        );
        // An unavailable policy rejects them.
        var policyPath = manager.Authorization.PolicyPath;
        await File.WriteAllTextAsync(policyPath, "version: 1\nrules: [{op: no.such, action: deny}]\n");
        manager.Authorization.Invalidate();
        Assert.Equal(
            ToolAuthorizationUnavailableException.Code,
            Error(await Call(execution.Tools, "list_toolscript_runs", Obj("{}")))
        );
    }

    [Fact]
    public async Task Self_calls_report_self_in_explain_and_stay_visible()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            "version: 1\nrules:\n- {id: explain, tool: {source: builtin, name: explain_tool_authorization}, action: allow}\n- {id: read, tool: {source: node, name: read}, action: allow}\n- {id: rest, action: deny}\n"
        );
        Assert.True(manager.ToolVisible(owner, "builtin", "artifact"));
        Assert.True(manager.ToolVisible(owner, "builtin", "wait"));
        Assert.False(manager.ToolVisible(owner, "builtin", "node"));
        var explained = JsonNode
            .Parse(
                SessionWait.Text(
                    (
                        await Call(
                            execution.Tools,
                            "explain_tool_authorization",
                            Obj("""{"probes":[{"sessionId":"self","toolId":"builtin:list_toolscript_runs","args":{}}]}""")
                        )
                    )["output"]
                )!
            )!
            .AsObject();
        var active = explained["probes"]![0]!["active"]!;
        Assert.Equal("allow", active["decision"]!.GetValue<string>());
        Assert.Equal("lists runs owned by the caller", active["self"]!.GetValue<string>());
    }

    [Fact]
    public async Task Script_model_requests_are_gated_as_the_slice_invocation()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        const string Script = """{"code":"return request_model_without_context('hi', 'missing')"}""";

        // A version-1 deny of the invocation keeps denying its model requests.
        await Policy(manager, "version: 1\nrules:\n- {id: no-scripts, tool: {source: builtin, name: run_script}, action: deny}\n");
        var denied = ScriptError(await Call(execution.Tools, "run_script", Obj(Script)));
        Assert.EndsWith(
            "Model request `missing` was not sent. Rule `no-scripts` (#1) in the global policy denied `builtin:run_script`, called as `run_script`.",
            denied
        );

        // An operation deny of model.request names the operation.
        await Policy(manager, "version: 1\nrules:\n- {id: no-models, op: model.request, model: missing, action: deny}\n");
        denied = ScriptError(await Call(execution.Tools, "run_script", Obj(Script)));
        Assert.Contains("Rule `no-models` (#1) in the global policy denied the operation `model.request` (model `missing`)", denied);

        // Allowed: the gate passes and the model error follows.
        await Policy(manager, "version: 1\nrules: []\n");
        Assert.Contains("Unknown model: missing", ScriptError(await Call(execution.Tools, "run_script", Obj(Script))));
    }

    [Fact]
    public async Task A_version1_ask_on_a_script_asks_once_per_slice_and_a_request_deny_still_applies()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        const string Twice = """{"code":"out = []\nfor model in ['missing', 'missing', 'other']:\n    try:\n        request_model_without_context('hi', model)\n    except RuntimeError as e:\n        out.append(str(e))\nreturn out"}""";

        await Policy(
            manager,
            "version: 1\nrules:\n- {id: no-other, op: model.request, model: other, action: deny}\n- {id: confirm, tool: {source: builtin, name: run_script}, action: ask}\n"
        );
        var call = Call(execution.Tools, "run_script", Obj(Twice));
        var pending = await PendingApprovalAsync(owner);
        await Approve(manager, owner, SessionWait.Text(pending["id"])!);
        var result = await call.WaitAsync(TimeSpan.FromSeconds(30));
        var text = result.ToJsonString();
        Assert.Equal(1, ApprovalCount(owner));
        Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(text, "Unknown model: missing").Count);
        Assert.Contains(
            "Model request \\u0060other\\u0060 was not sent. Rule \\u0060no-other\\u0060 (#1) in the global policy denied the operation \\u0060model.request\\u0060 (model \\u0060other\\u0060) of \\u0060builtin:run_script\\u0060, called as \\u0060run_script\\u0060.",
            text
        );

        // An operation ask on model.request asks for each request; an outer approval never
        // covers it.
        await Policy(
            manager,
            "version: 1\nrules:\n- {id: confirm-model, op: model.request, action: ask}\n"
        );
        call = Call(execution.Tools, "run_script", Obj("""{"code":"out = []\nfor model in ['missing', 'missing']:\n    try:\n        request_model_without_context('hi', model)\n    except RuntimeError as e:\n        out.append(str(e))\nreturn out"}"""));
        for (var index = 0; index < 2; index++)
        {
            pending = await PendingApprovalAsync(owner);
            await Approve(manager, owner, SessionWait.Text(pending["id"])!);
        }
        await call.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(3, ApprovalCount(owner));
    }

    [Fact]
    public async Task Op_rules_decide_real_calls_with_attribution_explain_and_staged_approval()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        RegisterNode(manager, execution);
        var workspace = Path.Combine(temp.Path, "workspace", "agents", owner.Agent);
        await File.WriteAllTextAsync(Path.Combine(workspace, "job.py"), "return 'ran'");
        await Policy(
            manager,
            "version: 1\nrules:\n- {id: no-select, op: node.select, action: deny}\n- {id: confirm-reads, op: env.read, path: {within: \"${workspace}\"}, action: ask, approval: {timeoutSeconds: 300}}\n"
        );

        // A raw spelling no longer bypasses the deny; the denial names the operation.
        var direct = await Call(execution.Tools, "node", Obj("""{"action":" Select","nodeId":"master"}"""));
        Assert.Equal("tool_authorization_denied", Error(direct));
        Assert.EndsWith(
            "Rule `no-select` (#1) in the global policy denied the operation `node.select` (node `master`) of `builtin:node`, called as `node`.",
            Message(direct)
        );
        // Help narrows to the commands that might be allowed.
        var help = SessionWait.Text((await Call(execution.Tools, "ctl", Obj("""{"command":"node --help"}""")))["output"])!;
        Assert.DoesNotContain("node select", help);
        Assert.Contains("node list", help);
        Assert.True(manager.ToolVisible(owner, "builtin", "node"));

        // The script file read asks once, at stage A, and the script runs after approval.
        var script = Call(execution.Tools, "run_script", Obj("""{"filePath":"job.py"}"""));
        var pending = await PendingApprovalAsync(owner);
        await Approve(manager, owner, SessionWait.Text(pending["id"])!);
        Assert.Null(Error(await script.WaitAsync(TimeSpan.FromSeconds(30))));
        Assert.Equal(1, ApprovalCount(owner));

        // Explain names op rules per operation and the version-1 winners as whole-call.
        await Policy(
            manager,
            "version: 1\nrules:\n- {id: v1-node, tool: {source: builtin, name: node}, action: allow}\n- {id: no-select, op: node.select, action: deny}\n"
        );
        var explained = JsonNode
            .Parse(
                SessionWait.Text(
                    (
                        await Call(
                            execution.Tools,
                            "explain_tool_authorization",
                            Obj("""{"probes":[{"sessionId":"self","command":"node select master"}]}""")
                        )
                    )["output"]
                )!
            )!
            .AsObject();
        var layer = explained["probes"]![0]!["active"]!["layers"]![0]!;
        var operation = layer["operations"]![0]!;
        Assert.Equal("node.select", operation["op"]!.GetValue<string>());
        Assert.Equal("whole-call", operation["rule"]!["ruleKind"]!.GetValue<string>());
        Assert.Equal("v1-node", operation["rule"]!["id"]!.GetValue<string>());
        Assert.Equal("no-select", operation["unreached"]![0]!["id"]!.GetValue<string>());
        Assert.Equal("operation", operation["unreached"]![0]!["ruleKind"]!.GetValue<string>());
    }

    [Fact]
    public async Task Unresolved_operations_are_rejected_before_dispatch()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            "version: 1\nrules:\n- {id: own-tree, op: session.view, targetSession: {session: {sameAgent: true}}, action: allow}\n- {id: views, op: session.view, action: deny}\n"
        );
        Assert.Null(Error(await Call(execution.Tools, "view_session", Obj("""{"sessionId":"kid"}"""))));
        var missing = await Call(execution.Tools, "view_session", Obj("""{"sessionId":"ghost"}"""));
        Assert.Equal("tool_authorization_unresolved", Error(missing));
        Assert.Equal(
            "Tool authorization can't establish the `targetSession` of the operation `session.view` (`builtin:view_session`, called as `view_session`), so rule `own-tree` (#1) in the global policy can't decide it. The call was not executed.",
            Message(missing)
        );
    }

    // Each call whose operations cannot be derived is also rejected by its handler, so the
    // unresolved rejection removes no supported call.
    [Fact]
    public async Task Derivation_failures_are_calls_the_handler_rejects()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        RegisterNode(manager, execution);
        await Policy(manager, "version: 1\nrules: []\n");
        foreach (
            var (tool, args) in new[]
            {
                ("node", """{"action":"teleport"}"""),
                ("node", """{"action":7}"""),
                ("session", """{"action":"explode"}"""),
                ("task", """{"action":"explode"}"""),
            }
        )
        {
            var resolved = execution.Registry.Resolve(tool, Obj(args));
            var operations = OperationPlan.AuthorizationOperations(
                resolved,
                null,
                new PlanContext("master")
            );
            Assert.True(
                Assert.Single(operations).Underivable is not null,
                $"{tool} {args}: {string.Join(", ", operations.Select(item => item.ToJson().ToJsonString()))}"
            );
            Assert.NotNull(Error(await Call(execution.Tools, tool, Obj(args))));
        }
    }

    [Fact]
    public async Task Operation_rules_raise_the_reader_marker_before_the_layer_is_written()
    {
        using var temp = new TempDirectory();
        var failMetadata = false;
        var catalog = new AgentCatalog(
            temp.Path,
            Path.Combine(temp.Path, "work"),
            canonicalLayout: true,
            metadataWriteStage: stage =>
            {
                if (failMetadata && stage == AtomicJsonWriteStage.BeforeRename)
                    throw new IOException("synthetic metadata failure");
            }
        );
        await catalog.CreateAsync("root");
        var marker = catalog.InstallationPath;
        int Level() =>
            File.Exists(marker)
                ? JsonNode.Parse(File.ReadAllText(marker))!["minimumReaderVersion"]!.GetValue<int>()
                : 0;
        var operation = JsonNode.Parse("""[{"id":"no-select","op":"node.select","action":"deny"}]""")!.AsArray();
        Assert.Equal(0, Level());
        // Version-1 rules need no marker.
        await catalog.SetRulesAsync("root", JsonNode.Parse("""[{"tool":"skill","action":"deny"}]""")!.AsArray());
        Assert.Equal(0, Level());

        // A failed metadata write after the marker leaves the higher marker and the old layer.
        failMetadata = true;
        await Assert.ThrowsAnyAsync<IOException>(() => catalog.SetRulesAsync("root", (JsonArray)operation.DeepClone()));
        Assert.Equal(2, Level());
        Assert.False(OperationRules.ContainsOperationRule(catalog.MetadataSnapshot()["root"]!["rules"]));
        failMetadata = false;

        // A failed marker write prevents the layer write.
        File.Delete(marker);
        Directory.CreateDirectory(marker);
        await Assert.ThrowsAnyAsync<Exception>(() => catalog.SetRulesAsync("root", (JsonArray)operation.DeepClone()));
        Assert.False(OperationRules.ContainsOperationRule(catalog.MetadataSnapshot()["root"]!["rules"]));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            catalog.CreateAsync("child", createdBy: "root", rules: (JsonArray)operation.DeepClone())
        );
        Assert.False(catalog.Exists("child"));
        Directory.Delete(marker);

        // Setter, creation with rules and the administrator route all raise it first.
        await catalog.CreateAsync("child", createdBy: "root", rules: (JsonArray)operation.DeepClone());
        Assert.Equal(2, Level());
        Assert.True(OperationRules.ContainsOperationRule(catalog.MetadataSnapshot()["child"]!["rules"]));

        using var managed = new TempDirectory();
        await Seed(managed.Path);
        await using (var manager = Manager(managed.Path))
        {
            await manager.LoadAsync();
            await manager.SetAgentRulesAsync("beta", (JsonArray)operation.DeepClone());
        }
        var managedMarker = Path.Combine(managed.Path, "data", "state", AgentCatalog.InstallationFileName);
        Assert.Equal(2, JsonNode.Parse(await File.ReadAllTextAsync(managedMarker))!["minimumReaderVersion"]!.GetValue<int>());
    }
}
