using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

public sealed class SessionListVisibilityScaleTests(ITestOutputHelper output)
{
    private const int Sessions = 4000;

    [Fact]
    public async Task Class_memo_matches_per_row_evaluation_on_a_large_catalog_with_probes_bounded_by_classes()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        var source = f.Owner.Id;
        var rows = new List<JsonObject>();
        for (var index = 0; index < Sessions; index++)
        {
            var agent = index % 5 == 0 ? "main" : "team" + index % 40;
            var parent =
                index % 7 == 0 ? source
                : index % 11 == 0 ? "team" + (index - 1) % 40 + "/s" + (index - 1)
                : null;
            rows.Add(
                SessionCatalogTests.Row(
                    agent + "/s" + index,
                    index,
                    parent,
                    agent,
                    index % 13 == 0 ? ["alias-" + index] : null
                )
            );
        }
        f.Manager.Catalog.Upsert(rows);
        f.Manager.ChangePresentation(catalog => catalog.SetParent(source, "team1/s1"));

        var policies = new Dictionary<string, string>
        {
            ["unrestricted"] = "version: 1\ndefaultAction: allow\n",
            ["mixed"] = """
                version: 1
                defaultAction: deny
                rules:
                - {tool: session, args: {action: list}, action: allow}
                - {tool: view_session, args: {sessionId: main/s5}, action: deny}
                - {tool: {source: builtin, name: view_session}, args: {sessionId: {session: {sameAgent: true}}}, action: allow}
                - {tool: {source: builtin, name: send_to_session}, args: {sessionId: {session: {relation: child}}}, action: ask}
                - {tool: stop_session, args: {sessionId: [team3/s3, alias-13, alias-26]}, action: allow}
                - {tool: {source: builtin, name: task}, args: {action: create, ownerSessionId: {session: {relation: parent}}}, action: allow}
                """,
            ["restricted"] = """
                version: 1
                defaultAction: deny
                rules:
                - {tool: session, args: {action: list}, action: allow}
                - {tool: {source: builtin, name: recall}, args: {sessionId: {session: {self: true}}}, action: allow}
                - {tool: send_to_session, args: {sessionId: "<parent>"}, action: allow}
                """,
        };
        var presentations = f.Manager.ListPresentations();
        Assert.True(presentations.Length > Sessions);
        foreach (var (name, yaml) in policies)
        {
            await f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(yaml), default);
            var memo = f.Manager.SessionVisibilityFor(f.Owner);
            var exact = f.Manager.SessionVisibilityFor(f.Owner, memoize: false);
            var timer = Stopwatch.StartNew();
            var memoIds = presentations
                .Where(memo.Admits)
                .Select(row => SessionWait.Text(row["id"]))
                .ToArray();
            var memoTime = timer.Elapsed;
            timer.Restart();
            var exactIds = presentations
                .Where(exact.Admits)
                .Select(row => SessionWait.Text(row["id"]))
                .ToArray();
            var exactTime = timer.Elapsed;
            Assert.Equal(exactIds, memoIds);
            Assert.InRange(memo.Evaluations, 1, 400);
            Assert.True(exact.Evaluations >= Sessions);

            timer.Restart();
            var list = await f.Manager.ObserveAsync(
                f.Owner,
                "session",
                new JsonObject
                {
                    ["action"] = "list",
                    ["scope"] = "all",
                    ["count"] = 20,
                }
            );
            var listTime = timer.Elapsed;
            // A keyword search scans the scope; it is the pre-existing cost the filter must match.
            timer.Restart();
            _ = await f.Manager.ObserveAsync(
                f.Owner,
                "session",
                new JsonObject
                {
                    ["action"] = "list",
                    ["scope"] = "all",
                    ["query"] = "/s",
                }
            );
            var queryTime = timer.Elapsed;
            var found = System.Text.RegularExpressions.Regex.Match(
                SessionWait.Text(list["output"])!,
                @"Found (\d+) session"
            );
            Assert.Equal(memoIds.Length.ToString(), found.Groups[1].Value);
            output.WriteLine(
                $"{name}: listed {memoIds.Length}/{presentations.Length}; class memo {memo.Evaluations} probes in {memoTime.TotalMilliseconds:F1} ms; per-row {exact.Evaluations} probes in {exactTime.TotalMilliseconds:F1} ms; list call {listTime.TotalMilliseconds:F1} ms; keyword list {queryTime.TotalMilliseconds:F1} ms"
            );
        }
    }
}
