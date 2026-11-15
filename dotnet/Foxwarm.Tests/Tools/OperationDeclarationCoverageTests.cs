using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// Phase-1 coverage of the operation catalog: every registered capability is declared, the
// obligation inventory matches the authorization call sites in the source, and the derivation
// corpus holds. None of this adds a production rejection.
public sealed partial class OperationDeclarationCoverageTests
{
    [Fact]
    public async Task Every_registered_capability_has_a_declaration_and_no_declaration_is_stale()
    {
        await using var f = await ScriptFixture.Create();
        var registered = f
            .Manager.ToolRegistry.Entries.Select(entry =>
                (entry.Source, Name: entry.Definition["name"]!.GetValue<string>())
            )
            .ToArray();
        foreach (var (source, name) in registered)
        {
            var declaration = OperationDeclarations.Find(source, name);
            Assert.True(declaration is { Opaque: false }, $"{source}:{name} has no declaration");
        }
        // Exact declarations name registered capabilities; MCP and custom Node identities use
        // the two opaque declarations.
        foreach (
            var declaration in OperationDeclarations.Capabilities.Where(item =>
                !item.Opaque && !item.Prefix
            )
        )
            Assert.Contains((declaration.Source, declaration.Name), registered);
        Assert.Equal(
            ["mcp:*", "node:*"],
            OperationDeclarations
                .Capabilities.Where(item => item.Opaque)
                .Select(item => item.Capability)
                .Order(StringComparer.Ordinal)
        );
        Assert.Equal(
            "node:*",
            OperationDeclarations.Find("node", "custom_tool")!.Capability
        );
        Assert.Equal("mcp:*", OperationDeclarations.Find("mcp", "anything")!.Capability);
        Assert.Equal(
            "node:browser_*",
            OperationDeclarations.Find("node", "browser_navigate")!.Capability
        );
    }

    [Fact]
    public void Declarations_use_catalog_operations_selectors_and_explicit_self_reasons()
    {
        var conditions = new Regex(
            "^!?(arg:[A-Za-z_]+|action:[a-z|-]+|secrets|file-source|file-action|channel|agent-scope|default-cwd-probe|legacy-node|invalid-plan|source-exists|source-missing)$"
        );
        foreach (var declaration in OperationDeclarations.Capabilities)
        {
            var id = declaration.Capability;
            if (declaration.FrontEnd is not null)
            {
                Assert.Empty(declaration.Branches);
                continue;
            }
            Assert.NotEmpty(declaration.Branches);
            Assert.Equal(
                declaration.Obligations.Count,
                declaration.Obligations.Select(item => item.Id).Distinct().Count()
            );
            Assert.Contains(declaration.Obligations, item => item.Kind == ObligationKind.Primary);
            foreach (var branch in declaration.Branches)
            {
                // Self is an explicit None(reason); every other branch has an unconditional op.
                if (branch.Self is not null)
                {
                    Assert.False(string.IsNullOrWhiteSpace(branch.Self), id);
                    Assert.Empty(branch.Operations);
                }
                else
                    Assert.Contains(branch.Operations, item => !item.Conditional);
                if (branch.When is { } when)
                    Assert.Matches(conditions, when);
                foreach (var template in branch.Operations)
                {
                    var spec = OperationDeclarations.Spec(template.Op);
                    Assert.True(spec is not null, $"{id}: unknown op {template.Op}");
                    Assert.All(
                        template.Resources.Keys,
                        key => Assert.Contains(key, spec!.Resources)
                    );
                    Assert.All(template.With.Keys, key => Assert.Contains(key, spec!.Attributes));
                    if (template.When is { } condition)
                        Assert.Matches(conditions, condition);
                }
            }
            foreach (var obligation in declaration.Obligations)
                if (obligation.When is { } condition)
                    Assert.Matches(conditions, condition);
        }
        // secret.use is the only op of the secret domain.
        Assert.Contains(OperationDeclarations.Operations, spec => spec.Op == "secret.use");
    }

    [Fact]
    public void Model_command_fixed_actions_select_a_declared_branch()
    {
        foreach (
            var command in CtlRegistry.Commands.Where(command =>
                command.Source is not null && command.Available("model")
            )
        )
        {
            var declaration = OperationDeclarations.Find(command.Source!, command.Name!)!;
            Assert.NotNull(declaration);
            var args = (JsonObject?)command.Fixed?.DeepClone() ?? new JsonObject();
            var normalized = OperationPlan.Normalize(declaration, args);
            var action = normalized["action"]?.GetValue<string>();
            if (!declaration.HasActions)
                continue;
            // Actions given later (task, mcp notifications) are positional; fixed ones select.
            if (action is null)
                continue;
            Assert.Contains(
                declaration.Branches,
                branch => branch.Action == action
            );
        }
    }

