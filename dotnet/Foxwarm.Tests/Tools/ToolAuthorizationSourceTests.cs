using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationSourceTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();

    private static ToolAuthorizationRequest Request(JsonObject source, string root)
    {
        var tool = source["tool"]!.AsObject();
        var target = source["sessionTargets"]?["sessionId"] as JsonObject;
        return new(
            tool["source"]!.GetValue<string>(),
            tool["name"]!.GetValue<string>(),
            source["tool"]?["server"]?.GetValue<string>(),
            (source["args"] as JsonObject ?? new()).DeepClone().AsObject(),
            (source["paths"] as JsonArray ?? [])
                .Select(path => new AuthorizationPath(
                    path!["arg"]!.GetValue<string>(),
                    path["raw"]!.GetValue<string>(),
                    path["resolved"]?.GetValue<string>(),
                    path["targetNode"]!.GetValue<string>()
                ))
                .ToArray(),
            source["agent"]?.GetValue<string>(),
            source["session"]?.GetValue<string>(),
            source["targetNode"]?.GetValue<string>(),
            Path.Combine(root, "workspace"),
            Path.Combine(root, "workspace", "agents", "alpha"),
            Path.Combine(root, "workspace", "agents", "alpha", "memory"),
            source["sourceParentSessionId"]?.GetValue<string>(),
            target is null
                ? null
                : new(
                    target["id"]!.GetValue<string>(),
                    target["agent"]!.GetValue<string>(),
                    target["parentSessionId"]?.GetValue<string>()
                ),
            source["principal"]!.GetValue<string>(),
            source["externalId"]?.GetValue<string>(),
            source["taskTarget"]?["ownerSessionId"]?.GetValue<string>(),
            source["resolveEffects"]?.GetValue<bool>() == true
                ? ToolAuthorizationNodeEffects.Resolve(
                    tool["source"]!.GetValue<string>(),
                    tool["name"]!.GetValue<string>(),
                    source["targetNode"]?.GetValue<string>(),
                    source["args"]!.AsObject()
                )
                : (source["nodeTargets"] as JsonArray)
                    ?.Select(value => value!.GetValue<string>())
                    .ToArray(),
            source["currentNode"]?.GetValue<string>()
        );
    }

    [Fact]
    public async Task Actual_source_policy_parser_ordered_evaluation_visibility_target_families_and_legacy_metadata_differential()
    {
        using var temp = new TempDirectory();
        var fixtures = new JsonArray();
        var sourceRoot =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Source checkout is required.");
        var normal = Obj(
            """{"principal":"internal","agent":"alpha","session":"opaque","tool":{"source":"node","name":"read"},"targetNode":"master","args":{"filePath":"own","a":null,"list":[1,2]},"paths":[]}"""
        );
        var cases = new List<string>
        {
            "",
            "null",
            "[]",
            "version: 1",
            "version: 1\nrules: []",
            "version: true",
            "version: '1'",
            "version: 1\ndefaultAction: null",
            "version: 1\nrules: null",
            "version: 1\nextra: {}",
            "version: 1\nversion: 1",
            "version: 1\n---\nversion: 1",
        };
        foreach (
            var scalar in new[]
            {
                "read",
                "' read '",
                "!!str true",
                "! true",
                "null",
                "true",
                "1_",
                "0o9",
                "-.2",
                ".inf",
                ".NaN",
                "1e999",
                "2026-10-03",
                "!!binary YQ==",
                "!!int true",
                "!!bool null",
                "!!float 0xff",
                "!!int 0_1",
                "!!float ._e3",
                "!unknown a",
            }
        )
            cases.Add("version: 1\nrules: [{id: " + scalar + ", action: allow}]");
        foreach (
            var tool in new[]
            {
                "read",
                "[read, write]",
                "{}",
                "null",
                "{name: read, source: node}",
                "{source: {exists: false}}",
                "{source: [node, mcp], name: {oneOf: [read, echo]}}",
                "{source: [node, invalid]}",
                "{source: mcp, name: update_session_snapshot}",
                "update_session_snapshot",
                "{source: builtin, name: {oneOf: [refresh_session_snapshot, update_session_snapshot]}}",
            }
        )
            cases.Add("version: 1\nrules: [{id: one, action: deny, match: {tool: " + tool + "}}]");
        foreach (
            var match in new[]
            {
                "{a: null}",
                "{a: {equals: null}}",
                "{a: {exists: false}}",
                "{a: {equals: null, exists: false}}",
                "{a: {oneOf: [1, true, null, '']}}",
                "{a: []}",
                "{a: {oneOf: []}}",
                "{a: {oneOf: {oneOf: []}}}",
                "{a: {bad: true}}",
                "{a: .inf}",
                "{a: 2026-10-03}",
                "{a: !!set {equals: null}}",
                "{list.length: 2}",
                "{list.0: 1}",
                "{list.00: {exists: false}}",
                "{__proto__: true}",
                "{a.constructor: 1}",
            }
        )
            cases.Add("version: 1\nrules: [{id: one, action: deny, match: {args: " + match + "}}]");
        foreach (
            var names in new[]
            {
                "send_to_session",
                "recall",
                "get_session_messages",
                "[get_archived_messages, get_archived_blocks]",
                "[create_timer, delete_timer]",
                "[recall, send_to_session]",
                "delete_session",
                "[read, write]",
                "{equals: recall}",
            }
        )
        foreach (
            var relation in new[]
            {
                "{self: true}",
                "{sameAgent: false}",
                "{relation: [parent, child]}",
                "{relation: [parent, parent]}",
                "{relation: []}",
            }
        )
            cases.Add(
                "version: 1\nrules: [{id: one, action: allow, match: {tool: {source: builtin, name: "
                    + names
                    + "}, args: {sessionId: {session: "
                    + relation
                    + "}}}}]"
            );
        cases.AddRange([
            "version: 1\nrules: [&r {id: one, action: allow, <<: *r}]",
            "version: 1\nrules: [{id: one, action: allow, match: &m {tool: read, <<: *m}}]",
            "version: 1\nrules: [&r {match: {<<: *r}, id: one, action: allow}]",
            "version: 1\nrules: [&r {id: one, match: {<<: *r}, action: allow}]",
            "version: 1\nrules: [{id: one, action: allow, match: {args: {<<: [[null, 2]]}}}]",
            "version: 1\nrules: [{id: one, action: allow, match: {args: {? [a, b] : true}}}]",
            "version: 1\nrules: [{id: one, action: allow, match: {args: {? [[a], b] : true}}}]",
            "version: 1\nrules: [{id: one, action: allow, match: {args: {.inf: true, True: null, 01: true, 2026-10-03: false, !!binary YQ==: true}}}]",
            "version: 1\nrules: [{id: one, action: allow, match: {args: {a: &a {equals: *a}}}}]",
            "version: 1\nrules: !!omap []",
            "version: 1\nrules: !!pairs []",
            "version: 1\nrules: ! []",
            "version: 1\nrules: [{id: one, action: allow, match: {path: {allWithin: '${agent.dir}'}}}]",
            "version: 1\nrules: [{id: one, action: allow, match: {path: {arg: [filePath, input], anyNotWithin: '${workspace}'}}}]",
            "version: 1\nrules: [{id: one, action: allow, match: {path: {allWithin: '${other.dir}'}}}]",
            "version: 1\nrules: [{id: one, action: allow}, {id: ' one ', action: deny}]",
            "version: 1\nrules: [{id: one, action: allow, reason: ''}]",
        ]);
        foreach (var yaml in cases)
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] = yaml,
                    ["requests"] = new JsonArray(
                        normal.DeepClone(),
                        Obj(
                            """{"principal":"external","externalId":"future","tool":{"source":"mcp","name":"read","server":"peer"},"targetNode":"master","args":{},"paths":[]}"""
                        )
                    ),
                }
            );
        AddCurrentPolicyFixtures(fixtures, normal);
        var own = Path.Combine(temp.Path, "workspace", "agents", "alpha");
        Directory.CreateDirectory(own);
        foreach (var condition in new[] { "allWithin", "anyNotWithin" })
        {
            var requests = new JsonArray();
            foreach (
                var paths in new[]
                {
                    Array.Empty<string?>(),
                    new string?[] { Path.Combine(own, "new", "file") },
                    new string?[]
                    {
                        Path.Combine(own, "file"),
                        Path.Combine(temp.Path, "workspace", "elsewhere"),
                    },
                    new string?[] { null },
                }
            )
            {
                var request = normal.DeepClone().AsObject();
                request["paths"] = new JsonArray(
                    paths
                        .Select(path =>
                            (JsonNode?)
                                new JsonObject
                                {
                                    ["arg"] = "filePath",
                                    ["raw"] = path ?? "unresolved",
                                    ["resolved"] = path,
                                    ["targetNode"] = "master",
                                }
                        )
                        .ToArray()
                );
                requests.Add(request);
            }
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] =
                        "version: 1\ndefaultAction: deny\nrules: [{id: path, action: allow, match: {path: {"
                        + condition
                        + ": '${agent.dir}'}}}]",
                    ["requests"] = requests,
                }
            );
        }
        foreach (
            var relation in new[]
            {
                "{self: true}",
                "{sameAgent: true}",
                "{relation: parent}",
                "{relation: child}",
                "{relation: [parent, child]}",
            }
        )
        {
            var requests = new JsonArray();
            foreach (
                var (id, agent, parent) in new[]
                {
                    ("opaque", "alpha", (string?)null),
                    ("parent", "alpha", (string?)null),
                    ("direct", "alpha", "opaque"),
                    ("foreign", "beta", "opaque"),
                }
            )
            {
                var request = normal.DeepClone().AsObject();
                request["tool"] = new JsonObject
                {
                    ["source"] = "builtin",
                    ["name"] = "send_to_session",
                };
                request["sourceParentSessionId"] = "parent";
                request["sessionTargets"] = new JsonObject
                {
                    ["sessionId"] = new JsonObject
                    {
                        ["id"] = id,
                        ["agent"] = agent,
                        ["parentSessionId"] = parent,
                    },
                };
                requests.Add(request);
            }
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] =
                        "version: 1\ndefaultAction: deny\nrules: [{id: target, action: allow, match: {tool: {source: builtin, name: send_to_session}, args: {sessionId: {session: "
                        + relation
                        + "}}}}]",
                    ["requests"] = requests,
                }
            );
        }
        foreach (
            var scalar in new[]
            {
                "0xffffffffffffffff",
                "0x1fffffffffffff1",
                "0x200000000000001",
                "0b101010101010101010101010101010101010101010101010101010101",
                "0o77777777777777777777",
                "1_2_3",
                "0_",
                "._2",
                "-.2",
                "-.e3",
                "!!float 1_",
                "!!int 0x1_",
                "!!float 0o1",
                "!!float 01",
                "!!str null",
                "2000-01-01",
                "0099-1-1T00:00:00Z",
            }
        )
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] =
                        "version: 1\nrules: [{id: number, action: allow, match: {args: {a: "
                        + scalar
                        + "}}}]",
                    ["requests"] = new JsonArray(normal.DeepClone()),
                }
            );
        for (var mask = 0; mask < 16; mask++)
        {
            var policy = new JsonObject
            {
                ["version"] = 1,
                ["defaultAction"] = (mask & 1) == 0 ? "allow" : "deny",
                ["rules"] = new JsonArray(
                    new JsonObject
                    {
                        ["id"] = "conditional",
                        ["enabled"] = (mask & 2) == 0,
                        ["action"] = (mask & 4) == 0 ? "allow" : "deny",
                        ["match"] = new JsonObject
                        {
                            ["targetNode"] = "master",
                            ["args"] = new JsonObject
                            {
                                ["a"] = new JsonObject { ["exists"] = true },
                            },
                        },
                    },
                    new JsonObject
                    {
                        ["id"] = "last",
                        ["action"] = (mask & 8) == 0 ? "allow" : "deny",
                    }
                ),
            };
            var unknown = normal.DeepClone().AsObject();
            unknown["projection"] = new JsonObject { ["targetNodeUnknown"] = true };
            unknown.Remove("targetNode");
            fixtures.Add(
                new JsonObject
                {
                    ["yaml"] = policy.ToJsonString(),
                    ["requests"] = new JsonArray(normal.DeepClone(), unknown),
                }
            );
        }
        fixtures.Add(
            new JsonObject
            {
                ["yaml"] =
                    "version: 1\nrules: []\n#" + new string('x', ToolAuthorizationPolicy.MaxBytes),
            }
        );
        fixtures.Add(
            new JsonObject
            {
                ["yaml"] = new JsonObject
                {
                    ["version"] = 1,
                    ["rules"] = new JsonArray(
                        Enumerable
                            .Range(0, 257)
                            .Select(i =>
                                (JsonNode?)new JsonObject { ["id"] = "r" + i, ["action"] = "allow" }
                            )
                            .ToArray()
                    ),
                }.ToJsonString(),
            }
        );
        foreach (
            var rules in new[]
            {
                "[]",
                "null",
                "[{\"effect\":\"allow\",\"source\":\"builtin\",\"tool\":\"call_tool\"}]",
                "[{\"effect\":\"allow\",\"source\":\"node\",\"node\":\"future\",\"tool\":\"read\"}]",
                "[{\"effect\":\"deny\",\"source\":\"mcp\",\"server\":\"peer\",\"tool\":\"echo\"}]",
            }
        )
            fixtures.Add(
                new JsonObject { ["legacy"] = JsonNode.Parse(rules), ["isLegacy"] = true }
            );
        var input = Path.Combine(temp.Path, "input.json");
        var output = Path.Combine(temp.Path, "output.json");
        await File.WriteAllTextAsync(input, fixtures.ToJsonString());
        var info = new ProcessStartInfo("node")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        foreach (
            var arg in new[]
            {
                Path.Combine(sourceRoot, "dotnet", "tool-authorization-fixture-ts.mjs"),
                temp.Path,
                input,
                output,
            }
        )
            info.ArgumentList.Add(arg);
        info.Environment["FOXWARM_TS_ROOT"] = sourceRoot;
        using var process = Process.Start(info)!;
        var error = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await error + await stdout);
        var expected = JsonNode.Parse(await File.ReadAllTextAsync(output))!.AsArray();
        for (var i = 0; i < fixtures.Count; i++)
        {
            var actual = fixtures[i]!.AsObject();
            ToolAuthorizationPolicy? policy = null;
            JsonArray? legacy = null;
            Exception? failure = null;
            try
            {
                if (actual.ContainsKey("isLegacy"))
                    legacy = IsolatedToolCompatibility
                        .Metadata(new JsonObject { ["toolRules"] = actual["legacy"]?.DeepClone() })
                        .Rules;
                else
                    policy = ToolAuthorizationYaml.Parse(
                        Encoding.UTF8.GetBytes(actual["yaml"]!.GetValue<string>())
                    );
            }
            catch (Exception e)
            {
                failure = e;
            }
            Assert.True(
                expected[i]!["valid"]!.GetValue<bool>() == (failure is null),
                $"Case {i}: {actual["yaml"]}; expected valid={expected[i]!["valid"]}; actual {failure}"
            );
            if (failure is not null)
                continue;
            if (legacy is not null)
            {
                Assert.True(JsonNode.DeepEquals(expected[i]!["rules"], legacy));
                continue;
            }
            Assert.True(
                JsonNode.DeepEquals(expected[i]!["policy"], policy!.Value),
                $"Case {i} normalized policy differs: {actual}; expected {expected[i]}; actual {policy.Value}"
            );
            var requests = actual["requests"] as JsonArray ?? [];
            for (var n = 0; n < requests.Count; n++)
            {
                var request = Request(requests[n]!.AsObject(), temp.Path);
                var check = expected[i]!["checks"]![n]!;
                var evaluation = ToolAuthorizationEvaluation.Evaluate(policy, request);
                Assert.Equal(
                    check["evaluation"]!["action"]!.GetValue<string>() == "allow",
                    evaluation.Allowed
                );
                Assert.True(JsonNode.DeepEquals(check["evaluation"]!["rule"], evaluation.Rule));
                Assert.Equal(
                    check["visible"]!.GetValue<bool>(),
                    ToolAuthorizationEvaluation.Visible(
                        policy,
                        request,
                        requests[n]?["projection"]?["targetNodeUnknown"]?.GetValue<bool>() == true,
                        requests[n]?["projection"]?["nodeTargetsUnknown"]?.GetValue<bool>() == true
                    )
                );
                Assert.Equal(
                    check["needsTarget"]!.GetValue<bool>(),
                    ToolAuthorizationEvaluation.NeedsTarget(policy, request)
                );
                Assert.Equal(
                    check["needsTaskTarget"]!.GetValue<bool>(),
                    ToolAuthorizationEvaluation.NeedsTaskTarget(policy, request)
                );
            }
        }
    }

    [Fact]
    public async Task Actual_source_default_isolated_compatibility_for_registered_Master_capabilities_and_raw_actions()
    {
        using var temp = new TempDirectory();
        var fixtures = new JsonArray();
        var repository =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Source checkout is required.");
        var own = Path.Combine(temp.Path, "workspace", "agents", "alpha");
        Directory.CreateDirectory(own);
        var files = new WorkspaceTools(own);
        foreach (
            var (source, name, args) in new (string, string, JsonObject)[]
            {
                ("node", "read", Obj("""{"filePath":"own"}""")),
                ("node", "write", Obj("""{"filePath":"own"}""")),
                ("node", "edit", Obj("""{"filePath":"own"}""")),
                (
                    "node",
                    "read",
                    new JsonObject
                    {
                        ["filePath"] = Path.Combine(temp.Path, "workspace", "foreign"),
                    }
                ),
                ("node", "exec", Obj("""{"command":"never run"}""")),
                (
                    "node",
                    "apply_patch",
                    new JsonObject
                    {
                        ["input"] = "*** Begin Patch\n*** Add File: own\n+bytes\n*** End Patch",
                    }
                ),
                ("builtin", "session", new()),
                ("builtin", "session", Obj("""{"action":null}""")),
                ("builtin", "session", Obj("""{"action":""}""")),
                ("builtin", "session", Obj("""{"action":"status"}""")),
                ("builtin", "session", Obj("""{"action":"list"}""")),
                ("builtin", "session", Obj("""{"action":" STATUS "}""")),
                ("builtin", "session", Obj("""{"action":false}""")),
                ("builtin", "skill", new()),
                ("builtin", "recall", new()),
                ("builtin", "send_to_session", Obj("""{"sessionId":"opaque"}""")),
                ("builtin", "wait", new()),
                ("builtin", "search_tools", new()),
                ("builtin", "submit_compact_plan", new()),
                ("builtin", "create_agent", new()),
                ("builtin", "get_session_messages", new()),
                ("builtin", "delete_session", new()),
                ("builtin", "set_config", Obj("""{"target":"tool-rules","filePath":"own"}""")),
                ("mcp", "read", Obj("""{"filePath":"own"}""")),
            }
        )
        foreach (var discovery in new[] { false, true })
            fixtures.Add(
                new JsonObject
                {
                    ["defaults"] = new JsonObject
                    {
                        ["identity"] = new JsonObject
                        {
                            ["source"] = source,
                            ["tool"] = name,
                            ["node"] = "master",
                            ["server"] = "peer",
                        },
                        ["args"] = args.DeepClone(),
                        ["discovery"] = discovery,
                    },
                }
            );
        var input = Path.Combine(temp.Path, "input.json");
        var output = Path.Combine(temp.Path, "output.json");
        await File.WriteAllTextAsync(input, fixtures.ToJsonString());
        var info = new ProcessStartInfo("node")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        foreach (
            var arg in new[]
            {
                Path.Combine(repository, "dotnet", "tool-authorization-fixture-ts.mjs"),
                temp.Path,
                input,
                output,
            }
        )
            info.ArgumentList.Add(arg);
        using var process = Process.Start(info)!;
        var stderr = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await stderr + await stdout);
        var expected = JsonNode.Parse(await File.ReadAllTextAsync(output))!.AsArray();
        var isolation = new AgentIsolation(true, "unimplemented-recorded-node", []);
        for (var index = 0; index < fixtures.Count; index++)
        {
            var item = fixtures[index]!["defaults"]!;
            var identity = item["identity"]!;
            var source = identity["source"]!.GetValue<string>();
            var name = identity["tool"]!.GetValue<string>();
            var args = item["args"]!.AsObject();
            bool allowed;
            if (item["discovery"]!.GetValue<bool>())
                allowed = IsolatedToolCompatibility.Visible(
                    isolation,
                    source,
                    name,
                    source == "mcp" ? "peer" : null
                );
            else
            {
                var request = new ToolAuthorizationRequest(
                    source,
                    name,
                    source == "mcp" ? "peer" : null,
                    args,
                    source == "node" || name == "set_config"
                        ? files.AuthorizationFacts(name, args)
                        : [],
                    "alpha",
                    "opaque",
                    "master",
                    Path.Combine(temp.Path, "workspace"),
                    own,
                    Path.Combine(own, "memory")
                );
                try
                {
                    IsolatedToolCompatibility.Check(
                        isolation,
                        request,
                        _ => new("opaque", "alpha", null)
                    );
                    allowed = true;
                }
                catch (ToolAuthorizationDeniedException)
                {
                    allowed = false;
                }
            }
            Assert.Equal(expected[index]!["allowed"]!.GetValue<bool>(), allowed);
        }
    }
}
