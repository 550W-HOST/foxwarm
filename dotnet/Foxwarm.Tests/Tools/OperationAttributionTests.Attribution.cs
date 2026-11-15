using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class OperationAttributionTests
{
    // Attribution reports the decision, deciding layer and rule, secret outcome and approval
    // options of the existing evaluator, for global, local and external requests.
    [Fact]
    public void Attribution_reports_the_existing_evaluator_decision_rule_secrets_and_approval()
    {
        foreach (var item in Cases().OfType<JsonObject>())
        {
            if (item["kind"]?.GetValue<string>() == "creation-target")
                continue;
            var name = item["name"]!.GetValue<string>();
            var assessment = Assess(item);
            var view = EvaluatorView(item);
            var attribution = OperationAttribution.Of(assessment);
            Assert.True(view["decision"]!.GetValue<string>() == AuthorizationDecision.Name(attribution.Effect), name);
            var layers = view["layers"]!.AsArray().OfType<JsonObject>().ToArray();
            var deciding = layers.FirstOrDefault(layer => layer["decision"]!.GetValue<string>() == "deny")
                ?? layers.FirstOrDefault(layer => layer["decision"]!.GetValue<string>() == "ask");
            Assert.True(
                (deciding?["layer"]?.GetValue<string>())
                    == (attribution.Layer is null ? null : attribution.Layer.Layer is null ? "global" : "agent:" + attribution.Layer.Layer),
                name
            );
            Assert.True(
                deciding?["rule"]?.GetValue<string>() == attribution.Rule?["id"]?.GetValue<string>(),
                name
            );
            Assert.True(attribution.Default == (deciding is not null && deciding["rule"] is null), name);
            var secrets = (deciding ?? layers.FirstOrDefault(layer => layer["secrets"] is not null))?["secrets"];
            Assert.True(
                secrets?["decision"]?.GetValue<string>()
                    == (attribution.Secrets is { } decided ? AuthorizationDecision.Name(decided.Effect) : null),
                name
            );
            Assert.True(JsonNode.DeepEquals(view["approval"], attribution.Approval?.ToJson()), name);
            // The per-layer projection used by explanations names the same rules.
            for (var index = 0; index < layers.Length; index++)
            {
                var projected = OperationAttribution.Layer(assessment.Layers[index]);
                Assert.Equal(layers[index]["layer"]!.GetValue<string>(), projected["layer"]!.GetValue<string>());
                Assert.Equal(layers[index]["decision"]!.GetValue<string>(), projected["decision"]!.GetValue<string>());
                Assert.True(
                    layers[index]["rule"]?.GetValue<string>() == projected["rule"]?["id"]?.GetValue<string>(),
                    name
                );
            }
        }
    }

    private static JsonObject Case(string name) =>
        Cases().OfType<JsonObject>().Single(item => item["name"]!.GetValue<string>() == name);

    [Fact]
    public void Denial_attribution_names_the_rule_layer_capability_and_command()
    {
        var denied = Assess(Case("conditional ask denies other commands")).Denied!;
        var exec = new ResolvedTool("ctl", "node", "exec", new JsonObject { ["command"] = "rm" })
        {
            Command = "tool call",
        };
        Assert.Equal(
            "Rule `deny-exec` (#2) in the global policy denied `node:master/exec`, called as `ctl tool call`.",
            OperationAttribution.Denial(exec, exec, denied, null)
        );

        // A sub-request of the invocation names the declared obligation and the call it serves.
        var read = Assess(Case("script source read denied")).Denied!;
        var script = new ResolvedTool("run_script", "builtin", "run_script", new JsonObject { ["filePath"] = "job.py" });
        var source = new ResolvedTool("read", "node", "read", new JsonObject { ["filePath"] = "job.py" });
        Assert.Equal(
            "Rule `no-read` (#1) in the global policy denied the read of the script source file on its Node (`node:master/read`) for `builtin:run_script`, called as `run_script`.",
            OperationAttribution.Denial(source, script, read, null)
        );

        // A cascade member is the retained final request of the same capability.
        var member = Assess(Case("cascade member denied")).Denied!;
        var root = new ResolvedTool("ctl", "builtin", "node_remove", new JsonObject { ["nodeId"] = "box", ["cascade"] = true })
        {
            Command = "node remove",
        };
        var removal = root with { Args = new JsonObject { ["nodeId"] = "box-child", ["cascade"] = true } };
        Assert.Equal(
            "Rule `keep-child` (#1) in the global policy denied the per-member removal check of `builtin:node_remove`, called as `ctl node remove`.",
            OperationAttribution.Denial(removal, root, member, null)
        );
        Assert.EndsWith("called as `ctl node remove`.", OperationAttribution.Denial(removal, root, member, null));

        // The secret part names the secrets and the fallback; a default names its layer.
        var pair = Assess(Case("two single-name secret allows deny the pair")).Denied!;
        var setter = new ResolvedTool("set_config", "builtin", "set_config", new JsonObject());
        Assert.Equal(
            "Rule `no-master-exec` (#3) in the global policy denied the use of `key-a`, `key-b` by `builtin:set_config` through the unrestricted master exec fallback, called as `set_config`.",
            OperationAttribution.Denial(setter, setter, pair, ["key-a", "key-b"])
        );
        var local = Assess(Case("local layer denies what the global policy allows")).Denied!;
        Assert.StartsWith(
            "Rule `local-no-exec` (#1) in the rules of Agent `alpha` denied",
            OperationAttribution.Denial(exec, null, local, null)
        );
        var fallback = Assess(Case("correlated delivery to another Session is denied")).Denied!;
        var send = new ResolvedTool("send_file", "builtin", "send_file", new JsonObject(), ExecutionNode: "box");
        Assert.Equal(
            "The default action of the global policy denied `builtin:send_file`, called as `send_file`.",
            OperationAttribution.Denial(send, null, fallback, null)
        );
        var timer = new ResolvedTool("create_timer", "builtin", "create_timer", new JsonObject());
        Assert.Equal(
            "The rules of Agent `alpha` denied the create_session creation target (`builtin:create_session`) for `builtin:create_timer`, called as `create_timer`.",
            OperationAttribution.CreationTarget(timer, "alpha")
        );
        Assert.Equal(
            "no exec for beta. Rule x.",
            OperationAttribution.Append("no exec for beta", "Rule x.")
        );
    }

    [Fact]
    public void Attribution_maps_checks_to_declared_obligations()
    {
        var script = new ResolvedTool("run_script", "builtin", "run_script", new JsonObject { ["filePath"] = "a" });
        Assert.Null(OperationAttribution.Obligation(script, script));
        Assert.Null(OperationAttribution.Obligation(null, script));
        // An effect-owner recheck of the same request is the primary obligation.
        Assert.Null(OperationAttribution.Obligation(script, script with { }));
        Assert.Equal(
            "source-read",
            OperationAttribution.Obligation(script, new("read", "node", "read", new JsonObject()))!.Id
        );
        var timer = new ResolvedTool("create_timer", "builtin", "create_timer", new JsonObject());
        Assert.Equal(
            "output-spill",
            OperationAttribution.Obligation(timer, new("write", "node", "write", new JsonObject()))!.Id
        );
        var select = new ResolvedTool("ctl", "builtin", "node", new JsonObject { ["action"] = "select" });
        Assert.Equal(
            "default-cwd",
            OperationAttribution.Obligation(select, new("node", "node", "get_default_cwd", new JsonObject(), ExecutionNode: "box"))!.Id
        );
        Assert.Equal("ctl node select", OperationAttribution.Invocation(select with { Command = "node select" }));

        // Checks with the same capability are told apart by the file they read.
        var secret = new ResolvedTool(
            "add_secret",
            "builtin",
            "add_secret",
            new JsonObject { ["name"] = "k", ["filePath"] = "token.txt" }
        );
        ResolvedTool Read(string path) =>
            new("read", "node", "read", new JsonObject { ["filePath"] = path });
        Assert.Equal("file-read", OperationAttribution.Obligation(secret, Read("token.txt"))!.Id);
        Assert.Equal("config-read", OperationAttribution.Obligation(secret, Read("/c/config.yaml"))!.Id);
        var explain = new ResolvedTool(
            "explain_tool_authorization",
            "builtin",
            "explain_tool_authorization",
            new JsonObject { ["policyFilePath"] = "candidate.yaml" }
        );
        Assert.Equal("candidate-read", OperationAttribution.Obligation(explain, Read("candidate.yaml"))!.Id);
        Assert.Equal("policy-read", OperationAttribution.Obligation(explain, Read("/p/rules.yaml"))!.Id);
        Assert.Equal("run_script", OperationAttribution.Invocation(script));
    }
}
