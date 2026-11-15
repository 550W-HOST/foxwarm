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
            OwnedSecrets: ["key"]
        );

    // Each property of the request, changed on its own, must change the fingerprint. A new
    // property whose type this test cannot vary fails here until it is covered.
    private static IEnumerable<(string Fact, ToolAuthorizationRequest Changed)> ChangedFacts(
        ToolAuthorizationRequest request
    )
    {
        foreach (
            var property in typeof(ToolAuthorizationRequest).GetProperties(
                BindingFlags.Public | BindingFlags.Instance
            )
        )
        {
            var value = property.GetValue(request);
            object?[] variants = value switch
            {
                null when property.PropertyType == typeof(string) => ["set"],
                string text => [text + "-changed"],
                JsonObject args => [new JsonObject { ["filePath"] = "b.txt" }],
                IReadOnlyList<AuthorizationPath> paths =>
                [
                    paths.Select(path => path with { Resolved = "/w/b.txt" }).ToArray(),
                    paths.Select(path => path with { Node = "child" }).ToArray(),
                ],
                AuthorizationTarget target =>
                [
                    target with { Id = "beta/other" },
                    target with { Agent = "gamma" },
                    target with { Parent = "beta/foreign" },
                ],
                IReadOnlyList<string> names => [names.Append("added").ToArray()],
                Foxwarm.Nodes.NodeAuthorizationForest => [new Foxwarm.Nodes.NodeAuthorizationForest(
                    new Dictionary<string, string?> { ["other"] = null, ["child"] = "other" }
                )],
                _ => throw new InvalidOperationException(
                    $"Add a variant for request fact {property.Name} of type {property.PropertyType.Name}."
                ),
            };
            foreach (var variant in variants)
            {
                var changed = request with { };
                // Records expose init accessors; set the copy's value through them.
                property.SetValue(changed, variant);
                yield return (property.Name, changed);
            }
        }
    }

    [Fact]
    public void Approval_fingerprint_binds_every_fact_of_the_request()
    {
        var request = EveryFactRequest();
        var resolved = new ResolvedTool("write", "node", "write", request.Args);
        var original = ToolApprovalScope.Fingerprint(resolved, request);
        Assert.Equal(original, ToolApprovalScope.Fingerprint(resolved, request with { }));
        var facts = ChangedFacts(request).ToArray();
        Assert.Equal(
            typeof(ToolAuthorizationRequest)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Select(property => property.Name)
                .Order(),
            facts.Select(fact => fact.Fact).Distinct().Order()
        );
        foreach (var (fact, changed) in facts)
            Assert.True(
                original != ToolApprovalScope.Fingerprint(resolved, changed),
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
        manager.ChangePresentation(catalog => catalog.SetParent("direct", "foreign"));
        var after = await manager.AssessToolAsync(caller, resolved, null, default);
        Assert.Equal("other-view", after.Asking.Single().Decision.Rule!["id"]!.GetValue<string>());
        Assert.NotEqual(
            manager.ApprovalFingerprint(caller, resolved, before.Request),
            manager.ApprovalFingerprint(caller, resolved, after.Request)
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
            SessionWait.Text(response["error"]!["message"])
        );
        var record = Assert.Single(Records(caller));
        Assert.Equal("cancelled", SessionWait.Text(record["status"]));
        Assert.Equal("notStarted", SessionWait.Text(record["decidedBy"]!["reason"]));
    }
}
