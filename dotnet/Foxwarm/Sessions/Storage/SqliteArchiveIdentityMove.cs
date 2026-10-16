using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal static class SqliteArchiveIdentityMove
{
    internal static void Rename(string path, string from, string to)
    {
        if (!File.Exists(path))
            return;
        var receipt = SqliteArchiveMessageStore
            .EnqueueWriteAsync(
                path,
                (db, transaction) =>
                {
                    void Execute(string sql)
                    {
                        using var command = db.CreateCommand();
                        command.Transaction = transaction;
                        command.CommandText = sql;
                        command.Parameters.AddWithValue("$from", from);
                        command.Parameters.AddWithValue("$to", to);
                        command.ExecuteNonQuery();
                    }
                    bool Has(string table)
                    {
                        using var command = db.CreateCommand();
                        command.Transaction = transaction;
                        command.CommandText =
                            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$name";
                        command.Parameters.AddWithValue("$name", table);
                        return command.ExecuteScalar() is not null;
                    }
                    foreach (
                        var table in new[]
                        {
                            "archive_messages",
                            "archive_blocks",
                            "archive_branches",
                            "archive_checkpoints",
                            "archive_import_state",
                        }
                    )
                        if (Has(table))
                            Execute(
                                $"UPDATE {table} SET session_id=$to"
                                    + (
                                        table is "archive_branches" or "archive_import_state"
                                            ? ", updated_at="
                                                + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                                            : ""
                                    )
                                    + " WHERE session_id=$from"
                            );
                    if (Has("archive_branches"))
                        Execute(
                            "UPDATE archive_branches SET parent_session_id=$to WHERE parent_session_id=$from"
                        );
                    // Reservation edges are independent committed identity authority, not mutable audit ownership.
                    return true;
                }
            )
            .AsTask()
            .GetAwaiter()
            .GetResult();
        receipt.Completion.GetAwaiter().GetResult();
    }
}
