using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed record SessionUpgradeIssue(bool Blocking, string Category, string Detail);

internal sealed record SessionUpgradeReport(
    int Sessions,
    int HistoricalCursors,
    IReadOnlyList<SessionUpgradeIssue> Issues
)
{
    internal bool CanSelect => !Issues.Any(issue => issue.Blocking);
}

// One-shot inspection before source output selection. This never composes Main,
// opens a writer, migrates state, externalizes images or activates an owner.
internal static class SessionUpgradeInspection
{
    internal static SessionUpgradeReport Inspect(HostPaths paths)
    {
        var issues = new List<SessionUpgradeIssue>();
        var cursors = new Dictionary<string, long>(StringComparer.Ordinal);
        IReadOnlyList<SessionCatalogInspectionRow> entries = [];
        AgentCatalog? agents = null;
        void Global(string category, Action action)
        {
            try
            {
                action();
            }
            catch (Exception error)
                when (error
                        is IOException
                            or InvalidDataException
                            or UnauthorizedAccessException
                            or JsonException
                            or SqliteException
                            or InvalidOperationException
                            or FormatException
                )
            {
                issues.Add(new(true, category, MainLog.SafeFailure(error)));
            }
        }
        Global(
            "startup evidence",
            () => CommittedArchiveIdentity.ValidateStartupEvidence(paths.DataRoot)
        );
        Global(
            "Agent bindings",
            () =>
                agents = new AgentCatalog(
                    paths.DataRoot,
                    paths.AgentsRoot,
                    canonicalLayout: true,
                    createDirectories: false
                )
        );
        using var catalog = new SessionCatalog(paths.DataRoot);
        Global("Catalog", () => entries = catalog.ReadForInspection());
        var rows = entries.Select(entry => entry.Main).ToArray();
        Global(
            "Archive schema",
            () =>
                SqliteArchiveMessageStore.InspectSchema(
                    Path.Combine(paths.DataRoot, "state", "archive-store.sqlite")
                )
        );
        Global(
            "Archive identity",
            () =>
                new CommittedArchiveIdentity(paths.DataRoot).Inspect(
                    rows,
                    requested => SessionCatalog.ResolveInspection(rows, requested)
                )
        );
        foreach (var entry in entries)
        {
            var id = SessionCatalog.Text(entry.Main["id"]);
            var agent = SessionCatalog.Text(entry.Main["agent"]);
            if (
                !SessionIdentity.IsValid(id)
                || agent is null
                || agents is null
                || !agents.Exists(agent)
            )
            {
                issues.Add(
                    new(
                        true,
                        "Catalog binding",
                        "Catalog Session binding is unsupported or its Agent is missing."
                    )
                );
                continue;
            }
            try
            {
                var normalized = SessionAuthorityReader.Read(
                    paths.DataRoot,
                    id!,
                    agent,
                    entry.Legacy,
                    entry.Main
                );
                cursors[id!] = checked(
                    (long)SessionWait.Number(normalized["lastAppliedMailboxId"])!.Value
                );
            }
            catch (SessionAuthorityUnavailableException error)
            {
                issues.Add(new(false, "Session unavailable", MainLog.SafeFailure(error)));
            }
            catch (SessionAuthorityIdentityException error)
            {
                issues.Add(new(true, "Session identity", MainLog.SafeFailure(error)));
            }
        }
        Global("legacy Worker evidence", () => InspectWorkers(paths.DataRoot, cursors, issues));
        return new(entries.Count, cursors.Values.Count(value => value != 0), issues);
    }

    internal static int Run(string? applicationRoot)
    {
        try
        {
            var configuration = new Foxwarm.Models.ModelConfiguration(
                HostPaths.Capture(applicationRoot)
            );
            var report = Inspect(configuration.Paths);
            foreach (var issue in report.Issues)
                Console.Error.WriteLine(
                    $"Upgrade {(issue.Blocking ? "blocked" : "warning")}: {issue.Category}: {issue.Detail}"
                );
            Console.Error.WriteLine(
                $"Upgrade inspection: sessions={report.Sessions}, historicalWorkerCursors={report.HistoricalCursors}, warnings={report.Issues.Count(issue => !issue.Blocking)}, blockers={report.Issues.Count(issue => issue.Blocking)}."
            );
            return report.CanSelect ? 0 : 1;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Upgrade inspection failed: " + MainLog.SafeFailure(error));
            return 1;
        }
    }

    private static void InspectWorkers(
        string root,
        IReadOnlyDictionary<string, long> cursors,
        List<SessionUpgradeIssue> issues
    )
    {
        var path = Path.Combine(root, "state", "session-runtime.sqlite");
        if (!Path.Exists(path))
            return;
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA user_version";
        var version = Convert.ToInt32(command.ExecuteScalar());
        if (version is < 0 or > 2)
            throw new InvalidDataException("Unsupported legacy Worker schema version.");
        command.CommandText =
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('session_worker_ownership','session_worker_mailbox')";
        var tables = Convert.ToInt32(command.ExecuteScalar());
        if (version == 0 && tables == 0)
            return;
        if (tables != 2)
            throw new InvalidDataException("Legacy Worker evidence is incomplete.");
        command.CommandText =
            "SELECT session_id,state FROM session_worker_ownership ORDER BY session_id";
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                var id = reader.GetString(0);
                var state = reader.GetString(1);
                if (state is not ("inactive" or "candidate" or "ready" or "draining"))
                    throw new InvalidDataException("Unsupported legacy Worker ownership state.");
                if (state != "inactive")
                    issues.Add(
                        new(
                            true,
                            "active Worker",
                            $"session={JsonSerializer.Serialize(id)} state={state}; retained ownership must finish its existing handback before selecting this runtime."
                        )
                    );
            }
        }
        var applied = version == 2 ? "applied_at" : "applied_revision";
        command.CommandText =
            $"SELECT id,session_id,kind,created_at,{applied} FROM session_worker_mailbox ORDER BY session_id,id";
        using var mailbox = command.ExecuteReader();
        while (mailbox.Read())
        {
            var id = mailbox.GetInt64(0);
            var session = mailbox.GetString(1);
            var known = cursors.TryGetValue(session, out var cursor);
            var unacknowledged = mailbox.IsDBNull(4);
            if (known && id <= cursor && !unacknowledged)
                continue;
            // Only the established producer kind is displayed; never print payloads,
            // intent IDs, process identities or arbitrary strings from retained state.
            var kind = mailbox.GetString(2) == "enqueue" ? "enqueue" : "unsupported";
            var created = mailbox.GetInt64(3);
            var disposition =
                !known ? "authority cursor unavailable"
                : id > cursor ? "beyond authority cursor"
                : "authority applied, acknowledgement missing";
            issues.Add(
                new(
                    false,
                    "retained mailbox",
                    $"session={JsonSerializer.Serialize(session)} mailboxId={id} createdAt={created} kind={kind}; {disposition}. Record retained; this runtime does not replay legacy mailbox input."
                )
            );
        }
    }
}
