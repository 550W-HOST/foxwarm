using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class NodeAuthorizationTreeTests
{
    private static async Task<JsonObject> ListData(Fixture f, SessionOwner? owner = null) =>
        await f.Manager.ExecuteNodeToolAsync(
            owner ?? f.Owner,
            Obj("""{"action":"list"}"""),
            default,
            programmatic: true
        );

    private static string[] Listed(JsonObject data) =>
        data["nodes"]!.AsArray().Select(node => SessionWait.Text(node?["id"])!).ToArray();

    private static JsonObject Row(JsonObject data, string id) =>
        data["nodes"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(node => SessionWait.Text(node["id"]) == id);

    private static string[] Actions(JsonObject data, string provider) =>
        data["providers"]!
            .AsArray()
            .OfType<JsonObject>()
            .Where(value => SessionWait.Text(value["id"]) == provider)
            .SelectMany(value =>
                value["lifecycle"]!.AsArray().Select(item => SessionWait.Text(item)!)
            )
            .ToArray();

    [Fact]
    public async Task Node_list_shows_only_Nodes_where_policy_might_allow_work_and_keeps_select_and_management_as_annotations()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        f.Manager.Nodes.Registry.Create("other");
        f.Manager.Nodes.Registry.Create("copy-only");
        await f.Policy(
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: node, args: {action: select}, node: {exact: parent}, action: deny}
            - {tool: node, action: allow}
            - {tool: [read, write, edit, exec], node: parent, action: allow}
            - {tool: copy_between_nodes, node: copy-only, action: allow}
            """
        );
        var data = await ListData(f);
        // Broad builtin `node` grants make select and inspect possible everywhere, but only
        // work capabilities admit a Node. The current Node is always listed.
        // Every fixture Provider Node, including offline ones, descends from the granted parent.
        Assert.Equal(
            new[] { "master", "copy-only", "parent" }
                .Concat(
                    f.Manager.NodeProviders.Snapshot()
                        .Select(node => SessionWait.Text(node?["id"])!)
                )
                .Order(),
            Listed(data).Order()
        );
        Assert.Contains("fixture/target", Listed(data));
        Assert.Contains("fixture/offline", Listed(data));
        Assert.Equal("offline", SessionWait.Text(Row(data, "parent")["availability"]));
        Assert.False(Row(data, "parent")["select"]!.GetValue<bool>());
        Assert.True(Row(data, "fixture/target")["select"]!.GetValue<bool>());
        Assert.Equal(
            new[] { "inspect", "destroy" },
            Row(data, "fixture/target")["manage"]!.AsArray().Select(SessionWait.Text)
        );
        Assert.NotEmpty(Row(data, "fixture/target")["tools"]!.AsArray());
        Assert.True(Row(data, "copy-only")["transfer"]!.GetValue<bool>());
        Assert.Empty(Row(data, "copy-only")["tools"]!.AsArray());
        Assert.False(Row(data, "master")["transfer"]!.GetValue<bool>());
        Assert.Empty(Row(data, "master")["tools"]!.AsArray());

        // A child the caller's Provider creates under the granted parent appears without a policy edit.
        Success(await f.Call("node", Lifecycle("create", "fixture/newcomer")));
        data = await ListData(f);
        Assert.Contains("fixture/newcomer", Listed(data));

        // Once the Session is elsewhere, master has no work facet and disappears.
        Success(await f.Call("node", Obj("""{"action":"select","nodeId":"fixture/target"}""")));
        data = await ListData(f);
        Assert.DoesNotContain("master", Listed(data));
        Assert.DoesNotContain("other", Listed(data));
        var text = SessionWait.Text(
            (await f.Call("node", Obj("""{"action":"list"}""")))!["output"]
        )!;
        Assert.Contains("`parent` (remote) — offline; not selectable", text);
        Assert.DoesNotContain("`other`", text);
        Assert.DoesNotContain("`master` (master)", text);
        Assert.Contains("- `master` (inspect)", text);
    }

    [Fact]
    public async Task Node_list_treats_conditional_and_ask_rules_as_possible_and_applies_the_current_selector_and_Agent_layers()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        foreach (var id in new[] { "pathed", "asked", "denied-later" })
            f.Manager.Nodes.Registry.Create(id);
        var child = await f.Child();
        await f.Policy(
            $$"""
            version: 1
            defaultAction: deny
            rules:
            - {tool: node, action: allow}
            - {tool: read, node: {exact: pathed}, path: {allWithin: '{{f.Work}}'}, action: allow}
            - {tool: exec, node: {exact: asked}, action: ask}
            - {tool: exec, node: {exact: denied-later}, path: {allWithin: '{{f.Work}}'}, action: deny}
            - {tool: [read, exec], node: {current: true}, action: allow}
            """
        );
        var data = await ListData(f);
        var listed = Listed(data);
        Assert.Contains("pathed", listed);
        Assert.Contains("asked", listed);
        // A conditional deny alone does not prove that every call is denied, but nothing allows it.
        Assert.DoesNotContain("denied-later", listed);
        Assert.Contains("master", listed);
        Assert.NotEmpty(Row(data, "master")["tools"]!.AsArray());
        Assert.DoesNotContain("fixture/target", listed);

        // `current: true` follows the caller's selection.
        Success(await f.Call("node", Obj("""{"action":"select","nodeId":"fixture/target"}""")));
        listed = Listed(await ListData(f));
        Assert.Contains("fixture/target", listed);
        Assert.DoesNotContain("master", listed);

        // An Agent-local layer must also leave the work possible.
        Success(await f.Call("node", Obj("""{"action":"select","nodeId":"master"}"""), child));
        Assert.Contains("pathed", Listed(await ListData(f, child)));
        await f.Manager.SetAgentRulesAsync(
            "delegated",
            Rules("""[{"tool": "read", "node": {"exact": "pathed"}, "action": "deny"}]""")
        );
        Assert.DoesNotContain("pathed", Listed(await ListData(f, child)));
        Assert.Contains("asked", Listed(await ListData(f, child)));
    }

    [Fact]
    public async Task Providers_list_only_actions_the_caller_might_use_and_fixed_Providers_need_inspection()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        await f.Policy(
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: node, args: {action: [list, select]}, action: allow}
            - {tool: node, args: {action: create}, node: parent, action: allow}
            - {tool: [read, exec], node: parent, action: allow}
            """
        );
        var data = await ListData(f);
        Assert.Equal(
            new[] { "fixture" },
            data["providers"]!.AsArray().Select(p => SessionWait.Text(p?["id"]))
        );
        Assert.Equal(new[] { "create" }, Actions(data, "fixture"));
        Assert.Empty(Row(data, "fixture/target")["manage"]!.AsArray());
        var text = SessionWait.Text(
            (await f.Call("node", Obj("""{"action":"list"}""")))!["output"]
        )!;
        Assert.Contains("- `fixture` (create)", text);
        Assert.DoesNotContain("authenticated-remote", text);

        // Without any possible lifecycle action, no Providers section is shown at all.
        await f.Policy(
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: node, args: {action: list}, action: allow}
            """
        );
        data = await ListData(f);
        Assert.Empty(data["providers"]!.AsArray());
        Assert.Equal(new[] { "master" }, Listed(data));
        text = SessionWait.Text((await f.Call("node", Obj("""{"action":"list"}""")))!["output"])!;
        Assert.DoesNotContain("Providers:", text);
    }

    [Fact]
    public async Task Provider_without_lifecycle_actions_is_not_listed_even_when_its_Nodes_are()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        // Existing machines, as with the public SSH adapter: no create, ensure, inspect or destroy.
        Directory.CreateDirectory(f.Target);
        await File.WriteAllTextAsync(
            Path.Combine(f.Target, "description.json"),
            """{"label": "Existing machines", "description": "Fixed targets.", "lifecycle": [], "dataRetention": "Targets remain."}"""
        );
        // No policy file: nothing is denied, so the Node is listed with its tools.
        var data = await ListData(f);
        Assert.Contains("fixture/target", Listed(data));
        Assert.NotEmpty(Row(data, "fixture/target")["tools"]!.AsArray());
        Assert.Equal(
            new[] { "master", "authenticated-remote" },
            data["providers"]!.AsArray().Select(p => SessionWait.Text(p?["id"]))
        );
        // Full inspection remains the Provider's discovery path.
        var inspected = await f.Call(
            "node",
            Obj("""{"action":"inspect","providerId":"fixture"}""")
        );
        Assert.Empty(inspected!["provider"]!["lifecycle"]!.AsArray());
    }

    [Fact]
    public async Task Node_list_fails_closed_when_policy_is_unavailable_and_the_administrator_picker_only_adds_hints()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        f.Manager.Nodes.Registry.Create("other");
        await f.Policy(
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: [read, exec], node: parent, action: allow}
            """
        );
        // The picker route lists (and so admits) Provider Nodes before it computes hints.
        _ = await f.Manager.NodeSummariesAsync();
        var row = f.Manager.Catalog.Get(f.Owner.Id)!;
        var visibility = f.Manager.CatalogVisibility(f.Owner.Id, row)!;
        Assert.True(f.Manager.NodeUsable(visibility, "fixture/target"));
        Assert.True(f.Manager.NodeUsable(visibility, "parent"));
        Assert.False(f.Manager.NodeUsable(visibility, "other"));
        Assert.False(f.Manager.NodeUsable(visibility, "master"));

        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(policy, "version: [", Encoding.UTF8);
        f.Manager.Authorization.Invalidate();
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() => ListData(f));
    }
}
