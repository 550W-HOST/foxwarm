using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed record SessionCatalogInspectionRow(JsonObject Main, JsonObject? Legacy = null);

internal sealed partial class SessionCatalog
{
    // Uses the same ordered source candidates and projection parser as initialization,
    // but never opens the writer or stages an authority/catalog migration.
    internal IReadOnlyList<SessionCatalogInspectionRow> ReadForInspection()
    {
        if (Path.Exists(FilePath))
        {
            using var connection = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = FilePath,
                    Mode = SqliteOpenMode.ReadOnly,
                    Pooling = false,
                }.ToString()
            );
            connection.Open();
            var version = Convert.ToInt32(Scalar(connection, "PRAGMA user_version"));
            if (version is not (1 or 2 or 3))
                throw new InvalidDataException("Unsupported Session catalog schema version.");
            return Rows(
                    connection,
                    $"SELECT {Columns} FROM session_catalog ORDER BY recent_rank,session_id"
                )
                .Select(row => new SessionCatalogInspectionRow(row))
                .ToArray();
        }
        var seen = false;
        foreach (var source in Candidates())
        {
            if (!File.Exists(source))
                continue;
            seen = true;
            try
            {
                var result = new List<SessionCatalogInspectionRow>();
                foreach (var (id, node) in ReadCandidate(source))
                {
                    var row =
                        node as JsonObject
                        ?? throw new InvalidDataException("Catalog row must be an object.");
                    var main = ProjectCandidate(id, row);
                    result.Add(new(main, row));
                }
                return result;
            }
            catch (Exception error) when (error is JsonException or InvalidDataException)
            {
                // Only a structurally invalid source candidate selects the next backup.
            }
        }
        if (seen || AuthorityFiles().Length > 0 || HasArchiveHistory())
            throw new InvalidDataException("No valid source Session catalog migration candidate.");
        return [];
    }

    private static JsonObject ProjectCandidate(string id, JsonObject row)
    {
        var main = Project(row);
        if (!SessionIdentity.IsValid(id))
            throw new SelectedAuthorityFailure(
                "Cataloged Session identity is not supported by this host."
            );
        if (Text(main["id"]) != id)
            throw new InvalidDataException("Catalog key does not match row ID.");
        return main;
    }

    internal static string? ResolveInspection(IReadOnlyList<JsonObject> rows, string requested)
    {
        if (rows.Any(row => Text(row["id"]) == requested))
            return requested;
        var matches = rows.Where(row =>
                SessionWait.Strings(row["aliases"]).Contains(requested, StringComparer.Ordinal)
            )
            .Select(row => Text(row["id"])!)
            .Take(2)
            .ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }
}
