using System.Data;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.ToolScript;
using Npgsql;
using NpgsqlTypes;

namespace Foxwarm.Hosted.Postgres;

internal sealed class PgToolScriptRunStore(TenantDb database, string scratchRoot) : IToolScriptRunStore
{
    private readonly ToolScriptRunLanes lanes = new();

    public Task<IDisposable> AcquireAsync(string id, CancellationToken token) =>
        lanes.AcquireAsync(id, token);

    public bool Exists(string id)
    {
        ToolScriptRunLanes.ValidateId(id);
        return database.Read(tx => tx.Scalar("SELECT 1 FROM toolscript_runs WHERE run_id = $1", id) is not null);
    }

    public Task<JsonObject?> ReadAsync(string id, CancellationToken token)
    {
        ToolScriptRunLanes.ValidateId(id);
        return database.ReadAsync<JsonObject?>(
            async (tx, cancel) =>
            {
                await using var command = tx.Command(
                    "SELECT octet_length(record), record FROM toolscript_runs WHERE run_id = $1",
                    id
                );
                await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancel);
                return await rows.ReadAsync(cancel)
                    ? await ReadRecordAsync(rows, new ToolScriptDataBudget(), cancel)
                    : null;
            },
            token: token
        );
    }

    public Task<IReadOnlyList<JsonObject>> ListAsync(string owner, int limit, string? status, CancellationToken token) =>
        database.ReadAsync<IReadOnlyList<JsonObject>>(
            async (tx, cancel) =>
            {
                var records = new List<JsonObject>();
                var offset = 0;
                while (records.Count < limit)
                {
                    var take = limit - records.Count;
                    await using var command = tx.Command(
                        """
                        SELECT octet_length(record), record FROM toolscript_runs
                        WHERE owner = $1 AND ($2::text IS NULL OR status = $2)
                        ORDER BY updated_at DESC NULLS LAST, run_id ASC NULLS FIRST
                        LIMIT $3 OFFSET $4
                        """,
                        owner, status, take, offset
                    );
                    await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancel);
                    var seen = 0;
                    while (await rows.ReadAsync(cancel))
                    {
                        seen++;
                        var budget = new ToolScriptDataBudget();
                        foreach (var retained in records)
                            budget.JsonValue(retained);
                        try
                        {
                            records.Add(await ReadRecordAsync(rows, budget, cancel));
                        }
                        catch (Exception error) when (error is JsonException or InvalidDataException) { }
                    }
                    // A further page is needed only when unreadable rows occupied part of this one.
                    if (seen < take)
                        break;
                    offset += seen;
                }
                return records;
            },
            snapshot: true,
            token: token
        );

    public async Task WriteAsync(JsonObject record, CancellationToken token, ToolScriptDataBudget? activity = null)
    {
        var id = record["runId"]?.GetValue<string>()
            ?? throw new InvalidDataException("ToolScript record requires runId.");
        ToolScriptRunLanes.ValidateId(id);
        token.ThrowIfCancellationRequested();
        var budget = activity ?? new ToolScriptDataBudget();
        budget.JsonValue(record);
        budget.Charge(ToolScriptRecordJson.ScratchReservation);
        var owner = Text(record, "ownerSessionId");
        var status = Text(record, "status");
        var updatedAt = MainToolScript.Number(record["updatedAt"], 0);

        // bytea parameters require the length before writing. Stage the bounded JSON to
        // ephemeral storage so we do not allocate a second whole-record byte buffer.
        Directory.CreateDirectory(scratchRoot);
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.ReadWrite,
            Share = FileShare.None,
            BufferSize = 65536,
            Options = OperatingSystem.IsWindows()
                ? FileOptions.Asynchronous | FileOptions.DeleteOnClose
                : FileOptions.Asynchronous,
        };
        if (!OperatingSystem.IsWindows())
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        var path = Path.Combine(scratchRoot, "toolscript-" + Guid.NewGuid().ToString("N"));
        await using var payload = new FileStream(path, options);
        if (!OperatingSystem.IsWindows())
            File.Delete(path); // The open file has no name, even if the process exits during the write.
        ToolScriptRecordJson.Write(payload, record, budget);
        payload.Position = 0;
        await database.WriteAsync(
            (tx, cancel) => tx.ExecuteAsync(
                """
                INSERT INTO toolscript_runs (run_id, owner, status, updated_at, record)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (tenant_id, run_id) DO UPDATE SET owner = excluded.owner,
                    status = excluded.status, updated_at = excluded.updated_at, record = excluded.record
                """,
                cancel, id, owner, status, updatedAt, Bytea(payload)
            ),
            new PgWriteOptions(Verify: tx =>
            {
                payload.Position = 0;
                return tx.Scalar(
                    "SELECT 1 FROM toolscript_runs WHERE run_id = $1 AND record = $2",
                    id, Bytea(payload)
                ) is not null;
            }),
            token
        );
    }

    private static async Task<JsonObject> ReadRecordAsync(
        NpgsqlDataReader row,
        ToolScriptDataBudget budget,
        CancellationToken token
    )
    {
        var length = row.GetInt32(0);
        await using var payload = await row.GetStreamAsync(1, token);
        return await budget.ReadRecordAsync(payload, length, token);
    }

    private static NpgsqlParameter Bytea(Stream payload) => new() { NpgsqlDbType = NpgsqlDbType.Bytea, Value = payload };

    private static string? Text(JsonObject record, string key) =>
        record[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
