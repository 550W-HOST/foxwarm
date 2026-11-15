using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// Version-1 decision equality for operation rules (operation authorization phase 3): real calls,
// capability visibility and command help under version-1-only global and Agent-local policies
// decide exactly as at the base revision, except for the changes phase 3 schedules. The fixture
// holds the outcomes recorded at the base; FOXWARM_V1_CORPUS_OUT writes the outcomes of the
// current build instead of comparing them. This file compiles at the base revision unchanged.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static readonly (string Name, string Yaml, string? Local)[] Version1Policies =
    [
        ("empty", "version: 1\nrules: []\n", null),
        (
            "deny-default",
            "version: 1\ndefaultAction: deny\nrules:\n- {id: files, tool: {source: node, name: [read, write]}, action: allow}\n",
            null
        ),
        (
            "deny-scripts",
            "version: 1\nrules:\n- {id: no-scripts, tool: {source: builtin, name: [run_script, start_toolscript_run, continue_script, list_toolscript_runs, get_toolscript_run, cancel_toolscript_run]}, action: deny}\n",
            null
        ),
        (
            "deny-self-tools",
            "version: 1\nrules:\n- {id: no-self, tool: {source: builtin, name: [artifact, submit_compact_plan, cancel_transfer, image_crop, wait]}, action: deny}\n",
            null
        ),
        (
            "deny-node-select-raw",
            "version: 1\nrules:\n- {id: no-select, tool: {source: builtin, name: node}, args: {action: {equals: select}}, action: deny}\n",
            null
        ),
        (
            "node-list-only",
            "version: 1\nrules:\n- {id: list, tool: {source: builtin, name: node}, args: {action: {equals: list}}, action: allow}\n- {id: no-node, tool: {source: builtin, name: node}, action: deny}\n- {id: session-status, tool: {source: builtin, name: session}, args: {action: {equals: status}}, action: allow}\n- {id: no-session, tool: {source: builtin, name: session}, action: deny}\n",
            null
        ),
        (
            "ask-exec-deny-read",
            "version: 1\nrules:\n- {id: confirm-exec, tool: {source: node, name: exec}, action: ask}\n- {id: no-read, tool: {source: node, name: read}, action: deny}\n",
            null
        ),
        (
            "local-deny-all",
            "version: 1\nrules: []\n",
            """[{"id":"files","tool":{"source":"node","name":["read","write"]},"action":"allow"},{"id":"rest","action":"deny"}]"""
        ),
        (
            "local-deny-scripts",
            "version: 1\nrules: []\n",
            """[{"id":"no-scripts","tool":{"source":"builtin","name":["run_script","list_toolscript_runs"]},"action":"deny"}]"""
        ),
    ];

    private static readonly (string Name, string Tool, string Args)[] Version1Calls =
    [
        ("write", "write", """{"filePath":"out.txt","content":"x"}"""),
        ("read", "read", """{"filePath":"seed.txt"}"""),
        ("script-inline", "run_script", """{"code":"return 1"}"""),
        ("script-nested-read", "run_script", """{"code":"return call_tool('read', {'filePath': 'seed.txt'})"}"""),
        ("script-file", "run_script", """{"filePath":"job.py"}"""),
        ("script-model", "run_script", """{"code":"return request_model_without_context('hi', 'missing')"}"""),
        ("runs-list", "list_toolscript_runs", "{}"),
        ("run-get", "get_toolscript_run", """{"runId":"tsr_missing"}"""),
        ("transfer-cancel", "cancel_transfer", """{"transferId":"missing"}"""),
        ("node-list", "ctl", """{"command":"node list"}"""),
        ("node-select-spelled", "node", """{"action":" Select","nodeId":"master"}"""),
        ("session-default", "session", "{}"),
        ("session-status", "ctl", """{"command":"session status"}"""),
        ("task-list", "task", """{"action":"list"}"""),
        ("view", "view_session", """{"sessionId":"opaque"}"""),
    ];

    private static readonly string[] Version1Visible =
    [
        "run_script",
        "start_toolscript_run",
        "continue_script",
        "list_toolscript_runs",
        "artifact",
        "submit_compact_plan",
        "cancel_transfer",
        "image_crop",
        "wait",
        "node",
        "session",
        "task",
        "view_session",
        "create_session",
    ];

    private static readonly string[] Version1Help = ["node --help", "session --help", "script --help"];

    [Fact]
    public async Task Version1_policies_decide_as_at_the_base_revision_except_scheduled_changes()
    {
        var outcomes = new JsonObject();
        foreach (var (policyName, yaml, local) in Version1Policies)
        {
            using var temp = new TempDirectory();
            await Seed(
                temp.Path,
                local is null ? null : new JsonObject { ["rules"] = JsonNode.Parse(local) }
            );
            await using var manager = Manager(temp.Path);
            await manager.LoadAsync();
            var caller = await manager.RequiredAsync(local is null ? "foreign" : "opaque");
            var execution = TimerExecutor(manager, caller, temp.Path);
            await using var mcp = execution.Mcp;
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
            var workspace = Path.Combine(temp.Path, "workspace", "agents", caller.Agent);
            await File.WriteAllTextAsync(Path.Combine(workspace, "seed.txt"), "seed");
            await File.WriteAllTextAsync(Path.Combine(workspace, "job.py"), "return 'ran'");
            await Policy(manager, yaml);
            var row = new JsonObject();
            foreach (var (callName, tool, args) in Version1Calls)
            {
                var call = Call(execution.Tools, tool, Obj(args));
                string outcome;
                try
                {
                    outcome = Version1Outcome(
                        await call.WaitAsync(TimeSpan.FromSeconds(20)),
                        temp.Path
                    );
                }
                catch (TimeoutException)
                {
                    outcome = "waiting";
                    foreach (
                        var pending in caller.Entry.WithState(state =>
                            SessionApprovals
                                .Pending(state.Meta)
                                .Select(record => SessionWait.Text(record["id"])!)
                                .ToArray()
                        )
                    )
                        await manager.DecideToolApprovalAsync(
                            caller,
                            pending,
                            false,
                            null,
                            new JsonObject { ["kind"] = "administrator" }
                        );
                    await call;
                }
                row[callName] = outcome;
            }
            foreach (var name in Version1Visible)
                row["visible:" + name] = manager.ToolVisible(caller, "builtin", name);
            foreach (var command in Version1Help)
                row["help:" + command] = Version1Outcome(
                    await Call(execution.Tools, "ctl", new JsonObject { ["command"] = command }),
                    temp.Path
                );
            outcomes[policyName] = row;
        }
        var output = Environment.GetEnvironmentVariable("FOXWARM_V1_CORPUS_OUT");
        if (!string.IsNullOrEmpty(output))
        {
            await File.WriteAllTextAsync(
                output,
                outcomes.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n"
            );
            return;
        }
        var fixture = JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", "version1-equality.json")
                )
            )!
            .AsObject();
        var scheduled = fixture["scheduled"]!.AsObject();
        var differences = new List<string>();
        foreach (var (policyName, row) in outcomes)
        foreach (var (key, value) in row!.AsObject())
        {
            var at = policyName + " / " + key;
            var expected = scheduled[at] is { } change ? change["now"] : fixture["outcomes"]![policyName]![key];
            if (!JsonNode.DeepEquals(expected, value))
                differences.Add($"{at}: expected {expected?.ToJsonString()}, now {value?.ToJsonString()}");
        }
        // Every scheduled change is a real change from the base.
        foreach (var (at, change) in scheduled)
        {
            var separator = at.IndexOf(" / ", StringComparison.Ordinal);
            Assert.False(
                JsonNode.DeepEquals(
                    change!["now"],
                    fixture["outcomes"]![at[..separator]]![at[(separator + 3)..]]
                ),
                $"{at} is listed as scheduled but did not change"
            );
        }
        Assert.True(differences.Count == 0, string.Join("\n", differences));
    }

    private static string Version1Outcome(JsonObject response, string root)
    {
        string text;
        if (response["error"] is JsonObject error)
            text =
                SessionWait.Text(error["type"])
                + ": "
                + (SessionWait.Text(error["message"]) ?? "");
        else if (response["error"] is JsonValue scripted)
            text = "script-error: " + scripted.ToString();
        else if (SessionWait.Text(response["output"]) is { } output)
            text = "ok: " + output;
        else
            text = "ok";
        text = text.Replace(root, "<root>", StringComparison.Ordinal);
        text = Regex.Replace(text, "\\b(ap|tmr|tsr)[-_][A-Za-z0-9]+", "$1-<id>");
        return text.Length > 600 ? text[..600] : text;
    }
}
