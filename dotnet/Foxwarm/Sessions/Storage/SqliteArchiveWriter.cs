using Foxwarm.Persistence;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

public sealed partial class SqliteArchiveMessageStore
{
    internal static SqliteWriterOwners.Lease AcquireWriter(string path) =>
        SqliteWriterOwners.Acquire(path, () =>
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = path, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false, DefaultTimeout = 5,
            }.ToString());
            try
            {
                connection.Open();
                InitializeSchema(connection);
                return connection;
            }
            catch { connection.Dispose(); throw; }
        });

    internal static async ValueTask<WriteReceipt<T>> EnqueueWriteAsync<T>(
        string path,
        Func<SqliteConnection, SqliteTransaction, T> execute,
        CancellationToken token = default)
    {
        var lease = AcquireWriter(path);
        try
        {
            var receipt = await lease.Writer.EnqueueAsync(execute, token).ConfigureAwait(false);
            return new(CompleteAndReleaseAsync(receipt.Completion, lease));
        }
        catch
        {
            await lease.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static async Task<T> CompleteAndReleaseAsync<T>(Task<T> completion, SqliteWriterOwners.Lease lease)
    {
        try { return await completion.ConfigureAwait(false); }
        finally { await lease.DisposeAsync().ConfigureAwait(false); }
    }

    private T Write<T>(Func<SqliteConnection, SqliteTransaction, T> execute) =>
        EnqueueWriteAsync(databasePath, execute).AsTask().GetAwaiter().GetResult().Completion.GetAwaiter().GetResult();

    internal static void OrderedMaintenance(string path, Action<SqliteConnection> execute)
    {
        using var lease = AcquireWriter(path);
        var receipt = lease.Writer.ExclusiveAsync(connection =>
        {
            execute(connection);
            return Task.FromResult(true);
        }).AsTask().GetAwaiter().GetResult();
        receipt.Completion.GetAwaiter().GetResult();
    }
}
