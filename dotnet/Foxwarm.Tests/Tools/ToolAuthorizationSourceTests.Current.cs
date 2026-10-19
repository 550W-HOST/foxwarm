using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationSourceTests
{
    private static void AddCurrentPolicyFixtures(JsonArray fixtures, JsonObject normal)
    {
        var requests = new JsonArray();
        foreach (
            var session in new[]
            {
                "alpha/main",
                "alpha/child",
                "alpha/main-tail",
                "beta/main",
                "opaque",
            }
        )
        foreach (
            var targets in new string[][]
            {
                [],
                ["master"],
                ["one"],
                ["one", "two"],
                ["master", "one"],
                ["provider/node"],
            }
        )
        {
            var request = normal.DeepClone().AsObject();
            request["session"] = session;
            request["currentNode"] = "one";
            request["nodeTargets"] = new JsonArray(
                targets.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            );
            requests.Add(request);
            var external = request.DeepClone().AsObject();
            external["principal"] = "external";
            external.Remove("agent");
            external["externalId"] = "peer";
            requests.Add(external);
        }
        var unknown = normal.DeepClone().AsObject();
        unknown["projection"] = new JsonObject { ["nodeTargetsUnknown"] = true };
        requests.Add(unknown);
        foreach (
            var selector in new[]
            {
                "node: '*'",
                "node: one",
                "node: [master, one]",
                "node: {current: true}",
                "node: {provider: authenticated-remote}",
                "node: {provider: [master, authenticated-remote]}",
                "node: {provider: provider}",
                "session: 'alpha/*'",
                "session: 'alpha/*tail'",
                "session: '*a/*i*'",
                "session: ['*', opaque]",
            }
        )
        foreach (var action in new[] { "allow", "deny" })
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] =
                        $"version: 1\ndefaultAction: {(action == "allow" ? "deny" : "allow")}\nrules:\n- action: {action}\n  {selector}\n",
                    ["requests"] = requests.DeepClone(),
                }
            );
        foreach (
            var yaml in new[]
            {
                "rules: [{action: allow}, {id: rule-1, action: deny}]",
                "rules: [{action: allow, session: 'alpha/*', match: {}}]",
                "rules: [{action: allow, match: {node: one}}]",
                "rules: [{action: allow, match: {session: 'alpha/*'}}]",
                "rules: [{action: allow, node: {current: false}}]",
                "rules: [{action: allow, node: {current: true, provider: master}}]",
                "rules: [{action: allow, node: {provider: 'any*'}}]",
                "rules: [{action: allow, node: {provider: 'provider/node'}}]",
                "rules: [{action: allow, node: {provider: []}}]",
                "rules: [{action: allow, session: {equals: opaque}}]",
                "rules: [{action: allow, session: 'a?'}]",
                "rules: [{action: allow, session: ''}]",
                "rules: [{action: allow, node: []}]",
                "rules: [{action: allow, node: '" + new string('a', 513) + "'}]",
                "rules: [{action: allow, node: ["
                    + string.Join(',', Enumerable.Repeat("one", 65))
                    + "]}]",
            }
        )
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] = "version: 1\n" + yaml,
                    ["requests"] = requests.DeepClone(),
                }
            );

        var effects = new JsonArray();
        foreach (
            var (source, name, args) in new (string, string, string)[]
            {
                ("node", "read", "{}"),
                ("node", "node", "{\"nodeId\":\"two\"}"),
                (
                    "builtin",
                    "copy_between_nodes",
                    "{\"sourceNode\":\" one \",\"targetNode\":\"two\"}"
                ),
                (
                    "builtin",
                    "copy_between_nodes",
                    "{\"sourceNode\":\"one\",\"targetNode\":\"bad/node/path\"}"
                ),
                ("builtin", "send_file", "{}"),
                ("builtin", "image_write_to_file", "{}"),
                ("builtin", "node", "{\"action\":\" INSPECT \",\"nodeId\":\"two\"}"),
                ("builtin", "node", "{\"action\":\"select\",\"nodeId\":\"two\"}"),
                (
                    "builtin",
                    "node",
                    "{\"action\":\"inspect\",\"providerId\":\"provider\",\"nodeId\":\"two\"}"
                ),
                ("builtin", "node", "{\"action\":\"list\",\"nodeId\":\"two\"}"),
                ("builtin", "session", "{\"nodeId\":\"two\"}"),
                ("builtin", "run_script", "{\"node\":\"two\",\"filePath\":\"source.py\"}"),
                ("mcp", "read", "{\"nodeId\":\"two\"}"),
            }
        )
        {
            var request = normal.DeepClone().AsObject();
            request["tool"] = new JsonObject { ["source"] = source, ["name"] = name };
            request["args"] = Obj(args);
            request["targetNode"] = "one";
            request["currentNode"] = "two";
            request["resolveEffects"] = true;
            effects.Add(request);
        }
        foreach (
            var selector in new[]
            {
                "'*'",
                "one",
                "two",
                "{current: true}",
                "{provider: authenticated-remote}",
            }
        )
        foreach (var action in new[] { "allow", "deny" })
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] =
                        $"version: 1\ndefaultAction: {(action == "allow" ? "deny" : "allow")}\nrules: [{{action: {action}, node: {selector}}}]",
                    ["requests"] = effects.DeepClone(),
                }
            );

        var tasks = new JsonArray();
        foreach (var owner in new string?[] { null, "opaque", "other", "self" })
        foreach (var principal in new[] { "internal", "external" })
        {
            var request = normal.DeepClone().AsObject();
            request["tool"] = new JsonObject { ["source"] = "builtin", ["name"] = "task" };
            request["principal"] = principal;
            request["externalId"] = principal == "external" ? "peer" : null;
            request["args"] = Obj("{\"taskId\":\"existing\",\"ownerSessionId\":\"opaque\"}");
            request["taskTarget"] = new JsonObject { ["ownerSessionId"] = owner };
            tasks.Add(request);
        }
        foreach (
            var selector in new[]
            {
                "{source: builtin, name: task}",
                "task",
                "{source: builtin, name: [task]}",
                "{source: mcp, name: task}",
                "{source: builtin, name: task, server: peer}",
            }
        )
        foreach (
            var matcher in new[]
            {
                "{owned: true}",
                "{owned: false}",
                "{}",
                "{owned: true, other: true}",
            }
        )
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] =
                        $"version: 1\ndefaultAction: deny\nrules: [{{action: allow, tool: {selector}, args: {{taskId: {{task: {matcher}}}}}}}]",
                    ["requests"] = tasks.DeepClone(),
                }
            );
        fixtures.Add(
            new JsonObject
            {
                ["yaml"] =
                    "version: 1\nrules: [{action: allow, tool: {source: builtin, name: task}, args: {ownerSessionId: {task: {owned: true}}}}]",
            }
        );
    }
}
