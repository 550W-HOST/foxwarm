using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Explaining a call's operations against a Provider-backed Node: no work the explained call's own
// assessment did not do, per-policy plans, and the handler's own default-cwd condition.
public sealed partial class ProviderFileConsumerTests
{
    private static async Task<JsonObject> ExplainAsync(Fixture f, JsonObject args) =>
        await f.Manager.ExplainToolAuthorizationAsync(f.Owner, new WorkspaceTools(f.Work), args, default);

    private static string[] Calls(Fixture f)
    {
        var log = Path.Combine(f.Target, "calls.jsonl");
        return File.Exists(log) ? File.ReadAllLines(log) : [];
    }

    private static JsonObject Entry(JsonNode variant, string id) =>
        variant["obligations"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(item => item["id"]!.GetValue<string>() == id);

    // A source read on a Node not yet admitted is reported unevaluated; explaining it runs
    // no Provider discovery and admits no Node metadata.
    [Fact]
    public async Task Explain_does_not_discover_or_admit_a_Provider_Node_for_an_obligation()
    {
        await using var f = await Fixture.Create();
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                $"version: 1\ndefaultAction: allow\nrules:\n- id: denied-script\n  tool: {{source: builtin, name: run_script}}\n  action: deny\n- id: denied-source\n  tool: {{source: node, name: read}}\n  node: {{exact: {f.Node}}}\n  action: deny\n"
            ),
            default
        );
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains(f.Node));
        var before = Calls(f);
        var result = await ExplainAsync(
            f,
            new JsonObject
            {
                ["probes"] = new JsonArray(
                    new JsonObject
                    {
                        ["sessionId"] = f.Owner.Id,
                        ["toolId"] = "builtin:run_script",
                        ["args"] = new JsonObject { ["filePath"] = "/root/code.py", ["node"] = f.Node },
                    }
                ),
            }
        );
        var probe = result["probes"]![0]!;
        Assert.Equal("deny", probe["active"]!["decision"]!.GetValue<string>());
        var read = Entry(probe["active"]!, "source-read");
        Assert.False(read["evaluated"]!.GetValue<bool>());
        Assert.Equal($"Node `{f.Node}` is not yet admitted", read["reason"]!.GetValue<string>());
        Assert.Equal(before, Calls(f));
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains(f.Node));
    }

    // Each policy variant has the plan its own facts give. The candidate policy allows the
    // candidate read, so its plan has the secret use; the active policy's is unknown, not empty.
    [Fact]
    public async Task Explain_compare_plans_each_policy_with_its_own_secret_facts()
    {
        await using var f = await Fixture.Create();
        f.Configuration.Secrets.Store.Set("review-key", "synthetic-review-value");
        var candidate = Path.Combine(f.Work, "models-candidate.yaml");
        await File.WriteAllTextAsync(
            candidate,
            "default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:2\n    apiKey: '${secret:review-key}'\n    models: [wire]\n"
        );
        var comparison = Path.Combine(f.Work, "candidate-rules.yaml");
        await File.WriteAllTextAsync(comparison, "version: 1\ndefaultAction: allow\nrules: []\n");
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                $"version: 1\ndefaultAction: allow\nrules:\n- id: no-candidate-read\n  tool: {{source: node, name: read}}\n  args: {{filePath: '{candidate}'}}\n  action: deny\n"
            ),
            default
        );
        var result = await ExplainAsync(
            f,
            new JsonObject
            {
                ["compare"] = true,
                ["policyFilePath"] = comparison,
                ["probes"] = new JsonArray(
                    new JsonObject
                    {
                        ["sessionId"] = f.Owner.Id,
                        ["toolId"] = "builtin:set_config",
                        ["args"] = new JsonObject { ["target"] = "models", ["filePath"] = candidate },
                    }
                ),
            }
        );
        var probe = result["probes"]![0]!;
        Assert.Equal("deny", Entry(probe["active"]!, "candidate-read")["decision"]!.GetValue<string>());
        Assert.Equal("allow", Entry(probe["candidate"]!, "candidate-read")["decision"]!.GetValue<string>());
        // The active plan, shown for the probe, does not know the secret facts.
        Assert.DoesNotContain(
            probe["operations"]!.AsArray(),
            item => item!["op"]!.GetValue<string>() == "secret.use"
        );
        var incomplete = probe["incomplete"]!.AsArray().Select(item => item!.GetValue<string>()).ToArray();
        Assert.Contains("secret.use: the secret facts are unknown", incomplete);
        Assert.Contains(
            "the candidate policy establishes different facts; its plan is in candidate.plan",
            incomplete
        );
        var use = probe["candidate"]!["plan"]!["operations"]!
            .AsArray()
            .Single(item => item!["op"]!.GetValue<string>() == "secret.use")!;
        Assert.Equal("review-key", use["resources"]!["secret"]!.GetValue<string>());
        Assert.Null(probe["candidate"]!["plan"]!["incomplete"]);
    }

    // Selecting a Provider Node never probes its default cwd, so explain lists no such
    // check; the real selection makes no get_default_cwd request either.
    [Fact]
    public async Task Explain_of_Provider_selection_lists_no_default_cwd_check()
    {
        await using var f = await Fixture.Create();
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\ndefaultAction: allow\nrules:\n- id: no-default-cwd\n  tool: {source: node, name: get_default_cwd}\n  action: deny\n"
            ),
            default
        );
        Assert.False(f.Manager.DefaultCwdProbe(f.Node));
        var probes = new JsonArray(
            new JsonObject { ["sessionId"] = f.Owner.Id, ["command"] = $"node select {f.Node}" }
        );
        var full = (await ExplainAsync(f, new JsonObject { ["probes"] = probes.DeepClone() }))["probes"]![0]!;
        Assert.DoesNotContain(
            full["obligations"]!.AsArray(),
            item => item!["id"]!.GetValue<string>() == "default-cwd"
        );
        var compact = (
            await ExplainAsync(f, new JsonObject { ["probes"] = probes.DeepClone(), ["compact"] = true })
        )["probes"]![0]!;
        Assert.Equal("allow", compact["decision"]!.GetValue<string>());
        Assert.Null(compact["obligation"]);
        var selected = await f.Call("node", new JsonObject { ["action"] = "select", ["nodeId"] = f.Node });
        Assert.Null(selected["error"]);
        Assert.DoesNotContain(await f.Requests(), request => request.ToJsonString().Contains("get_default_cwd"));
    }
}
