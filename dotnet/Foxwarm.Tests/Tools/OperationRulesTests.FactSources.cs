using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Every declared operation resource has a fact source, and visibility never treats a value the
// caller has not stated as known (operation authorization phase 3).
public sealed partial class OperationRulesTests
{
    [Fact]
    public void Every_declared_operation_resource_has_a_fact_source()
    {
        var missing = new List<string>();
        foreach (var declaration in OperationDeclarations.Capabilities)
        foreach (var branch in declaration.Branches)
        foreach (var template in branch.Operations)
        foreach (var (key, expression) in template.Resources.Concat(template.With))
            if (OperationPlan.FactSource(declaration, branch, expression) is null)
                missing.Add($"{declaration.Capability} {branch.Name} {template.Op} {key}={expression}");
        Assert.Empty(missing);
    }

    // Capabilities whose handlers copy or move content between paths (memory copies in
    // create_agent and move_session, copy_between_nodes). Each declares a copy as a tree read of
    // what it copies plus a tree write of its destination, under the same condition, and a tree
    // leg anywhere else has its pair.
    private static readonly string[] Copies =
    [
        "builtin:create_agent",
        "builtin:move_session",
        "builtin:copy_between_nodes",
    ];

    [Fact]
    public void Every_copy_declares_its_read_and_write_legs()
    {
        var failures = new List<string>();
        foreach (var declaration in OperationDeclarations.Capabilities)
        foreach (var branch in declaration.Branches)
        {
            var legs = branch.Operations.Where(template => template.Tree).ToArray();
            foreach (var group in legs.GroupBy(template => template.When ?? ""))
            {
                if (!group.Any(template => template.Op == "env.read"))
                    failures.Add($"{declaration.Capability} {branch.Name} when '{group.Key}': no read leg");
                if (!group.Any(template => template.Op == "env.write"))
                    failures.Add($"{declaration.Capability} {branch.Name} when '{group.Key}': no write leg");
                foreach (var leg in group.Where(template => template.Op is not ("env.read" or "env.write")))
                    failures.Add($"{declaration.Capability} {branch.Name}: tree on {leg.Op}");
            }
            if (Copies.Contains(declaration.Capability) && legs.Length == 0)
                failures.Add($"{declaration.Capability} {branch.Name}: copy without legs");
        }
        foreach (var capability in Copies)
            Assert.Contains(OperationDeclarations.Capabilities, declaration => declaration.Capability == capability);
        Assert.Empty(failures);
    }

    // A copy leg is the directory and everything in it: a restriction on any path inside
    // applies, and a grant applies only when it covers the whole tree.
    [Fact]
    public void Copy_legs_match_path_selectors_as_trees()
    {
        AuthorizationOperation Read(string path, bool tree) =>
            new(
                "env.read",
                new JsonObject { ["node"] = "master", ["path"] = path },
                new JsonObject()
            )
            {
                Path = new AuthorizationPath("sourcePath", path, path, "master", tree),
            };
        var request = Request("builtin", "copy_between_nodes", "{}");
        OperationMatch Match(string rule, AuthorizationOperation operation) =>
            OperationRules.Match(
                (JsonObject)Yaml("rules:\n- " + rule + "\n").Value["rules"]![0]!,
                operation,
                request,
                rule.Contains("deny")
            );
        const string DenyInside = "{op: env.read, path: {within: /synthetic/tree/secret}, action: deny}";
        const string GrantInside = "{op: env.read, path: {within: /synthetic/tree/open}, action: allow}";
        const string GrantWhole = "{op: env.read, path: {within: /synthetic}, action: allow}";
        const string DenyOutside = "{op: env.read, path: {notWithin: /synthetic/tree/open}, action: deny}";
        Assert.Equal(OperationMatch.Yes, Match(DenyInside, Read("/synthetic/tree", true)));
        Assert.Equal(OperationMatch.No, Match(DenyInside, Read("/synthetic/tree", false)));
        Assert.Equal(OperationMatch.No, Match(GrantInside, Read("/synthetic/tree", true)));
        Assert.Equal(OperationMatch.Yes, Match(GrantWhole, Read("/synthetic/tree", true)));
        Assert.Equal(OperationMatch.Yes, Match(DenyOutside, Read("/synthetic/tree", true)));
        Assert.Equal(OperationMatch.No, Match(DenyOutside, Read("/synthetic/tree/open/a", true)));
        Assert.Equal(OperationMatch.No, Match(DenyInside, Read("/synthetic/other", true)));
    }

