using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    private static async Task<ExternalChannelFixture> ListFixture()
    {
        var f = await Fixture();
        var definitions = WorkspaceTools.Definitions();
        foreach (
            var item in AgentToolDefinitions
                .Definitions()
                .Concat(KnowledgeToolDefinitions.Definitions())
                .Concat(ObservationToolDefinitions.Definitions())
                .Concat(MainLocalToolDefinitions.Definitions().OfType<JsonObject>())
                .Concat(UnifiedToolDefinitions.All().OfType<JsonObject>())
        )
            definitions.Add(
                HandoffConfirmation.Definition(item, f.Manager.HandoffConfirmationEnabled)
            );
        f.Registry = SessionToolExecutor.CreateRegistry(
            definitions,
            f.Manager.OutboundMcp,
            owner => f.Manager.IdentityWorkspace(owner).ToolDirectory,
            f.Manager.Nodes,
            f.Manager.NodeProviders
        );
        return f;
    }

    private static Task ListPolicy(ExternalChannelFixture f, string yaml) =>
        f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(yaml), default);

    private static async Task<string> SessionList(
        ExternalChannelFixture f,
        SessionOwner? caller = null,
        string scope = "all",
        JsonObject? extra = null
    )
    {
        var args = extra?.DeepClone().AsObject() ?? new JsonObject();
        args["action"] = "list";
        args["scope"] = scope;
        args["count"] ??= 100;
        var result = await f.ToolAsync("session", args, caller);
        Successful(result);
        return SessionWait.Text(result!["output"])!;
    }

    private static string[] ListedSessions(string output) =>
        Regex
            .Matches(output, "🤖 `([^`]+)`")
            .Select(match => match.Groups[1].Value)
            .Order(StringComparer.Ordinal)
            .ToArray();

    private static string[] Sorted(params string[] ids) =>
        ids.Order(StringComparer.Ordinal).ToArray();

    // The caller `main/source` with synthetic catalog Sessions around it.
    private static void SeedSessions(ExternalChannelFixture f)
    {
        var source = f.Owner.Id;
        f.Manager.Catalog.Upsert([
            SessionCatalogTests.Row("main/peer1", 6),
            SessionCatalogTests.Row("main/peer2", 5),
            SessionCatalogTests.Row("main/peer3", 4),
            SessionCatalogTests.Row("main/kid2", 3, parent: source),
            SessionCatalogTests.Row("ops/a", 2, agent: "ops"),
            SessionCatalogTests.Row("ops/b", 1, agent: "ops"),
            SessionCatalogTests.Row("ops/kid", 7, parent: source, agent: "ops"),
            SessionCatalogTests.Row("ops/renamed", 8, agent: "ops", aliases: ["ops/old-name"]),
        ]);
    }

    [Fact]
    public async Task Session_list_shows_self_and_addressable_Sessions_filtered_before_scope_query_and_paging()
    {
        await using var f = await ListFixture();
        SeedSessions(f);
        var source = f.Owner.Id;
        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: session, args: {action: list}, action: allow}
            - {tool: {source: builtin, name: send_to_session}, args: {sessionId: {session: {relation: child}}}, action: allow}
            - {tool: view_session, args: {sessionId: ops/b}, action: allow}
            """
        );
        var all = await SessionList(f);
        Assert.Equal(Sorted(source, "ops/kid", "main/kid2", "ops/b"), ListedSessions(all));
        Assert.Contains("Found 4 session(s). Showing 1-4.", all);
        Assert.Equal(
            Sorted(source, "main/kid2"),
            ListedSessions(await SessionList(f, scope: "current-agent"))
        );

        var page = await SessionList(f, extra: new JsonObject { ["start"] = 1, ["count"] = 2 });
        Assert.Contains(
            "Found 4 session(s). Showing 2-3. Use `start: 3` to see the next page.",
            page
        );
        Assert.Equal(2, ListedSessions(page).Length);
        Assert.Contains(
            "No sessions found in the requested range. Total sessions: 4.",
            await SessionList(f, extra: new JsonObject { ["start"] = 9 })
        );

        // Keyword search matches listed Sessions only, and its totals count only them.
        var query = await SessionList(f, extra: new JsonObject { ["query"] = "ops" });
        Assert.Contains("Found 2 session(s) matching `ops`.", query);
        Assert.Equal(Sorted("ops/b", "ops/kid"), ListedSessions(query));
    }

    [Fact]
    public async Task Wholesale_session_grants_list_everything_while_self_oriented_and_management_grants_do_not()
    {
        await using var f = await ListFixture();
        SeedSessions(f);
        var source = f.Owner.Id;
        var unfiltered = await SessionList(f);
        var everyone = ListedSessions(unfiltered);
        Assert.Equal(9, everyone.Length);

        // Status of every Session is allowed, so every Session is listed: the indexed page
        // produces exactly the unfiltered output.
        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: session, action: allow}
            """
        );
        Assert.Equal(unfiltered, await SessionList(f));

        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: {source: builtin, name: session}, args: {sessionId: {session: {sameAgent: true}}}, action: allow}
            """
        );
        Assert.Equal(
            Sorted(source, "main/peer1", "main/peer2", "main/peer3", "main/kid2"),
            ListedSessions(await SessionList(f))
        );
        Assert.Equal(
            ListedSessions(await SessionList(f)),
            ListedSessions(await SessionList(f, scope: "current-agent"))
        );

        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: session, args: {action: [list, update-parent]}, action: allow}
            - tool: [send_file, create_timer, list_timers, update_timer, delete_timer, compact_session, refresh_session_snapshot, set_session_child_model, set_session_compact_threshold, delete_session, move_session, wait]
              action: allow
            - {tool: task, args: {action: [get, update, complete, list]}, action: allow}
            """
        );
        Assert.Equal([source], ListedSessions(await SessionList(f)));
    }

    [Fact]
    public async Task Session_list_treats_ask_and_conditional_rules_as_possible_matches_literals_and_applies_Agent_layers()
    {
        await using var f = await ListFixture();
        SeedSessions(f);
        var source = f.Owner.Id;
        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: [session, list_agents], args: {action: list}, action: allow}
            - {tool: view_session, args: {sessionId: main/peer1}, action: ask}
            - {tool: view_session, args: {sessionId: main/peer2, parts: [user]}, action: deny}
            - {tool: view_session, args: {sessionId: main/peer3}, action: deny}
            - {tool: {source: builtin, name: view_session}, args: {sessionId: {session: {sameAgent: true}}}, action: allow}
            - {tool: stop_session, args: {sessionId: ops/old-name}, action: allow}
            """
        );
        Assert.Equal(
            Sorted(source, "main/peer1", "main/peer2", "main/kid2", "ops/renamed"),
            ListedSessions(await SessionList(f))
        );

        // An Agent-local layer must also leave a probe possible; `<parent>` is a send spelling.
        await ListPolicy(f, "version: 1\ndefaultAction: allow\n");
        await f.Manager.CreateAgentAsync("ops", createMainSession: false);
        var worker = await ChildAgent(
            f,
            "worker",
            rules: Rules(
                """
                [
                  {"tool": {"source": "builtin", "name": "session"}, "args": {"action": "list"}, "action": "allow"},
                  {"tool": {"source": "builtin", "name": "list_agents"}, "action": "allow"},
                  {"tool": {"source": "builtin", "name": "send_to_session"}, "args": {"sessionId": "<parent>"}, "action": "allow"},
                  {"action": "deny"}
                ]
                """
            )
        );
        f.Manager.ChangePresentation(catalog => catalog.SetParent(worker.Id, source));
        Assert.Equal(Sorted(worker.Id, source), ListedSessions(await SessionList(f, worker)));
        var agents = SessionWait.Text(
            (await f.ToolAsync("list_agents", new(), worker))!["output"]
        )!;
        Assert.Contains("Found 2 agent(s):", agents);
        Assert.Contains("- **main** (1 session)", agents);
        Assert.Contains("- **worker** (1 session)", agents);
        Assert.DoesNotContain("**ops**", agents);
    }

    [Fact]
    public async Task Agent_list_admits_owned_listed_Sessions_and_targeted_actions_within_creator_limits()
    {
        await using var f = await ListFixture();
        SeedSessions(f);
        await f.Manager.CreateAgentAsync("ops", createMainSession: false);
        await f.Manager.CreateAgentAsync("spare", createMainSession: false);
        var child = await ChildAgent(f, "child");
        async Task<string> Agents(SessionOwner? caller = null) =>
            SessionWait.Text((await f.ToolAsync("list_agents", new(), caller))!["output"])!;
        string[] Names(string output) =>
            Regex
                .Matches(output, @"^- \*\*([^*]+)\*\*", RegexOptions.Multiline)
                .Select(match => match.Groups[1].Value)
                .Order(StringComparer.Ordinal)
                .ToArray();

        var unrestricted = await Agents();
        Assert.Equal(Sorted("child", "main", "ops", "spare"), Names(unrestricted));
        var mainTotal = f.Manager.AgentListEntries().Single(row => row.Id == "main").SessionCount;
        Assert.True(mainTotal > 1);
        Assert.Contains($"- **main** ({mainTotal} sessions)", unrestricted);

        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: list_agents, action: allow}
            - {tool: create_session, args: {agentName: spare}, action: allow}
            - {tool: view_session, args: {sessionId: ops/b}, action: allow}
            """
        );
        var listed = await Agents();
        Assert.Equal(Sorted("main", "ops", "spare"), Names(listed));
        // Counts show listed Sessions only, with no hidden count.
        Assert.Contains("- **main** (1 session)", listed);
        Assert.Contains("- **ops** (1 session)", listed);
        Assert.Contains("Found 3 agent(s):", listed);

        // Rule replacement is limited to strict creator descendants.
        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: [list_agents, set_agent_rules], action: allow}
            """
        );
        Assert.Equal(Sorted("child", "main"), Names(await Agents()));

        // A delegated Agent may create Sessions only in itself or its descendants.
        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: [list_agents, create_session], action: allow}
            """
        );
        Assert.Equal(["child"], Names(await Agents(child)));
        Assert.Equal(Sorted("child", "main", "ops", "spare"), Names(await Agents()));
    }

    [Fact]
    public async Task Status_children_use_the_same_filter_except_on_the_administrator_status()
    {
        await using var f = await ListFixture();
        SeedSessions(f);
        await ListPolicy(
            f,
            """
            version: 1
            defaultAction: deny
            rules:
            - {tool: {source: builtin, name: session}, args: {sessionId: {session: {self: true}}}, action: allow}
            - {tool: view_session, args: {sessionId: ops/kid}, action: allow}
            """
        );
        var status = await f.ToolAsync("session", new JsonObject());
        Successful(status);
        var text = SessionWait.Text(status!["output"])!;
        Assert.Contains("`ops/kid`", text);
        Assert.DoesNotContain("`main/kid2`", text);
        var administrator = SessionWait.Text(
            (await f.Manager.ObserveAsync(f.Owner, "session", new(), administrator: true))["output"]
        )!;
        Assert.Contains("`ops/kid`", administrator);
        Assert.Contains("`main/kid2`", administrator);
    }

    [Fact]
    public async Task Session_and_Agent_lists_fail_when_policy_is_unavailable()
    {
        await using var f = await ListFixture();
        await ListPolicy(f, "version: 1\ndefaultAction: allow\n");
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: [",
            Encoding.UTF8
        );
        f.Manager.Authorization.Invalidate();
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
            f.Manager.ObserveAsync(f.Owner, "session", new JsonObject { ["action"] = "list" })
        );
        Assert.Throws<ToolAuthorizationUnavailableException>(() =>
            f.Manager.ListAgentsText(f.Owner)
        );
    }
}