    // Item 2: every authorization call site outside the dispatch gate maps to a declared
    // obligation, and every declared sub-request, policy probe and retained request to a site.
    [Fact]
    public void Obligation_inventory_matches_every_authorization_call_site()
    {
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("FOXWARM_TS_ROOT is required.");
        var sources = Path.Combine(root, "dotnet", "Foxwarm");
        var found = CallSites(sources).ToArray();
        var plumbing = OperationDeclarations
            .Plumbing.Concat(OperationDeclarations.ReportOnly)
            .Select(item => (item.File, item.Member))
            .ToHashSet();
        var actual = found
            .Where(site => !plumbing.Contains((site.File, site.Member)))
            .Select(site => $"{site.File} {site.Member} {site.Ordinal} {site.Call}")
            .Order(StringComparer.Ordinal)
            .ToArray();
        var declared = OperationDeclarations
            .Inventory.Select(site => $"{site.File} {site.Member} {site.Ordinal} {site.Call}")
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(declared, actual);
        // Excluded entries exist, so a moved gate or report cannot hide a site.
        foreach (var (file, member) in plumbing)
            Assert.Contains(found, site => site.File == file && site.Member == member);

        var mapped = new HashSet<(string, string)>();
        foreach (var site in OperationDeclarations.Inventory)
        foreach (var (capability, obligation) in site.Obligations)
        {
            var known =
                capability == "*"
                    ? OperationDeclarations.Common.Any(item => item.Id == obligation)
                    : OperationDeclarations
                        .Capabilities.Single(item => item.Capability == capability)
                        .Obligations.Any(item => item.Id == obligation);
            Assert.True(known, $"{site.File} {site.Member}: {capability}#{obligation} is not declared");
            mapped.Add((capability, obligation));
        }
        foreach (var declaration in OperationDeclarations.Capabilities)
        foreach (
            var obligation in declaration.Obligations.Where(item =>
                item.Kind is ObligationKind.SubRequest or ObligationKind.Probe or ObligationKind.Retained
            )
        )
            Assert.True(
                mapped.Contains((declaration.Capability, obligation.Id)),
                $"{declaration.Capability}#{obligation.Id} has no call site"
            );
        foreach (var obligation in OperationDeclarations.Common)
            Assert.Contains(("*", obligation.Id), mapped);
    }

    private static readonly string[] Calls =
    [
        "AuthorizeToolAsync",
        "AuthorizeNodeFileAsync",
        "AssessToolAsync",
        "AuthorizeCreateSessionTargetAsync",
        "EvaluateCreationTarget",
        "EvaluateCreationTargetOutcome",
        "EffectiveDecision",
        "registry.ExecuteAsync",
    ];

    private static readonly Regex Declaration = new(@"^    (internal|private|public|protected)\b");

    // The method a declaration starting on this line declares: the identifier before its first
    // parameter list, outside generic arguments. Properties and fields declare none.
    private static string? MemberName(string text)
    {
        var angle = 0;
        for (var index = 0; index < text.Length; index++)
        {
            var current = text[index];
            if (current == '<')
                angle++;
            else if (current == '>')
                angle--;
            else if (current is '=' or '{' or ';')
                return null;
            else if (current == '(' && angle == 0)
                return Regex.Match(text[..index], @"(\w+)\s*$") is { Success: true } match
                    ? match.Groups[1].Value
                    : null;
        }
        return null;
    }

    // Inbound MCP enforcement and every direct call of the evaluator.
    private static readonly string[] InboundCalls =
    [
        "authorization.Require",
        "authorization.RequireAsync",
        "ToolAuthorizationEvaluation.Evaluate",
    ];

    // Inbound MCP item: every external enforcement site is listed with the capability it
    // checks, and the evaluator is called directly only by the shared assessment and the
    // inbound check. The operation adapter for inbound calls is phase 3.
    [Fact]
    public void Inbound_inventory_matches_every_external_enforcement_site()
    {
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("FOXWARM_TS_ROOT is required.");
        var sources = Path.Combine(root, "dotnet", "Foxwarm");
        var found = CallSites(sources, InboundCalls).ToArray();
        var plumbing = OperationDeclarations
            .EvaluatorPlumbing.Select(item => (item.File, item.Member))
            .ToHashSet();
        var actual = found
            .Where(site => !plumbing.Contains((site.File, site.Member)))
            .Select(site => $"{site.File} {site.Member} {site.Ordinal} {site.Call}")
            .Order(StringComparer.Ordinal)
            .ToArray();
        var declared = OperationDeclarations
            .Inbound.Select(site => $"{site.File} {site.Member} {site.Ordinal} {site.Call}")
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(declared, actual);
        foreach (var (file, member) in plumbing)
            Assert.Contains(found, site => site.File == file && site.Member == member);
        foreach (var site in OperationDeclarations.Inbound)
        foreach (var (capability, obligation) in site.Obligations)
            Assert.True(
                OperationDeclarations
                    .Capabilities.Single(item => item.Capability == capability)
                    .Obligations.Any(item => item.Id == obligation),
                $"{site.File} {site.Member}: {capability}#{obligation} is not declared"
            );
    }

    internal static IEnumerable<(string File, string Member, int Ordinal, string Call)> CallSites(
        string sources,
        IReadOnlyList<string>? calls = null
    )
    {
        var patterns = (calls ?? Calls)
            .Select(call => (call, new Regex(@"(?<![\w])" + Regex.Escape(call) + @"\(")))
            .ToArray();
        foreach (
            var path in Directory
                .EnumerateFiles(sources, "*.cs", SearchOption.AllDirectories)
                .Where(path =>
                    !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                    && !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                )
                .Order(StringComparer.Ordinal)
        )
        {
            var file = Path.GetRelativePath(sources, path).Replace('\\', '/');
            var lines = File.ReadAllLines(path);
            string? member = null;
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var index = 0; index < lines.Length; index++)
            {
                var line = lines[index];
                if (Declaration.IsMatch(line))
                {
                    if (MemberName(string.Join(' ', lines.Skip(index).Take(6))) is { } name)
                        member = name;
                    continue;
                }
                if (line.TrimStart().StartsWith("//", StringComparison.Ordinal))
                    continue;
                foreach (var (call, pattern) in patterns)
                    if (pattern.IsMatch(line))
                    {
                        var key = member ?? "";
                        counts[key] = counts.GetValueOrDefault(key) + 1;
                        yield return (file, key, counts[key], call);
                    }
            }
        }
    }
}
