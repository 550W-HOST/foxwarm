using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Foxwarm.Tests.Hosted;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

/// <summary>
/// Inspection and crash-state setup for the identity move tests through the storage context of
/// a data root, so the same tests run on the file stores and, with
/// <c>FOXWARM_TEST_BACKEND=postgres</c>, on the hosted ones.
/// </summary>
internal static class IdentityTestStorage
{
    /// <summary>The context a <see cref="SessionManager"/> on <paramref name="data"/> uses.</summary>
    internal static IStorageContext Open(string data) =>
        SessionManager.StorageForTests?.Invoke(data) ?? new FileStorageContext(data);

    /// <summary>Whether a move intent is stored; an intent that fails validation is still stored.</summary>
    internal static bool PendingMove(string data)
    {
        try
        {
            return Open(data).Identities.ReadPendingMove() is not null;
        }
        catch (InvalidDataException)
        {
            return true;
        }
    }

    internal static IArchiveSession Archive(string data, string id) => Open(data).Archive.ForSession(id);

    internal static bool AuthorityExists(string data, string id) => Open(data).Authority.Exists(id);

    /// <summary>
    /// The stored authority as text: the file's bytes in file mode, the stored document
    /// otherwise.
    /// </summary>
    internal static async Task<string?> AuthorityText(string data, string id)
    {
        var storage = Open(data);
        if (storage.Authority is FileSessionAuthorityBackend)
        {
            var path = new SessionIdentityMoveJournal(data).AuthorityPath(id);
            return File.Exists(path) ? await File.ReadAllTextAsync(path) : null;
        }
        return (await storage.Authority.ReadRawAsync(id))?.Document?.ToJsonString();
    }

    internal static async Task<JsonObject> RawAuthority(string data, string id) =>
        (await Open(data).Authority.ReadRawAsync(id))!.Document!.AsObject();

    /// <summary>The partial effects an interrupted move leaves before its intent turns to finishing.</summary>
    internal static void MoveStoredIdentity(string data, string from, string to, int version = 2)
    {
        var storage = Open(data);
        storage.Identities.MoveArtifacts(from, to, version, storage.Authority.MoveIdentity);
        storage.Archive.RenameIdentity(from, to);
    }

    /// <summary>Makes the reverse Archive rename of a branch from <c>new</c> to <c>old</c> fail.</summary>
    internal static async Task FailReverseBranchRename(string data, bool enabled)
    {
        if (Open(data).Archive is not SqliteArchiveStore && HostedTestBackend.Database(data) is { } database)
        {
            await database.ExecuteOwnerAsync(
                enabled
                    ? "CREATE FUNCTION fail_reverse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Reverse fault'; END $$;"
                        + " CREATE TRIGGER fail_reverse BEFORE UPDATE OF session_id ON archive_branches FOR EACH ROW"
                        + " WHEN (OLD.session_id = 'new' AND NEW.session_id = 'old') EXECUTE FUNCTION fail_reverse()"
                    : "DROP TRIGGER fail_reverse ON archive_branches; DROP FUNCTION fail_reverse()"
            );
            return;
        }
        using var db = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(data, "state", "archive-store.sqlite"),
                Mode = SqliteOpenMode.ReadWrite,
                Pooling = false,
            }.ToString()
        );
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = enabled
            ? "CREATE TRIGGER fail_reverse BEFORE UPDATE OF session_id ON archive_branches WHEN OLD.session_id='new' AND NEW.session_id='old' BEGIN SELECT RAISE(ABORT,'Reverse fault'); END"
            : "DROP TRIGGER fail_reverse";
        command.ExecuteNonQuery();
    }
}
