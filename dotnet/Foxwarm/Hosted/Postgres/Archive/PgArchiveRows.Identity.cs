using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres.Archive;

internal static partial class PgArchiveRows
{
    /// <summary>
    /// The identity the committed reservation graph resolves <paramref name="id"/> to. A cycle
    /// or an empty mapping throws <see cref="InvalidDataException"/>, as in file mode.
    /// </summary>
    internal static string Resolve(PgTx tx, string id) =>
        ResolveAsync(tx, id, async: false, CancellationToken.None).GetAwaiter().GetResult();

    internal static async ValueTask<string> ResolveAsync(
        PgTx tx,
        string id,
        bool async,
        CancellationToken token
    )
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (seen.Add(id))
        {
            await using var command = tx.Command(
                "SELECT canonical_session_id FROM session_id_reservations WHERE session_id = $1",
                id
            );
            var value = async
                ? await command.ExecuteScalarAsync(token).ConfigureAwait(false)
                : command.ExecuteScalar();
            if (value is null or DBNull)
                return id;
            var next = (string)value;
            CommittedArchiveIdentity.ValidateIdentity(next);
            if (next == id)
                return id;
            id = next;
        }
        throw new InvalidDataException("Archive committed identity mappings contain a cycle.");
    }

    /// <summary>Historical aliases can be read but never written.</summary>
    internal static async ValueTask RequireWriteIdentityAsync(
        PgTx tx,
        string id,
        bool async,
        CancellationToken token
    )
    {
        if (await ResolveAsync(tx, id, async, token).ConfigureAwait(false) != id)
            throw new InvalidOperationException(
                "Historical Archive aliases are not writable Session bindings."
            );
    }
}
