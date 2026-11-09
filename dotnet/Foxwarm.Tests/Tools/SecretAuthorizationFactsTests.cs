using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Policy semantics of `secrets` facts: rules with a `secrets` selector decide them first; any
// other secret fact follows the caller's authorization for an unrestricted exec on master.
public sealed class SecretAuthorizationFactsTests
{
    private static ToolAuthorizationRequest SetConfig(
        string agent,
        IReadOnlyList<string>? secrets,
        string currentNode = "master"
    ) =>
        new(
            "builtin",
            "set_config",
            null,
            new JsonObject { ["target"] = "models", ["filePath"] = "models.yaml" },
            [],
            agent,
            agent + "/main",
            "master",
            ".",
            ".",
            ".",
            CurrentNode: currentNode,
            Secrets: secrets
        );

    private static ToolAuthorizationPolicy Global(string yaml) =>
        ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes(yaml));

    private static ToolAuthorizationPolicy Local(string json) =>
        AgentRulePolicy.Parse(JsonNode.Parse(json));

    private static ToolAuthorizationEffect Effect(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) => ToolAuthorizationEvaluation.Evaluate(policy, request).Effect;

    private static string ShippedTemplate(string name) =>
        File.ReadAllText(
            Path.Combine(
                AppContext.BaseDirectory,
                "skills",
                "agent-management",
                "references",
                "memory-templates",
                name
            )
        );

    [Fact]
    public void Unselected_secret_facts_follow_unrestricted_exec_on_master()
    {
        var facts = new[] { "provider-key" };
        // No rules: everything is allowed.
        Assert.Equal(
            ToolAuthorizationEffect.Allow,
            Effect(Global("version: 1\n"), SetConfig("worker", facts))
        );

        // A targeted deny of master exec denies that Agent's secret facts, not its call.
        var targeted = Global(
            """
            version: 1
            rules:
              - id: no-master-exec
                agent: worker
                tool: {source: node, name: exec}
                node: {exact: master}
                action: deny
            """
        );
        var denied = ToolAuthorizationEvaluation.Evaluate(targeted, SetConfig("worker", facts));
        Assert.Equal(ToolAuthorizationEffect.Deny, denied.Effect);
        Assert.Equal(ToolAuthorizationEffect.Allow, denied.Call!.Effect);
        Assert.Equal(ToolAuthorizationEffect.Deny, denied.Secrets!.Fallback!.Effect);
        Assert.Equal("no-master-exec", denied.Rule!["id"]!.GetValue<string>());
        Assert.Equal(ToolAuthorizationEffect.Allow, Effect(targeted, SetConfig("other", facts)));
        // The same call without secret facts is unaffected.
        Assert.Equal(ToolAuthorizationEffect.Allow, Effect(targeted, SetConfig("worker", null)));
        Assert.Equal(ToolAuthorizationEffect.Allow, Effect(targeted, SetConfig("worker", [])));

        // Ask on master exec makes secret facts ask.
        var asking = Global(
            """
            version: 1
            rules:
              - id: confirm-exec
                tool: {source: node, name: exec}
                action: ask
            """
        );
        var ask = ToolAuthorizationEvaluation.Evaluate(asking, SetConfig("worker", facts));
        Assert.Equal(ToolAuthorizationEffect.Ask, ask.Effect);
        Assert.Equal([asking.Value["rules"]![0]!.AsObject()], ask.AskingRules.ToArray());

        // Rules that depend on the command or cwd neither grant nor remove unrestricted exec:
        // the rule after them decides. Allowlists of commands or directories stay denied.
        foreach (
            var scoped in new[]
            {
                """
                    version: 1
                    defaultAction: deny
                    rules:
                      - {tool: {source: builtin, name: set_config}, action: allow}
                      - {tool: {source: node, name: exec}, args: {command: git status}, action: allow}
                    """,
                """
                    version: 1
                    defaultAction: deny
                    rules:
                      - {tool: {source: builtin, name: set_config}, action: allow}
                      - tool: {source: node, name: exec}
                        path: {arg: cwd, allWithin: '${agent.dir}'}
                        action: allow
                    """,
                """
                    version: 1
                    rules:
                      - {tool: {source: node, name: exec}, args: {command: git status}, action: allow}
                      - id: final-deny
                        action: deny
                    """,
            }
        )
        {
            var policy = Global(scoped);
            var decision = ToolAuthorizationEvaluation.Evaluate(policy, SetConfig("worker", facts));
            Assert.Equal(ToolAuthorizationEffect.Deny, decision.Secrets!.Effect);
            Assert.Equal(ToolAuthorizationEffect.Deny, decision.Effect);
            // The final rule, or the deny default when there is none.
            var finalDeny = policy.Value["rules"]!
                .AsArray()
                .OfType<JsonObject>()
                .FirstOrDefault(rule => SessionWait.Text(rule["id"]) == "final-deny");
            Assert.Same(finalDeny, decision.Secrets.Fallback!.Rule);
        }

        // A command or cwd deny or ask still leaves other commands available, so it does not
        // remove unrestricted exec under an allowing default.
        foreach (
            var scoped in new[]
            {
                """
                    version: 1
                    rules:
                      - {tool: {source: node, name: exec}, args: {command: rm -rf /}, action: deny}
                    """,
                """
                    version: 1
                    rules:
                      - {tool: {source: node, name: exec}, args: {command: reboot}, action: ask}
                    """,
                """
                    version: 1
                    rules:
                      - tool: {source: node, name: exec}
                        path: {arg: cwd, allWithin: /etc}
                        action: deny
                    """,
            }
        )
        {
            var decision = ToolAuthorizationEvaluation.Evaluate(
                Global(scoped),
                SetConfig("worker", facts)
            );
            Assert.Equal(ToolAuthorizationEffect.Allow, decision.Effect);
            Assert.Equal(ToolAuthorizationEffect.Allow, decision.Secrets!.Effect);
            Assert.Null(decision.Secrets.Fallback!.Rule);
        }

        // Exec allowed on every Node but master, then a selector-free deny.
        var otherNodes = Global(
            """
            version: 1
            rules:
              - {tool: {source: builtin, name: set_config}, action: allow}
              - {node: 'development/*', action: allow}
              - {action: deny}
            """
        );
        Assert.Equal(ToolAuthorizationEffect.Deny, Effect(otherNodes, SetConfig("worker", facts)));
    }

    [Fact]
    public void Secrets_selectors_decide_first_allow_covers_every_name_and_deny_matches_any()
    {
        var restricted = Global(
            """
            version: 1
            rules:
              - id: dev-secrets
                agent: worker
                secrets: {anyOf: ['dev-*', shared-token]}
                action: allow
              - id: no-master-exec
                agent: worker
                tool: {source: node, name: exec}
                node: {exact: master}
                action: deny
            """
        );
        Assert.Equal(
            ToolAuthorizationEffect.Allow,
            Effect(restricted, SetConfig("worker", ["dev-a", "shared-token"]))
        );
        var partial = ToolAuthorizationEvaluation.Evaluate(
            restricted,
            SetConfig("worker", ["dev-a", "prod-b"])
        );
        Assert.Equal(ToolAuthorizationEffect.Deny, partial.Effect);
        Assert.Null(partial.Secrets!.Rule);

        var protectedNames = Global(
            """
            version: 1
            rules:
              - id: prod-secrets
                secrets: {anyOf: 'prod-*'}
                action: deny
                reason: Production credentials are configured by the user.
            """
        );
        var deny = ToolAuthorizationEvaluation.Evaluate(
            protectedNames,
            SetConfig("worker", ["dev-a", "prod-b"])
        );
        Assert.Equal(ToolAuthorizationEffect.Deny, deny.Effect);
        Assert.Equal("prod-secrets", deny.Secrets!.Rule!["id"]!.GetValue<string>());
        Assert.Equal(
            ToolAuthorizationEffect.Allow,
            Effect(protectedNames, SetConfig("worker", ["dev-a"]))
        );
        // A secrets rule never decides a call without secret facts.
        Assert.Equal(
            ToolAuthorizationEffect.Allow,
            Effect(
                Global(
                    """
                    version: 1
                    rules:
                      - {secrets: {anyOf: '*'}, action: deny}
                    """
                ),
                SetConfig("worker", null)
            )
        );
        // Other selectors on a secrets rule narrow it like any rule.
        var scoped = Global(
            """
            version: 1
            defaultAction: deny
            rules:
              - {tool: {source: builtin, name: [set_config, mcp_config]}, action: allow}
              - {tool: {source: builtin, name: mcp_config}, secrets: {anyOf: '*'}, action: allow}
            """
        );
        Assert.Equal(ToolAuthorizationEffect.Deny, Effect(scoped, SetConfig("worker", ["a"])));
        Assert.Equal(
            ToolAuthorizationEffect.Allow,
            Effect(scoped, SetConfig("worker", ["a"]) with { Name = "mcp_config" })
        );
        // External principals never match secrets rules; their default deny applies.
        Assert.Equal(
            ToolAuthorizationEffect.Deny,
            Effect(
                Global(
                    """
                    version: 1
                    rules:
                      - {secrets: {anyOf: '*'}, action: allow}
                    """
                ),
                SetConfig("worker", ["a"]) with
                {
                    Principal = "external",
                    ExternalId = "client",
                    Agent = null,
                    Session = null,
                }
            )
        );
    }

    [Fact]
    public void Shipped_restricted_templates_deny_secret_facts_unless_a_secrets_rule_allows_them()
    {
        foreach (
            var name in new[] { "restricted-worker.rules.json", "channel-assistant.rules.json" }
        )
        {
            var template = JsonNode.Parse(ShippedTemplate(name))!.AsArray();
            // An administrator lets the Agent edit configuration; that alone sends no secret.
            var configTools = JsonNode.Parse(
                """{"tool":{"source":"builtin","name":["set_config","mcp_config"]},"action":"allow"}"""
            )!;
            var granted = new JsonArray([
                configTools.DeepClone(),
                .. template.Select(rule => rule?.DeepClone()),
            ]);
            foreach (var node in new[] { "master", "sandbox-1" })
            {
                var request = SetConfig("worker", ["dev-key"], node);
                var decision = ToolAuthorizationEvaluation.Evaluate(
                    AgentRulePolicy.Parse(granted),
                    request
                );
                Assert.Equal(ToolAuthorizationEffect.Allow, decision.Call!.Effect);
                Assert.Equal(ToolAuthorizationEffect.Deny, decision.Effect);
                Assert.Equal(
                    ToolAuthorizationEffect.Allow,
                    Effect(Local(granted.ToJsonString()), SetConfig("worker", null, node))
                );
            }
            var allowed = new JsonArray([
                JsonNode.Parse("""{"secrets":{"anyOf":["dev-*"]},"action":"allow"}"""),
                .. granted.Select(rule => rule?.DeepClone()),
            ]);
            Assert.Equal(
                ToolAuthorizationEffect.Allow,
                Effect(
                    AgentRulePolicy.Parse(allowed),
                    SetConfig("worker", ["dev-key"], "sandbox-1")
                )
            );
            Assert.Equal(
                ToolAuthorizationEffect.Deny,
                Effect(
                    AgentRulePolicy.Parse(allowed),
                    SetConfig("worker", ["prod-key"], "sandbox-1")
                )
            );
        }
    }

    [Fact]
    public void Secrets_selectors_are_validated()
    {
        var parsed = Global(
            """
            version: 1
            rules:
              - {secrets: {anyOf: dev-key}, action: allow}
            """
        );
        Assert.Equal(
            """{"anyOf":["dev-key"]}""",
            parsed.Value["rules"]![0]!["match"]!["secrets"]!.ToJsonString()
        );
        foreach (
            var invalid in new[]
            {
                "{secrets: dev-key, action: allow}",
                "{secrets: {anyOf: []}, action: allow}",
                "{secrets: {anyOf: [Dev-Key]}, action: allow}",
                "{secrets: {anyOf: ['dev key']}, action: allow}",
                "{secrets: {anyOf: [a], allOf: [b]}, action: allow}",
                "{externalId: client, secrets: {anyOf: [a]}, action: deny}",
                "{match: {secrets: {anyOf: [a]}}, action: deny}",
            }
        )
            Assert.ThrowsAny<InvalidDataException>(() =>
                Global("version: 1\nrules:\n  - " + invalid + "\n")
            );
        // A secrets allow grants the secrets, not the call.
        Assert.Equal(
            ToolAuthorizationEffect.Deny,
            Effect(
                Local("""[{"secrets":{"anyOf":["*"]},"action":"allow"},{"action":"deny"}]"""),
                SetConfig("worker", ["any-name"])
            )
        );
    }

    [Fact]
    public void Legacy_isolation_never_grants_secret_facts()
    {
        var isolation = new AgentIsolation(
            true,
            "sandbox-1",
            new JsonArray(
                JsonNode.Parse("""{"effect":"allow","source":"builtin","tool":"mcp_config"}""")
            )
        );
        var request = new ToolAuthorizationRequest(
            "builtin",
            "mcp_config",
            null,
            new JsonObject { ["name"] = "remote" },
            [],
            "isolated",
            "isolated/main",
            "master",
            ".",
            ".",
            "."
        );
        // The exact allow admits the call itself; isolation has no way to grant a secret.
        IsolatedToolCompatibility.Check(isolation, request, _ => null);
        var error = Assert.Throws<ToolAuthorizationDeniedException>(() =>
            IsolatedToolCompatibility.Check(
                isolation,
                request with
                {
                    Secrets = ["provider-key"],
                },
                _ => null
            )
        );
        Assert.Contains("`provider-key`", error.Message);
    }
}