    // An exec without cwd runs in the Session's directory on master, known only with the
    // caller's workspace; elsewhere, and for inbound callers, no path selector can match it.
    [Fact]
    public void An_exec_without_cwd_is_decidable_where_its_directory_cannot_match_a_path()
    {
        var policy = Yaml("rules:\n- {op: node.select, action: deny}\n");
        var remote = Request("node", "exec", """{"command":"go"}""", targetNode: "box");
        Assert.Equal(ToolAuthorizationEffect.Allow, Decide(policy, remote).Effect);
        var guarded = Yaml(
            "rules:\n- {op: env.exec, path: {within: /synthetic/secret}, action: deny}\n- {op: env.exec, action: allow}\n"
        );
        Assert.Equal(ToolAuthorizationEffect.Allow, Decide(guarded, remote).Effect);
        var inbound = Request("node", "exec", """{"command":"go"}""", principal: "external");
        Assert.Equal(ToolAuthorizationEffect.Allow, Decide(guarded, inbound).Effect);
        // On master without the workspace the directory is unknown, so a path rule can't pass it.
        var master = Request("node", "exec", """{"command":"go"}""");
        Assert.Equal(ToolAuthorizationEffect.Deny, Decide(guarded, master).Effect);
    }

    private static string Selector(string key) =>
        key switch
        {
            "node" => "node: sample",
            "path" => "path: {within: /synthetic}",
            "targetSession" or "parent" => key + ": {id: sample}",
            "targetAgent" => "targetAgent: {id: sample}",
            "secret" => "secret: {anyOf: [sample]}",
            "mcp" => "mcp: {server: sample, tool: sample}",
            "task" => "task: {owned: true}",
            _ => key + ": sample",
        };

    // For each operation attribute derived from an argument, an allow rule that constrains just
    // that attribute leaves the capability visible while the argument is unstated.
    [Fact]
    public void Visibility_keeps_every_argument_derived_attribute_unknown()
    {
        var checkedCases = 0;
        var failures = new List<string>();
        foreach (var declaration in OperationDeclarations.Capabilities)
        {
            if (declaration.Prefix || declaration.FrontEnd is not null)
                continue;
            var name = declaration.Opaque ? "sample" : declaration.Name;
            foreach (var branch in declaration.Branches.Where(item => item.Self is null))
            {
                var unconditional = branch.Operations.Where(item => !item.Conditional).ToArray();
                foreach (var template in unconditional.Where(item => item.Op != "secret.use"))
                foreach (var (key, expression) in template.Resources.Select(pair => (pair.Key, pair.Value, With: false))
                    .Concat(template.With.Select(pair => (pair.Key, pair.Value, With: true)))
                    .Where(item => OperationPlan.ValueArgs(item.Value).Length > 0 || item.Value == "server-tool")
                    .Select(item => (Key: item.With ? "with." + item.Key : item.Key, item.Value)))
                {
                    var others = unconditional
                        .Select(item => item.Op)
                        .Where(op => op != template.Op && op != "secret.use")
                        .Distinct()
                        .ToArray();
                    var constraint = key.StartsWith("with.", StringComparison.Ordinal)
                        ? $"with: {{{key[5..]}: sample}}"
                        : Selector(key);
                    var text =
                        "defaultAction: deny\nrules:\n"
                        + $"- {{op: {template.Op}, {constraint}, action: allow}}\n"
                        + (others.Length > 0 ? $"- {{op: [{string.Join(", ", others)}], action: allow}}\n" : "");
                    ToolAuthorizationPolicy policy;
                    try
                    {
                        policy = Yaml(text);
                    }
                    catch (InvalidDataException)
                    {
                        // The grammar does not allow this selector for this operation.
                        continue;
                    }
                    var args = new JsonObject();
                    var known = new HashSet<string>(StringComparer.Ordinal);
                    if (branch.Action is not null)
                    {
                        args["action"] = branch.Action;
                        known.Add("action");
                    }
                    var request = Request(declaration.Source, name, args.ToJsonString(), targetNode: null) with
                    {
                        Server = declaration.Source == "mcp" ? "sample" : null,
                    };
                    checkedCases++;
                    if (
                        !ToolAuthorizationEvaluation.Visible(
                            policy,
                            request,
                            unknownNodeTargets: true,
                            knownArgs: known,
                            unknownName: expression == "server-tool"
                        )
                    )
                        failures.Add($"{declaration.Capability} {branch.Name} {template.Op} {key}={expression}");
                }
            }
        }
        Assert.Empty(failures);
        Assert.True(checkedCases > 40, checkedCases.ToString());
    }
}
