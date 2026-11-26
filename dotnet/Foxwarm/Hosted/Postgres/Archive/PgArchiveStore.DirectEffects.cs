using Foxwarm.Sessions;
using Npgsql;

namespace Foxwarm.Hosted.Postgres.Archive;

// Direct effect records: the only record of effects that never reach a Session Archive. The
// derived activity index over Session tool rows isn't kept in hosted P1.
internal sealed partial class PgArchiveStore
{
    private const string DirectColumns =
        "session_id, agent, started_at, duration_ms, origin, tool, source, server, node, action, outcome, error_type,"
        + " approval, approver, rules, summary, input_seq, initiator_kind, initiator_id, initiator_from, run_id, refs";

    public Task RecordDirectEffectAsync(ToolEffectRow row, CancellationToken token = default) =>
        database.WriteAsync(
            async (tx, cancel) =>
            {
                await using var command = tx.Command(
                    $"INSERT INTO archive_direct_effects ({DirectColumns}) VALUES"
                        + " ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)",
                    row.SessionId,
                    row.Agent,
                    row.StartedAt,
                    new NpgsqlParameter<double?> { TypedValue = row.DurationMs },
                    row.Origin,
                    row.Tool,
                    row.Source,
                    row.Server,
                    row.Node,
                    row.Action,
                    row.Outcome,
                    row.ErrorType,
                    row.Approval,
                    row.Approver,
                    row.Rules,
                    row.Summary,
                    new NpgsqlParameter<long?> { TypedValue = row.InputSeq },
                    row.InitiatorKind,
                    row.InitiatorId,
                    row.InitiatorFrom,
                    row.RunId,
                    row.Refs
                );
                // A lost COMMIT surfaces as CommitOutcomeUnknownException; the caller only logs.
                return await command.ExecuteNonQueryAsync(cancel).ConfigureAwait(false);
            },
            token: token
        );

    static partial void RenameDirectEffects(PgTx tx, string fromId, string toId) =>
        tx.Execute("UPDATE archive_direct_effects SET session_id = $2 WHERE session_id = $1", fromId, toId);

    /// <summary>Direct records after <paramref name="afterId"/> in insertion order, for import checks and tests.</summary>
    internal IReadOnlyList<(long Id, ToolEffectRow Row)> ReadDirectEffects(long afterId = 0, int limit = 1000) =>
        database.Read(tx =>
        {
            using var command = tx.Command(
                $"SELECT id, {DirectColumns} FROM archive_direct_effects WHERE id > $1 ORDER BY id LIMIT $2",
                afterId,
                (long)limit
            );
            using var reader = command.ExecuteReader();
            var rows = new List<(long, ToolEffectRow)>();
            string? Text(int column) => reader.IsDBNull(column) ? null : reader.GetString(column);
            while (reader.Read())
                rows.Add(
                    (
                        reader.GetInt64(0),
                        new ToolEffectRow(
                            Text(1),
                            0,
                            0,
                            0,
                            Text(2),
                            reader.GetInt64(3),
                            reader.IsDBNull(4) ? null : reader.GetDouble(4),
                            reader.GetString(5),
                            reader.GetString(6),
                            Text(7),
                            Text(8),
                            Text(9),
                            Text(10),
                            reader.GetString(11),
                            Text(12),
                            Text(13),
                            Text(14),
                            Text(15),
                            Text(16),
                            reader.IsDBNull(17) ? null : reader.GetInt64(17),
                            Text(18),
                            Text(19),
                            Text(20),
                            Text(21),
                            Text(22)
                        )
                    )
                );
            return rows;
        });
}
