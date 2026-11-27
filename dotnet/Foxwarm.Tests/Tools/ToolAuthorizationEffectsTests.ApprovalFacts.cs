using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using static Foxwarm.Tests.ApprovalStagingSupport;

namespace Foxwarm.Tests;

// What an approval binds: every fact the evaluator receives is part of the approved identity, so
// an approval given for one set of facts never covers another.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static ToolAuthorizationRequest EveryFactRequest() =>
        new(
            "node",
            "write",
            null,
            new JsonObject { ["filePath"] = "a.txt" },
            [new("filePath", "a.txt", "/w/a.txt", "master")],
            "beta",
            "beta/main",
            "master",
            "/w",
            "/agents/beta",
            "/agents/beta/memory",
            SourceParent: "beta/parent",
            SessionTarget: new("beta/target", "beta", "beta/main"),
            Principal: "internal",
            ExternalId: "external",
            TaskOwnerSession: "beta/owner",
            NodeTargets: ["child"],
            CurrentNode: "master",
            NodeForest: new(new Dictionary<string, string?> { ["root"] = null, ["child"] = "root" }),
            Secrets: ["key"],
            OwnedSecrets: ["key"],
            Operations:
            [
                new AuthorizationOperation(
                    "env.write",
                    new JsonObject { ["node"] = "master", ["path"] = "/w/a.txt" },
                    new JsonObject { ["change"] = "rules" }
                )
                {
                    Path = new("filePath", "a.txt", "/w/a.txt", "master"),
                    Target = new("beta/target", "beta", "beta/main"),
                    ParentTarget = new("beta/main", "beta", null),
                    AgentDescendant = true,
                    TaskOwned = true,
                    TaskCreated = false,
                    SecretOwned = true,
                },
            ]
        );

    // A copy of a fact record; records expose init accessors, set through reflection here.
    private static T Copy<T>(T record)
        where T : notnull =>
        (T)record.GetType().GetMethod("<Clone>$")!.Invoke(record, null)!;

    // Every property of a fact record, and of the fact records it holds, changed on its own.
    // A property whose type this test cannot vary fails here until it is covered.
    private static IEnumerable<(string Fact, object Changed)> ChangedFacts(object record, string prefix)
    {
        foreach (
            var property in record
                .GetType()
                .GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic)
                .Where(Fact)
        )
        {
            var name = prefix + property.Name;
            var value = property.GetValue(record);
            IEnumerable<(string Fact, object? Value)> variants = value switch
            {
                null when property.PropertyType == typeof(string) => [(name, "set")],
                null when property.PropertyType == typeof(bool?) => [(name, true)],
                null when property.PropertyType == typeof(AuthorizationTarget) =>
                [
                    (name, new AuthorizationTarget("beta/set", "beta", null)),
                ],
                bool flag => [(name, !flag)],
                AuthorizationPath path => ChangedFacts(path, name + ".")
                    .Select(changed => (changed.Fact, (object?)changed.Changed)),
                IReadOnlyList<AuthorizationOperation> operations => ChangedFacts(operations[0], name + "[0].")
                    .Select(changed =>
                        (
                            changed.Fact,
                            (object?)operations.Skip(1).Prepend((AuthorizationOperation)changed.Changed).ToArray()
                        )
                    ),
                string text => [(name, text + "-changed")],
                JsonObject => [(name, new JsonObject { ["filePath"] = "b.txt" })],
                Foxwarm.Nodes.NodeAuthorizationForest =>
                [
                    (
                        name,
                        new Foxwarm.Nodes.NodeAuthorizationForest(
                            new Dictionary<string, string?> { ["other"] = null, ["child"] = "other" }
                        )
                    ),
                ],
                IReadOnlyList<string> names => [(name, names.Append("added").ToArray())],
                IReadOnlyList<AuthorizationPath> paths => ChangedFacts(paths[0], name + "[0].")
                    .Select(changed =>
                        (
                            changed.Fact,
                            (object?)paths.Skip(1).Prepend((AuthorizationPath)changed.Changed).ToArray()
                        )
                    ),
                AuthorizationTarget target => ChangedFacts(target, name + ".")
                    .Select(changed => (changed.Fact, (object?)changed.Changed)),
                _ => throw new InvalidOperationException(
                    $"Add a variant for request fact {name} of type {property.PropertyType.Name}."
                ),
            };
            foreach (var (fact, variant) in variants)
            {
                var changed = Copy(record);
                property.SetValue(changed, variant);
                yield return (fact, changed);
            }
        }
    }

    // The leaf facts of a fact record type, as ChangedFacts names them.
    private static IEnumerable<string> FactNames(Type type, string prefix) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic)
            .Where(Fact)
            .SelectMany(property =>
                property.PropertyType == typeof(AuthorizationTarget)
                    ? FactNames(typeof(AuthorizationTarget), prefix + property.Name + ".")
                : property.PropertyType == typeof(AuthorizationPath)
                    ? FactNames(typeof(AuthorizationPath), prefix + property.Name + ".")
                : property.PropertyType == typeof(IReadOnlyList<AuthorizationPath>)
                    ? FactNames(typeof(AuthorizationPath), prefix + property.Name + "[0].")
                : property.PropertyType == typeof(IReadOnlyList<AuthorizationOperation>)
                    ? FactNames(typeof(AuthorizationOperation), prefix + property.Name + "[0].")
                : [prefix + property.Name]
            );

    // Settable data properties: the records' facts, not computed members or the record's
    // equality contract.
    private static bool Fact(PropertyInfo property) =>
        property.CanWrite
        && property.GetIndexParameters().Length == 0
        && property.Name != "EqualityContract"
        && (property.GetMethod?.IsPublic == true || property.GetMethod?.IsAssembly == true);

    [Fact]
    public void Approval_fingerprint_binds_every_fact_of_the_request()
    {
        var request = EveryFactRequest();
        var resolved = new ResolvedTool("write", "node", "write", request.Args);
        var original = ToolApprovalScope.Fingerprint(resolved, request);
        Assert.Equal(original, ToolApprovalScope.Fingerprint(resolved, request with { }));
        var facts = ChangedFacts(request, "").ToArray();
        // Every leaf property of the request and its nested fact types is varied.
        Assert.Equal(
            FactNames(typeof(ToolAuthorizationRequest), "").Order(),
            facts.Select(fact => fact.Fact).Distinct().Order()
        );
        foreach (var (fact, changed) in facts)
            Assert.True(
                original != ToolApprovalScope.Fingerprint(resolved, (ToolAuthorizationRequest)changed),
                $"The fingerprint does not bind {fact}."
            );
        // An empty collection is an absent fact to the evaluator.
        var absent = request with { Secrets = null, OwnedSecrets = null };
        Assert.Equal(
            ToolApprovalScope.Fingerprint(resolved, absent),
            ToolApprovalScope.Fingerprint(resolved, absent with { Secrets = [], OwnedSecrets = [] })
        );
    }

    [Fact]
    public async Task Approval_does_not_cover_a_view_whose_Session_relation_changed_while_waiting()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            """
            version: 1
            rules:
              - id: child-view
                tool: {source: builtin, name: view_session}
                args: {sessionId: {session: {relation: child}}}
                action: ask
                approval: {approvers: [child-reviewer]}
              - id: other-view
                tool: {source: builtin, name: view_session}
                action: ask
                approval: {approvers: [security-reviewer]}
            """
        );
        var args = Obj("""{"sessionId":"kid"}""");
        var resolved = new ResolvedTool("view_session", "builtin", "view_session", args);
        var before = await manager.AssessToolAsync(caller, resolved, null, default);
        var call = Call(execution.Tools, "view_session", args);
        var pending = await PendingAsync(caller);
        Assert.Equal(["child-reviewer"], Approvers(pending));
        // The target stops being the caller's child while the approval waits.
        await manager.ChangePresentationAsync(catalog => catalog.SetParentAsync("direct", "foreign"));
        var after = await manager.AssessToolAsync(caller, resolved, null, default);
        Assert.Equal("other-view", after.Asking.Single().Decision.Rule!["id"]!.GetValue<string>());
        Assert.NotEqual(
            await manager.ApprovalFingerprintAsync(caller, resolved, before.Request),
            await manager.ApprovalFingerprintAsync(caller, resolved, after.Request)
        );
        await manager.DecideToolApprovalAsync(
            caller,
            Id(pending),
            true,
            null,
            new JsonObject { ["kind"] = "identity", ["id"] = "child-reviewer" }
        );
        var response = await call.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal("tool_approval_unavailable", Error(response));
        Assert.Equal(
            "This call changed while it waited for approval: builtin `view_session` now needs approval under rule other-view, which the approval did not cover. It was not executed.",
            response.FailureMessage()
        );
        var record = Assert.Single(Records(caller));
        Assert.Equal("cancelled", SessionWait.Text(record["status"]));
        Assert.Equal("notStarted", SessionWait.Text(record["decidedBy"]!["reason"]));
    }
}
